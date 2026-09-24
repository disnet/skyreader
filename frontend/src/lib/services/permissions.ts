// Progressive scopes: helpers for the "X needs your permission" follow-up to a
// ScopeUpgradeError. The grant itself lives on the auth store; it's reached
// through a dynamic import so stores and services that surface a permission
// prompt don't pull the auth store (and its api wiring) in statically.
import { SCOPE_FEATURE_LABELS, type ScopeFeature } from '$lib/types';

export function grantPermissions(features: ScopeFeature[] = [], returnUrl?: string): void {
  void import('$lib/stores/auth.svelte').then(({ auth }) =>
    auth.grantPermissions(features, returnUrl)
  );
}

/** "Semble needs your permission" — or, with no feature, a core-permissions refresh. */
export function permissionMessage(feature?: ScopeFeature | null): string {
  return feature
    ? `${SCOPE_FEATURE_LABELS[feature]} needs your permission`
    : 'Your sign-in needs refreshing';
}

/**
 * A toast's message + action for a missing permission. Prefer the feature the
 * error carries; `fallback` is the surface's own feature when it knows it.
 */
export function permissionToast(
  error: { feature?: ScopeFeature },
  fallback?: ScopeFeature
): { message: string; action: { label: string; run: () => void } } {
  const feature = error.feature ?? fallback;
  return {
    message: permissionMessage(feature),
    action: {
      label: feature ? 'Allow access' : 'Refresh access',
      run: () => grantPermissions(feature ? [feature] : []),
    },
  };
}
