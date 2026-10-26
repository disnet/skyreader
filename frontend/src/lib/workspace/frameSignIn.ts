import { api } from '$lib/services/api';

// Sign-in from inside a workspace frame (backend/src/routes/frame-sign-in.ts).
//
// Auth servers refuse to be framed, so sign-in runs in a popup. The popup is
// top-level and the frame is partitioned, so neither the cookie the callback
// would set nor a BroadcastChannel reaches the frame, and the auth server's COOP
// cuts `window.opener` (atlauncher docs/FINDINGS.md §1). Instead the frame keeps
// a random relay secret and opens the popup on /auth/frame-start, which asks the
// frame for the request (with only the secret's hash) by postMessage while the
// opener link still works, then starts sign-in. The frame polls the backend with
// the secret until the popup's sign-in lands, and the claim answers with a
// cookie partitioned to the shell's site.

export const FRAME_SIGN_IN_READY = 'skyreader:frame-sign-in-ready';
const FRAME_SIGN_IN_REQUEST = 'skyreader:frame-sign-in-request';

export type FrameSignInTarget = { handle: string } | { pds: string };
export type FrameSignInRequest = FrameSignInTarget & { relayHash: string; returnUrl?: string };

export function parseFrameSignInRequest(data: unknown): FrameSignInRequest | null {
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.type !== FRAME_SIGN_IN_REQUEST) return null;
  if (typeof m.relayHash !== 'string' || !/^[0-9a-f]{64}$/.test(m.relayHash)) return null;
  if (m.returnUrl !== undefined && typeof m.returnUrl !== 'string') return null;
  const returnUrl = m.returnUrl as string | undefined;
  if (typeof m.handle === 'string') return { handle: m.handle, relayHash: m.relayHash, returnUrl };
  if (typeof m.pds === 'string') return { pds: m.pds, relayHash: m.relayHash, returnUrl };
  return null;
}

const POLL_MS = 1500;
// The backend keeps a parked sign-in for 10 minutes; the reader gets 5.
const DEADLINE_MS = 5 * 60 * 1000;
// How long the popup gets to load /auth/frame-start and say it's ready.
const HANDSHAKE_MS = 15_000;

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });

/**
 * Must be called straight from a click handler: the popup is opened before the
 * first await, while the click still counts as a user gesture. Resolves once
 * the frame holds a session; rejects on timeout, or with `signal`'s reason when
 * the reader cancels.
 */
export async function signInFromFrame(
  target: FrameSignInTarget,
  returnUrl: string | undefined,
  signal: AbortSignal
): Promise<void> {
  const popup = window.open('/auth/frame-start', 'skyreader-sign-in', 'popup,width=520,height=720');
  if (!popup) throw new Error('Allow pop-ups for Skyreader to sign in here.');

  let onMessage: ((event: MessageEvent) => void) | undefined;
  try {
    const relay = hex(crypto.getRandomValues(new Uint8Array(32)));
    const relayHash = hex(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(relay)))
    );

    // Hand the popup its request once it's loaded and asks for it.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The sign-in window did not open. Try again.')),
        HANDSHAKE_MS
      );
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true }
      );
      onMessage = (event: MessageEvent) => {
        if (event.source !== popup || event.origin !== location.origin) return;
        if ((event.data as { type?: unknown })?.type !== FRAME_SIGN_IN_READY) return;
        const request = { type: FRAME_SIGN_IN_REQUEST, ...target, relayHash, returnUrl };
        popup.postMessage(request, location.origin);
        clearTimeout(timer);
        resolve();
      };
      window.addEventListener('message', onMessage);
    });

    // popup.closed can't be trusted: COOP on the auth server makes the handle
    // report closed while the popup is still open. Poll until the deadline; one
    // failed poll (offline blip, 5xx) is not a reason to give up.
    const deadline = Date.now() + DEADLINE_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_MS, signal);
      try {
        if (await api.claimFrameSignIn(relay)) return;
      } catch (err) {
        console.warn('Frame sign-in poll failed, retrying', err);
      }
    }
    throw new Error('Sign-in timed out. Try again.');
  } catch (err) {
    popup.close();
    throw err;
  } finally {
    if (onMessage) window.removeEventListener('message', onMessage);
  }
}
