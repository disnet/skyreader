import {
  BlobPermission,
  IncludeScope,
  RepoPermission,
  ScopePermissionsTransition,
} from '@atproto/oauth-scopes';
import skyreaderAuthFull from '../../lexicons/app/skyreader/authFull.json';
import { FEATURE_OPT_IN_SCOPES, type ScopeFeature } from '../config/scopes';

// Answers "does this session's granted scope allow X?" by meaning, not by string.
//
// A granted scope can arrive in several equivalent shapes: the granular
// `repo:app.skyreader.feed.subscription` we used to request, the expansion of a
// permission set (`repo?collection=app.skyreader.feed.subscription&collection=…`,
// which is what the PDS puts in the token response for `include:…`), or a broad
// `transition:generic`. Exact string matching only understands the first, so
// every gate goes through here.

// Permission sets we publish ourselves, so a stored scope that still carries the
// raw `include:` (a token response without `scope`, where we fall back to what
// we requested) can be expanded locally.
const LOCAL_PERMISSION_SETS: Record<string, unknown> = {
  [skyreaderAuthFull.id]: skyreaderAuthFull.defs.main,
};

function expandLocalIncludes(scopes: string[]): string[] {
  return scopes.flatMap((scope) => {
    const include = IncludeScope.fromString(scope);
    if (!include) return [scope];
    const set = LOCAL_PERMISSION_SETS[include.nsid];
    // An unknown set grants nothing we can vouch for.
    return set ? include.toScopes(set as Parameters<IncludeScope['toScopes']>[0]) : [];
  });
}

/** True when `granted` (a space-separated scope string) covers every scope in `required`. */
export function grantsScopes(granted: string | undefined | null, required: string[]): boolean {
  if (!granted) return false;
  const grantedList = expandLocalIncludes(granted.split(' ').filter(Boolean));
  const grantedSet = new Set(grantedList);
  const permissions = new ScopePermissionsTransition(grantedList);

  return required.every((scope) => {
    if (grantedSet.has(scope)) return true;

    const repo = RepoPermission.fromString(scope);
    if (repo) {
      return repo.collection.every((collection) =>
        repo.action.every((action) => permissions.allowsRepo({ collection, action }))
      );
    }

    const blob = BlobPermission.fromString(scope);
    if (blob) {
      if (permissions.hasTransitionGeneric) return true;
      const grantedAccepts = grantedList.flatMap((s) => BlobPermission.fromString(s)?.accept ?? []);
      return blob.accept.every((accept) =>
        // A wildcard ("image/*") is only covered by an equal or broader wildcard;
        // allowsBlob() matches concrete MIME types.
        accept.endsWith('/*')
          ? grantedAccepts.includes('*/*') || grantedAccepts.includes(accept)
          : permissions.allowsBlob({ mime: accept })
      );
    }

    return false;
  });
}

/**
 * The optional features `granted` shows the reader opted into (see
 * FEATURE_OPT_IN_SCOPES). This decides what to ask for again, not what is
 * allowed: gates still check the exact scopes they need.
 */
export function grantedFeatures(granted: string | undefined | null): ScopeFeature[] {
  return (Object.keys(FEATURE_OPT_IN_SCOPES) as ScopeFeature[]).filter((feature) =>
    grantsScopes(granted, FEATURE_OPT_IN_SCOPES[feature])
  );
}
