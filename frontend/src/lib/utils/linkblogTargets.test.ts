import { describe, it, expect } from 'vitest';
import {
  linkblogSelectionChanged,
  publicationHost,
  publicationPostCount,
  resolveLinkblogFormat,
} from './linkblogTargets';
import type { LinkblogPublicationChoice } from '$lib/types';

const DID = 'did:plc:alice';
const SKYREADER_URI = `at://${DID}/site.standard.publication/skyreader-links`;
const PCKT_URI = `at://${DID}/site.standard.publication/3lmypckt`;

const skyreader: LinkblogPublicationChoice = {
  uri: SKYREADER_URI,
  rkey: 'skyreader-links',
  name: 'My links',
  isDefault: true,
  detectedFormat: 'leaflet',
};

const pckt: LinkblogPublicationChoice = {
  uri: PCKT_URI,
  rkey: '3lmypckt',
  name: 'Reading notes',
  url: 'https://reader.pckt.blog/',
  isDefault: false,
  detectedFormat: 'pckt',
  posts: 3,
};

const currentSkyreader = { uri: SKYREADER_URI, format: 'leaflet' as const };

describe('publicationHost', () => {
  it('shows the address a publication lives at', () => {
    expect(publicationHost('https://leaflet.pub/lish/fieldnotes')).toBe('leaflet.pub');
  });

  it('has nothing to show for a missing or unparseable url', () => {
    expect(publicationHost(undefined)).toBeUndefined();
    expect(publicationHost('leaflet')).toBeUndefined();
  });
});

describe('publicationPostCount', () => {
  it('counts posts, singular and plural, including none', () => {
    expect(publicationPostCount(0)).toBe('No posts yet');
    expect(publicationPostCount(undefined)).toBe('No posts yet');
    expect(publicationPostCount(1)).toBe('1 post');
    expect(publicationPostCount(12)).toBe('12 posts');
  });
});

describe('resolveLinkblogFormat', () => {
  it('follows the format detected from the publication’s own posts', () => {
    expect(resolveLinkblogFormat(pckt, currentSkyreader, {})).toBe('pckt');
  });

  it('keeps the format already in use on the live target', () => {
    expect(resolveLinkblogFormat(pckt, { uri: PCKT_URI, format: 'markpub' }, {})).toBe('markpub');
  });

  it('prefers what the user picked for that publication', () => {
    expect(resolveLinkblogFormat(pckt, currentSkyreader, { [PCKT_URI]: 'offprint' })).toBe(
      'offprint'
    );
    // An override on a different publication doesn't leak across rows.
    expect(resolveLinkblogFormat(pckt, currentSkyreader, { [SKYREADER_URI]: 'offprint' })).toBe(
      'pckt'
    );
  });

  it('falls back to leaflet for a publication we can’t place', () => {
    expect(
      resolveLinkblogFormat({ ...pckt, detectedFormat: undefined }, currentSkyreader, {})
    ).toBe('leaflet');
  });
});

describe('linkblogSelectionChanged', () => {
  it('is false while the live target is selected unchanged', () => {
    expect(linkblogSelectionChanged(skyreader, currentSkyreader, 'leaflet')).toBe(false);
    expect(linkblogSelectionChanged(pckt, { uri: PCKT_URI, format: 'pckt' }, 'pckt')).toBe(false);
  });

  it('is true when another publication is selected', () => {
    expect(linkblogSelectionChanged(pckt, currentSkyreader, 'pckt')).toBe(true);
  });

  it('is true when the connected publication keeps the row but changes format', () => {
    expect(linkblogSelectionChanged(pckt, { uri: PCKT_URI, format: 'pckt' }, 'markpub')).toBe(true);
  });

  it('ignores format for the Skyreader linkblog, which writes its own', () => {
    expect(linkblogSelectionChanged(skyreader, currentSkyreader, 'markpub')).toBe(false);
  });
});
