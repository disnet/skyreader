import { describe, it, expect } from 'vitest';
import { isPaidTier, isGrantedSupporter, hasGrantFallback } from './tier';
import type { User } from '$lib/types';

const user = (fields: Partial<User>): User => ({
  did: 'did:plc:test',
  handle: 'reader.test',
  pdsUrl: 'https://pds.test',
  ...fields,
});

describe('tier origin', () => {
  it('reads a pre-Polar supporter (null source) as granted, not paid', () => {
    // The rows this whole feature exists for: supporters granted by hand before
    // Skyreader had paid plans. Calling them paid would send them to a billing
    // portal that has no Polar customer behind it.
    const early = user({ tier: 'supporter', tierSource: null, grantedTier: 'supporter' });
    expect(isPaidTier(early)).toBe(false);
    expect(isGrantedSupporter(early)).toBe(true);
  });

  it('reads an admin-granted supporter as granted', () => {
    const granted = user({ tier: 'supporter', tierSource: 'admin', grantedTier: 'supporter' });
    expect(isGrantedSupporter(granted)).toBe(true);
  });

  it.each(['polar_subscription', 'polar_order'] as const)('reads a %s as paid', (source) => {
    const paid = user({ tier: 'supporter', tierSource: source });
    expect(isPaidTier(paid)).toBe(true);
    expect(isGrantedSupporter(paid)).toBe(false);
  });

  it('does not call a free user a granted supporter', () => {
    expect(isGrantedSupporter(user({ tier: 'free', tierSource: null }))).toBe(false);
    expect(isGrantedSupporter(null)).toBe(false);
  });

  it('spots an early supporter who now pays and still holds the grant', () => {
    const both = user({
      tier: 'supporter',
      tierSource: 'polar_subscription',
      grantedTier: 'supporter',
    });
    expect(hasGrantFallback(both)).toBe(true);
    expect(hasGrantFallback(user({ tier: 'supporter', tierSource: 'polar_order' }))).toBe(false);
  });
});
