import { api } from '$lib/services/api';

// Sign-in from inside a workspace frame (backend/src/routes/frame-sign-in.ts).
//
// Auth servers refuse to be framed, so sign-in runs in a popup. The popup is
// top-level and the frame is partitioned, so neither the cookie the callback
// would set nor a BroadcastChannel reaches the frame, and the auth server's COOP
// cuts `window.opener` (atlauncher docs/FINDINGS.md §1). Instead the frame keeps
// a random relay secret, sends only its hash with the login request, and polls
// the backend with the secret until the popup's sign-in lands. The claim answers
// with a cookie partitioned to the shell's site.

const POLL_MS = 1500;
// The backend keeps a parked sign-in for 10 minutes; the reader gets 5.
const DEADLINE_MS = 5 * 60 * 1000;

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export type StartAuth = (frameRelayHash: string) => Promise<{ authUrl: string }>;

/**
 * Must be called straight from a click handler: the popup is opened before the
 * first await, while the click still counts as a user gesture.
 */
export async function signInFromFrame(start: StartAuth): Promise<void> {
  const popup = window.open('about:blank', 'skyreader-sign-in', 'popup,width=520,height=720');
  if (!popup) throw new Error('Allow pop-ups for Skyreader to sign in here.');

  try {
    const relay = hex(crypto.getRandomValues(new Uint8Array(32)));
    const relayHash = hex(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(relay)))
    );
    const { authUrl } = await start(relayHash);
    popup.location.href = authUrl;

    // popup.closed can't be trusted: COOP on the auth server makes the handle
    // report closed while the popup is still open. Poll until the deadline.
    const deadline = Date.now() + DEADLINE_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if (await api.claimFrameSignIn(relay)) return;
    }
    throw new Error('Sign-in timed out. Try again.');
  } catch (err) {
    popup.close();
    throw err;
  }
}
