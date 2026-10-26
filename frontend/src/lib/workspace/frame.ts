import { browser } from '$app/environment';
import { workspaceShellsFor } from './shells';

// Is Skyreader running inside a trusted atworkplace shell, and if so, which?
//
// Answered once per page load. The parent's origin comes from
// `location.ancestorOrigins` (Chromium, Safari) or the referrer (Firefox), and
// only counts if it's on this host's shell list. Every postMessage to the shell
// names this origin as its target, and messages from anywhere else are dropped,
// so a page that frames Skyreader without being on the list hears nothing.
//
// Firefox's referrer names the shell only on the frame's first page: after a
// full-page load inside the frame (a session expiring sends it to
// /auth/login) it names Skyreader. So the answer is kept in sessionStorage,
// which is per frame and partitioned by the shell's site.

const STORAGE_KEY = 'skyreader-workspace-shell';
let cached: string | null | undefined;

function parentOrigin(): string | undefined {
  const ancestor = location.ancestorOrigins?.[0];
  if (ancestor) return ancestor;
  if (document.referrer) {
    try {
      const referrer = new URL(document.referrer).origin;
      if (referrer !== location.origin) return referrer;
    } catch {
      // Not a URL; fall through to the remembered answer.
    }
  }
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function workspaceShellOrigin(): string | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (!browser || window.parent === window) return cached;

  const parent = parentOrigin();
  if (parent && workspaceShellsFor(location.host).includes(parent)) {
    cached = parent;
    try {
      sessionStorage.setItem(STORAGE_KEY, parent);
    } catch {
      // Storage blocked: detection still works on this page.
    }
  }
  return cached;
}
