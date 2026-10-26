// Which atworkplace workspace shells may frame Skyreader, per Skyreader host
// (docs/plans/ATWORKPLACE.md). Read by the CSP middleware (functions/_middleware.ts,
// hooks.server.ts in dev) for `frame-ancestors`, and by the app to decide whether
// its parent is a shell it should talk to.
//
// Production is deliberately absent: framing stays `'none'` there until the spike
// has earned it. The backend's WORKSPACE_FRAMING flag must be on for the same
// environment, or a framed reader can't sign in.

const WORKSPACE_SHELLS: Record<string, readonly string[]> = {
  // Not local dev: a framed sign-in needs a Secure (https) partitioned cookie.
  'staging.skyreader.app': ['https://atworkplace-shell.strand-source.workers.dev'],
};

export function workspaceShellsFor(host: string): readonly string[] {
  return WORKSPACE_SHELLS[host] ?? [];
}

/** The CSP `frame-ancestors` source list for a host. */
export function frameAncestorsFor(host: string): string {
  const shells = workspaceShellsFor(host);
  return shells.length > 0 ? shells.join(' ') : "'none'";
}
