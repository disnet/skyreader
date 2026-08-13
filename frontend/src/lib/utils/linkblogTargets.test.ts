import { describe, it, expect } from 'vitest';
import {
  linkblogFormatLocked,
  linkblogSelectionChanged,
  publicationAddress,
  publicationConnectable,
  publicationHost,
  publicationPostCount,
  resolveLinkblogFormat,
  shareDestination,
} from './linkblogTargets';
import type { LinkblogPublicationChoice } from '$lib/types';

const DID = 'did:plc:alice';
const SKYREADER_URI = `at://${DID}/site.standard.publication/skyreader-links`;
const OFFPRINT_URI = `at://${DID}/site.standard.publication/3lmyoffprint`;

const skyreader: LinkblogPublicationChoice = {
  uri: SKYREADER_URI,
  rkey: 'skyreader-links',
  name: 'My links',
  isDefault: true,
  detectedFormat: 'leaflet',
};

const offprint: LinkblogPublicationChoice = {
  uri: OFFPRINT_URI,
  rkey: '3lmyoffprint',
  name: 'Reading notes',
  url: 'https://offprint.app/reader/',
  isDefault: false,
  appLabel: 'Offprint',
  detectedFormat: 'offprint',
  formatLocked: true,
  posts: 3,
};

// A publication whose app we can't place: the format is genuinely the user's to
// pick, so nothing is locked.
const OPEN_URI = `at://${DID}/site.standard.publication/3lmyopen`;
const open: LinkblogPublicationChoice = {
  uri: OPEN_URI,
  rkey: '3lmyopen',
  name: 'Field notes',
  url: 'https://notes.example.com/',
  isDefault: false,
  posts: 2,
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

describe('publicationAddress', () => {
  it('drops the scheme and the trailing slash', () => {
    expect(publicationAddress('https://linkblogs.skyreader.app/alice.bsky.social/')).toBe(
      'linkblogs.skyreader.app/alice.bsky.social'
    );
    expect(publicationAddress('http://offprint.app/reader')).toBe('offprint.app/reader');
  });

  it('has nothing to show for a missing url', () => {
    expect(publicationAddress(undefined)).toBeUndefined();
    expect(publicationAddress(null)).toBeUndefined();
    expect(publicationAddress('')).toBeUndefined();
  });
});

describe('shareDestination', () => {
  const linkblogPage = 'https://linkblogs.skyreader.app/alice.bsky.social/';

  it('names the Skyreader linkblog when nothing is connected', () => {
    expect(shareDestination({ name: 'My links', external: false }, linkblogPage)).toEqual({
      name: 'your public linkblog',
      external: false,
      url: linkblogPage,
      address: 'linkblogs.skyreader.app/alice.bsky.social',
    });
  });

  it('falls back to the linkblog before the publication has loaded', () => {
    expect(shareDestination(null, linkblogPage).external).toBe(false);
    expect(shareDestination(null, null)).toEqual({
      name: 'your public linkblog',
      external: false,
      url: undefined,
      address: undefined,
    });
  });

  it('names the connected publication and its own page, not the linkblog url', () => {
    expect(
      shareDestination(
        {
          name: 'Reading notes',
          external: true,
          externalUrl: 'https://offprint.app/reader/',
        },
        linkblogPage
      )
    ).toEqual({
      name: 'Reading notes',
      external: true,
      url: 'https://offprint.app/reader/',
      address: 'offprint.app/reader',
      linkblogUrl: linkblogPage,
    });
  });

  it('still names a connected publication that has no usable url', () => {
    const destination = shareDestination(
      { name: 'Reading notes', external: true, externalUrl: undefined },
      linkblogPage
    );
    expect(destination.name).toBe('Reading notes');
    expect(destination.url).toBeUndefined();
    expect(destination.address).toBeUndefined();
    expect(destination.linkblogUrl).toBe(linkblogPage);
  });

  it('has something to call an unnamed connected publication', () => {
    expect(shareDestination({ name: '', external: true }, linkblogPage).name).toBe(
      'the publication you connected'
    );
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

// pckt renders only the posts pckt wrote, so a link post Skyreader adds to a
// pckt publication is a well-formed record that its site never shows. The
// backend refuses the connect; the picker has to stop offering it first.
const pckt: LinkblogPublicationChoice = {
  uri: `at://${DID}/site.standard.publication/3lmypckt`,
  rkey: '3lmypckt',
  name: 'Reading notes',
  url: 'https://reader.pckt.blog/',
  isDefault: false,
  appLabel: 'pckt',
  detectedFormat: 'pckt',
  formatLocked: true,
  supported: false,
  unsupportedReason: 'pckt only shows posts written in pckt…',
  posts: 3,
};

describe('publicationConnectable', () => {
  it('is false only for a publication the backend marked unsupported', () => {
    expect(publicationConnectable(pckt)).toBe(false);
    expect(publicationConnectable(offprint)).toBe(true);
    expect(publicationConnectable(skyreader)).toBe(true);
  });

  it('treats a missing flag as connectable, so an older backend still works', () => {
    expect(publicationConnectable(open)).toBe(true);
    expect(publicationConnectable(undefined)).toBe(true);
  });
});

describe('linkblogFormatLocked', () => {
  it('is locked for an app that reads only its own blocks', () => {
    expect(linkblogFormatLocked(offprint)).toBe(true);
  });

  it('is open when the app leaves the choice, or we can’t place it', () => {
    expect(linkblogFormatLocked(open)).toBe(false);
    expect(linkblogFormatLocked(undefined)).toBe(false);
    // A lock with nothing detected to lock to is no lock at all.
    expect(linkblogFormatLocked({ ...offprint, detectedFormat: undefined })).toBe(false);
  });
});

describe('resolveLinkblogFormat', () => {
  it('follows the format detected from the publication’s own posts', () => {
    expect(resolveLinkblogFormat(offprint, currentSkyreader, {})).toBe('offprint');
  });

  it('holds a locked publication to its app’s format', () => {
    // Neither a stale stored format nor an override can send offprint blocks to a
    // reader that renders nothing else.
    expect(resolveLinkblogFormat(offprint, { uri: OFFPRINT_URI, format: 'markpub' }, {})).toBe(
      'offprint'
    );
    expect(resolveLinkblogFormat(offprint, currentSkyreader, { [OFFPRINT_URI]: 'leaflet' })).toBe(
      'offprint'
    );
  });

  it('keeps the format already in use on the live target', () => {
    expect(resolveLinkblogFormat(open, { uri: OPEN_URI, format: 'markpub' }, {})).toBe('markpub');
  });

  it('prefers what the user picked for that publication', () => {
    expect(resolveLinkblogFormat(open, currentSkyreader, { [OPEN_URI]: 'markpub' })).toBe(
      'markpub'
    );
    // An override on a different publication doesn't leak across rows.
    expect(resolveLinkblogFormat(open, currentSkyreader, { [SKYREADER_URI]: 'markpub' })).toBe(
      'leaflet'
    );
  });

  it('falls back to leaflet for a publication we can’t place', () => {
    expect(resolveLinkblogFormat(open, currentSkyreader, {})).toBe('leaflet');
  });
});

describe('linkblogSelectionChanged', () => {
  it('is false while the live target is selected unchanged', () => {
    expect(linkblogSelectionChanged(skyreader, currentSkyreader, 'leaflet')).toBe(false);
    expect(
      linkblogSelectionChanged(offprint, { uri: OFFPRINT_URI, format: 'offprint' }, 'offprint')
    ).toBe(false);
  });

  it('is true when another publication is selected', () => {
    expect(linkblogSelectionChanged(offprint, currentSkyreader, 'offprint')).toBe(true);
  });

  it('is true when the connected publication keeps the row but changes format', () => {
    expect(linkblogSelectionChanged(open, { uri: OPEN_URI, format: 'leaflet' }, 'markpub')).toBe(
      true
    );
    // Including the case where the lock corrects a format stored before it
    // existed — there is something to apply.
    expect(
      linkblogSelectionChanged(offprint, { uri: OFFPRINT_URI, format: 'markpub' }, 'offprint')
    ).toBe(true);
  });

  it('ignores format for the Skyreader linkblog, which writes its own', () => {
    expect(linkblogSelectionChanged(skyreader, currentSkyreader, 'markpub')).toBe(false);
  });
});
