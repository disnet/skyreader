import { describe, it, expect } from 'vitest';
import { IncludeScope } from '@atproto/oauth-scopes';
import authFull from '../lexicons/app/skyreader/authFull.json';
import {
  ALL_POSSIBLE_SCOPES,
  GRANULAR_SCOPES,
  LINKBLOG_SCOPES,
  SCOPE_FEATURES,
  SKYREADER_PERMISSION_SET_SCOPE,
  SKYREADER_REPO_SCOPES,
  USERINPUT_IMAGE_SCOPES,
  baseScopes,
  buildRequestedScopes,
  clientMetadataScopes,
  type ScopeFeature,
} from '../src/config/scopes';
import { grantedFeatures, grantsScopes } from '../src/services/scope-check';
import { hasRequiredScopes } from '../src/routes/auth';

const SETS_ON = { OAUTH_PERMISSION_SETS: 'true' };
const SETS_OFF = { OAUTH_PERMISSION_SETS: 'false' };

// What a PDS puts in the token response for `include:app.skyreader.authFull`.
const expandedSet = IncludeScope.fromString(SKYREADER_PERMISSION_SET_SCOPE)!.toScopes(
  authFull.defs.main as Parameters<IncludeScope['toScopes']>[0]
);

describe('permission set lexicon', () => {
  it('covers exactly the app.skyreader collections we request granularly', () => {
    const collections = authFull.defs.main.permissions.flatMap((p) => p.collection);
    expect(collections.sort()).toEqual(
      SKYREADER_REPO_SCOPES.map((s) => s.replace(/^repo:/, '')).sort()
    );
  });

  it('survives the PDS namespace-authority filter (nothing is dropped)', () => {
    // IncludeScope silently drops permissions outside the set's own namespace.
    expect(expandedSet).toHaveLength(1);
    expect(grantsScopes(['atproto', ...expandedSet].join(' '), SKYREADER_REPO_SCOPES)).toBe(true);
  });
});

describe('grantsScopes', () => {
  it('accepts the expanded permission-set form for granular requirements', () => {
    const granted = ['atproto', ...expandedSet].join(' ');
    expect(hasRequiredScopes(granted)).toBe(true);
    expect(hasRequiredScopes(granted, ['repo:app.skyreader.reading.readAlong'])).toBe(true);
    expect(hasRequiredScopes(granted, LINKBLOG_SCOPES)).toBe(false);
  });

  it('expands our own include: locally when it was stored unexpanded', () => {
    expect(hasRequiredScopes(`atproto ${SKYREADER_PERMISSION_SET_SCOPE}`)).toBe(true);
  });

  it('grants nothing for an unknown include:', () => {
    expect(grantsScopes('atproto include:com.example.authAll', ['repo:com.example.post'])).toBe(
      false
    );
  });

  it('respects action-restricted repo scopes', () => {
    expect(grantsScopes('repo:a.b.c?action=create', ['repo:a.b.c'])).toBe(false);
    expect(grantsScopes('repo:a.b.c', ['repo:a.b.c?action=create'])).toBe(true);
  });

  it('treats transition:generic as covering repo and blob', () => {
    expect(grantsScopes('atproto transition:generic', ['repo:x.y.z', 'blob:image/*'])).toBe(true);
  });

  it('matches blob wildcards only by an equal or broader grant', () => {
    expect(grantsScopes('blob:*/*', USERINPUT_IMAGE_SCOPES)).toBe(true);
    expect(grantsScopes('blob:image/*', USERINPUT_IMAGE_SCOPES)).toBe(true);
    expect(grantsScopes('blob:image/png', USERINPUT_IMAGE_SCOPES)).toBe(false);
  });

  it('fails closed without scope tracking', () => {
    expect(grantsScopes(undefined, ['atproto'])).toBe(false);
    expect(hasRequiredScopes('')).toBe(false);
  });
});

describe('progressive requests', () => {
  it('sign-in asks for no optional feature by default', () => {
    const scope = buildRequestedScopes(SETS_OFF, []);
    expect(grantedFeatures(scope)).toEqual([]);
    expect(hasRequiredScopes(scope)).toBe(true);
  });

  it('uses the permission set instead of granular app.skyreader scopes when enabled', () => {
    const scopes = baseScopes(SETS_ON);
    expect(scopes).toContain(SKYREADER_PERMISSION_SET_SCOPE);
    for (const s of SKYREADER_REPO_SCOPES) expect(scopes).not.toContain(s);
  });

  it('a feature request grants exactly that feature (plus its prerequisites)', () => {
    for (const feature of Object.keys(SCOPE_FEATURES) as ScopeFeature[]) {
      const granted = grantedFeatures(buildRequestedScopes(SETS_OFF, [feature]));
      expect(granted).toContain(feature);
      const extra = granted.filter((f) => f !== feature);
      // pckt / offprint ride on the linkblog.
      expect(extra).toEqual(feature === 'pckt' || feature === 'offprint' ? ['linkblog'] : []);
    }
  });

  it('every request fits inside the client metadata ceiling', () => {
    for (const env of [SETS_ON, SETS_OFF]) {
      const ceiling = new Set(clientMetadataScopes(env).split(' '));
      const all = buildRequestedScopes(env, Object.keys(SCOPE_FEATURES) as ScopeFeature[]);
      for (const s of all.split(' ')) expect(ceiling.has(s)).toBe(true);
    }
  });

  it('a pre-progressive session (granted everything) keeps every feature', () => {
    expect(grantedFeatures(ALL_POSSIBLE_SCOPES).sort()).toEqual(
      (Object.keys(SCOPE_FEATURES) as ScopeFeature[]).sort()
    );
    expect(grantedFeatures(GRANULAR_SCOPES)).toEqual([]);
  });

  it('remembers features granted before their scope sets grew', () => {
    // Semble before the connection scope; feedback before the vote/image scopes.
    const legacy = [
      GRANULAR_SCOPES,
      'repo:network.cosmik.card repo:network.cosmik.collection repo:network.cosmik.collectionLink',
      'repo:app.userinput.discussion',
    ].join(' ');
    expect(grantedFeatures(legacy).sort()).toEqual(['feedback', 'semble']);
  });
});
