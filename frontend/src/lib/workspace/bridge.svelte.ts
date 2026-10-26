import { auth } from '$lib/stores/auth.svelte';
import { workspaceShellOrigin } from './frame';

// Skyreader's side of the atworkplace shell protocol (`atworkplace/1`, atlauncher
// docs/PROTOCOL.md). Spike scope: tell the shell which account is signed in,
// keep it told, and answer `switch` / `sign-out`. Unread counts, links, actions
// and "what links here" come with phase 1 (docs/plans/ATWORKPLACE.md).
//
// Skyreader holds one session per browser partition, so `sessions` is that one
// account or nothing, and a `switch` to anyone else is answered `needs-sign-in`.

const PROTO = 'atworkplace/1';

type ShellMessage =
  | { proto: typeof PROTO; type: 'switch'; account: { did: string; handle: string } }
  | { proto: typeof PROTO; type: 'sign-out'; did: string };

function parseShellMessage(data: unknown): ShellMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.proto !== PROTO) return null;
  if (m.type === 'switch') {
    const account = m.account as Record<string, unknown> | undefined;
    return typeof account?.did === 'string' && typeof account.handle === 'string'
      ? (m as ShellMessage)
      : null;
  }
  if (m.type === 'sign-out') return typeof m.did === 'string' ? (m as ShellMessage) : null;
  return null;
}

/** Starts talking to the shell, if Skyreader is in one. Returns a stop function. */
export function startWorkspaceBridge(): () => void {
  const shell = workspaceShellOrigin();
  if (!shell) return () => {};

  const post = (message: Record<string, unknown>) =>
    window.parent.postMessage({ proto: PROTO, ...message }, shell);
  const accounts = () => {
    const did = auth.user?.did ?? null;
    return { sessions: did ? [did] : [], active: did };
  };

  post({ type: 'hello', app: { name: 'Skyreader' }, ...accounts() });

  // `state` whenever the signed-in account changes (sign-in, sign-out, expiry).
  const stopState = $effect.root(() => {
    let first = true;
    $effect(() => {
      const current = accounts();
      if (first) {
        first = false;
        return;
      }
      post({ type: 'state', ...current });
    });
  });

  const onMessage = (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== shell) return;
    const message = parseShellMessage(event.data);
    if (!message) return;
    const did = auth.user?.did;
    if (message.type === 'switch') {
      if (message.account.did === did) post({ type: 'state', ...accounts() });
      else post({ type: 'needs-sign-in', did: message.account.did });
    } else if (message.type === 'sign-out' && message.did === did) {
      void auth.logout();
    }
  };
  window.addEventListener('message', onMessage);

  return () => {
    window.removeEventListener('message', onMessage);
    stopState();
  };
}
