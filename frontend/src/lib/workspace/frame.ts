import { browser } from '$app/environment';
import { workspaceShellsFor } from './shells';

// Is Skyreader running inside a trusted atworkplace shell, and if so, which?
//
// Answered once per page load. The parent's origin comes from
// `location.ancestorOrigins` (Chromium, Safari) or the referrer (Firefox), and
// only counts if it's on this host's shell list. Every postMessage to the shell
// names this origin as its target, and messages from anywhere else are dropped,
// so a page that frames Skyreader without being on the list hears nothing.

let cached: string | null | undefined;

export function workspaceShellOrigin(): string | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (!browser || window.parent === window) return cached;

  let parent: string | undefined = location.ancestorOrigins?.[0];
  if (!parent && document.referrer) {
    try {
      parent = new URL(document.referrer).origin;
    } catch {
      parent = undefined;
    }
  }
  if (parent && workspaceShellsFor(location.host).includes(parent)) cached = parent;
  return cached;
}
