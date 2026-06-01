import { describe, it, expect } from 'vitest';
import {
  GRANULAR_SCOPES,
  ALL_POSSIBLE_SCOPES,
  LINKBLOG_SCOPES,
  hasRequiredScopes,
} from '../src/routes/auth';

// The linkblog write routes gate on these scopes; sessions predating them must
// be told to re-auth (scope_upgrade_required). This locks that:
//  - login requests them (they're in ALL_POSSIBLE_SCOPES), and
//  - an old session that lacks them fails the gate.
describe('linkblog scopes', () => {
  it('are part of what login requests', () => {
    for (const scope of LINKBLOG_SCOPES) {
      expect(ALL_POSSIBLE_SCOPES).toContain(scope);
    }
  });

  it('passes the gate once granted', () => {
    expect(hasRequiredScopes(ALL_POSSIBLE_SCOPES, LINKBLOG_SCOPES)).toBe(true);
  });

  it('fails the gate for a pre-linkblog session', () => {
    expect(hasRequiredScopes(GRANULAR_SCOPES, LINKBLOG_SCOPES)).toBe(false);
  });

  it('fails the gate for a session with no scope tracking', () => {
    expect(hasRequiredScopes(undefined, LINKBLOG_SCOPES)).toBe(false);
  });
});
