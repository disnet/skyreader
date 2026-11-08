import { describe, it, expect } from 'vitest';
import { parseSignInAllowlist } from '../src/services/signin-allowlist';

describe('parseSignInAllowlist', () => {
  it('reads nothing from an unset or blank value', () => {
    expect(parseSignInAllowlist(undefined)).toEqual([]);
    expect(parseSignInAllowlist('  , \n')).toEqual([]);
  });

  it('drops a bare name rather than reading it as a bsky.social handle', () => {
    expect(parseSignInAllowlist('tim, did:plc:abc')).toEqual(['did:plc:abc']);
  });

  it('splits on commas and whitespace, dropping @ and case', () => {
    expect(parseSignInAllowlist('@Tim.bsky.social, did:plc:ABC\n test.example')).toEqual([
      'tim.bsky.social',
      'did:plc:abc',
      'test.example',
    ]);
  });
});
