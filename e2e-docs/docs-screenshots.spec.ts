import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../e2e/fixtures';
import {
  seedSavedArticle,
  seedSubscription,
  seedFeedItems,
  cleanupFeedItems,
  seedItemLabel,
} from '../e2e/seed';

// Screenshots for docs.skyreader.app, captured from the real app against the
// e2e stack (seeded user, stubbed PDS-dependent endpoints). Each test writes a
// PNG into docs-site/src/assets/screenshots/, where the guide pages embed it.
// Rerun with `npm run shots:docs` when the design changes, and commit the
// regenerated images alongside the change.

const OUT_DIR = join(import.meta.dirname, '../docs-site/src/assets/screenshots');
mkdirSync(OUT_DIR, { recursive: true });

/**
 * Screenshot the region spanning `first` through `last` (inclusive), with
 * breathing room, so a shot can cover a run of sibling elements without the
 * app needing a wrapper for the camera's sake.
 */
async function shootRegion(page: Page, first: Locator, last: Locator, file: string, pad = 20) {
  await first.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => document.fonts.ready);
  const a = await first.boundingBox();
  const b = await last.boundingBox();
  if (!a || !b) throw new Error(`Cannot measure region for ${file}`);
  const x = Math.max(0, Math.min(a.x, b.x) - pad);
  const y = Math.max(0, a.y - pad);
  await page.screenshot({
    path: join(OUT_DIR, file),
    animations: 'disabled',
    clip: {
      x,
      y,
      width: Math.max(a.x + a.width, b.x + b.width) - x + pad,
      height: b.y + b.height - y + pad,
    },
  });
}

async function shootElement(page: Page, target: Locator, file: string, pad = 20) {
  await shootRegion(page, target, target, file, pad);
}

// The two linkblog endpoints the Settings page and the composer read need a
// live PDS, so they're stubbed with a plain Skyreader linkblog carrying the
// default formatting — the state a new user actually sees.
async function stubLinkblogApi(page: Page) {
  const publication = {
    uri: 'at://did:plc:docs-shots/site.standard.publication/skyreaderlinks',
    url: 'https://linkblogs.skyreader.app/reader.example.com/',
    name: 'My links',
    exists: true,
    external: false,
    format: 'leaflet',
    disabled: false,
    pageHidden: false,
    formatting: { titleStyle: 'link', cardPosition: 'context' },
  };
  await page.route('**/api/linkblog/publication', (route) => route.fulfill({ json: publication }));
  await page.route('**/api/linkblog/publications', (route) =>
    route.fulfill({
      json: {
        publications: [
          {
            uri: publication.uri,
            rkey: 'skyreaderlinks',
            name: publication.name,
            isDefault: true,
            appId: 'skyreader',
            appLabel: 'Skyreader',
            detectedFormat: 'leaflet',
            posts: 12,
          },
        ],
      },
    })
  );
}

test.describe('Sharing and your linkblog', () => {
  test('settings: how your posts read', async ({ authedPage }) => {
    await stubLinkblogApi(authedPage);
    await authedPage.goto('/settings');

    const panel = authedPage.locator('.panel', {
      has: authedPage.getByRole('heading', { name: 'How your posts read' }),
    });
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await shootElement(authedPage, panel, 'linkblog-post-settings.png');
  });

  test('composer: quote, link card, attribution', async ({ authedPage, testUser }) => {
    await stubLinkblogApi(authedPage);

    // Turn on the per-device attribution offer, the way Settings would.
    await authedPage.evaluate((did) => {
      const raw = localStorage.getItem('skyreader-preferences');
      const prefs = raw ? JSON.parse(raw) : {};
      prefs.linkblogAttributionOfferedDids = [did];
      localStorage.setItem('skyreader-preferences', JSON.stringify(prefs));
    }, testUser.did);

    const title = 'The Reading Room: Notes on Attention';
    await seedSavedArticle(testUser, {
      url: 'https://example.com/essays/reading-room',
      title,
      author: 'A. Reader',
      domain: 'example.com',
      contentType: 'article',
      description:
        'Reading well is not a matter of speed. It is the number of ideas you can hold against each other while the page is still open.',
      content: Array.from(
        { length: 12 },
        (_, i) => `<p>Paragraph ${i + 1} of an essay about reading with attention.</p>`
      ).join(''),
      wordCount: 600,
    });

    await authedPage.goto('/saved');
    await authedPage.getByText(title).first().click({ timeout: 15_000 });
    const reader = authedPage.locator('.reader-overlay');
    await expect(reader).toBeVisible({ timeout: 15_000 });

    await reader.getByTitle('Share to your linkblog').filter({ visible: true }).click();
    const composer = authedPage.locator('section.composer');
    await expect(composer).toBeVisible();

    // A quote pulled from the article, so the shot shows the card sitting
    // between quote and commentary (the default position).
    await composer.getByRole('button', { name: 'Insert a quote from your highlights' }).click();
    await composer.getByRole('menuitem').filter({ hasText: 'Article excerpt' }).click();
    await composer
      .getByPlaceholder(/Say something about it|Add commentary/)
      .last()
      .fill('The case for slowness here is really a case for holding more in mind at once.');

    // Tick "Posted from Skyreader" so the preview line shows what opting in adds.
    await composer.locator('.attribution-toggle input').check();
    // Park focus so no caret lands in the shot.
    await composer.locator('.attribution-toggle input').blur();

    await shootElement(authedPage, composer, 'linkblog-composer.png');
  });
});

// ── The library, the reader, paged mode ─────────────────────────────────────

const FEEDS = [
  {
    url: 'https://commonplace.example.com/feed.xml',
    title: 'The Commonplace',
    items: [
      {
        guid: 'annotation-thinking',
        title: 'Annotation is thinking',
        summary:
          'Writing in the margins is not a record of reading. It is the reading, slowed down enough to notice itself.',
      },
      {
        guid: 'personal-libraries',
        title: 'A field guide to personal libraries',
        summary:
          'What a shelf arranged by memory can do that a database cannot, and where the database quietly wins.',
      },
    ],
  },
  {
    url: 'https://slowweb.example.com/feed.xml',
    title: 'The Slow Web Review',
    items: [
      {
        guid: 'against-skimming',
        title: 'What we lose when we skim',
        summary:
          'Skimming optimizes for coverage. Understanding optimizes for collisions between ideas, and collisions take time.',
      },
      {
        guid: 'paper-and-glass',
        title: 'Reading on paper, reading on glass',
        summary:
          'The screen is winning on convenience. The interesting question is what paper still knows that software has not learned.',
      },
    ],
  },
  {
    url: 'https://typesetter.example.com/feed.xml',
    title: 'The Typesetter',
    items: [
      {
        guid: 'measure-and-leading',
        title: 'Measure, leading, and the comfortable line',
        summary:
          'Sixty-six characters is not a rule. It is a description of where most eyes stop straining.',
      },
    ],
  },
];

const READER_BODY = [
  'Annotation is usually described as something a reader adds to a text, the way a frame is added to a painting. That gets the direction wrong. A note in the margin is not decoration on top of reading; it is the visible part of the reading itself.',
  'Watch someone read with a pen and you can see the difference. The pen hovers, drops, hesitates. Every mark is a small decision about what matters, and the decisions are the understanding. Take the pen away and the decisions still happen, but nothing holds them still long enough to be examined.',
  'This is why rereading your own marginalia is so strange. You are not reviewing the book; you are reviewing a previous self in conversation with it, and the conversation often reads differently the second time.',
  'The practical upshot is simple. If you want reading to add up to something, give the small decisions somewhere to live. A highlight, a note, a sentence in your own words. The form matters less than the habit.',
  'None of this requires a system. Systems are what happens when a habit gets ambitious, and ambition is exactly the wrong mood for marginalia. The pen should feel closer to fidgeting than to filing.',
  'It helps to be unsentimental about the marks themselves. Most annotations are not insights; they are traces of attention, and traces are allowed to be ordinary. An underline that says only, I was here, and I noticed, is doing its job.',
  'The rare mark that turns out to matter usually announces itself later, when a second book argues with it. That argument is the real product of a reading life, and it cannot be scheduled. It can only be made more likely.',
  'Which is the quiet case for keeping everything in one place. Not because a pile of highlights is knowledge, but because proximity breeds collisions, and collisions are where the thinking happens.',
  'So: read with a pen, keep the traces, let them pile up where they can see each other. The rest takes care of itself, slowly, which is the only speed understanding has ever had.',
].map((p) => `<p>${p}</p>`);

/**
 * The sidebar names the signed-in account, and the seeded e2e handle
 * (testuser-<timestamp>.test) is not something a docs page should show.
 * Rewrite the stored auth identity before the app boots for the shot.
 */
async function prettifyAccount(page: Page) {
  await page.evaluate(() => {
    const raw = localStorage.getItem('skyreader-auth');
    if (!raw) return;
    const parsed = JSON.parse(raw);
    parsed.user.handle = 'reader.example.com';
    parsed.user.displayName = 'A. Reader';
    localStorage.setItem('skyreader-auth', JSON.stringify(parsed));
  });
}

async function seedLibrary(user: Parameters<typeof seedSubscription>[0]) {
  for (const feed of FEEDS) {
    await seedSubscription(user, { feedUrl: feed.url, title: feed.title });
    await seedFeedItems(
      feed.url,
      feed.items.map((item, i) => ({
        ...item,
        url: `https://${new URL(feed.url).hostname.replace('feed.', '')}/${item.guid}`,
        content: item.guid === 'annotation-thinking' ? READER_BODY.join('') : undefined,
        publishedAt: new Date(Date.now() - (i + FEEDS.indexOf(feed)) * 47 * 60_000).toISOString(),
      })),
      { title: feed.title }
    );
  }
}

async function cleanupLibrary() {
  for (const feed of FEEDS) await cleanupFeedItems(feed.url);
}

test.describe('Reading', () => {
  test('library, reader, paged mode', async ({ authedPage, testUser }) => {
    await seedLibrary(testUser);
    try {
      await prettifyAccount(authedPage);
      await authedPage.goto('/feeds');
      const card = authedPage.locator('.article-item-anchor', {
        has: authedPage.getByText('Annotation is thinking', { exact: true }),
      });
      await expect(card).toBeVisible({ timeout: 15_000 });
      await authedPage.evaluate(() => document.fonts.ready);
      await authedPage.screenshot({
        path: join(OUT_DIR, 'library.png'),
        animations: 'disabled',
      });
    } finally {
      await cleanupLibrary();
    }
  });

  test('daily magazine', async ({ authedPage, testUser }) => {
    const essays = [
      {
        url: 'https://example.com/essays/attention',
        title: 'The Reading Room: Notes on Attention',
        author: 'A. Reader',
        body: READER_BODY,
      },
      {
        url: 'https://example.com/essays/rereading',
        title: 'In Praise of Rereading',
        author: 'M. Page',
        body: [
          'The first read of a book is a negotiation. You are learning its vocabulary, its pace, what it expects of you.',
          'The second read is where the book actually happens. Freed from finding out what comes next, you can watch how it comes.',
        ].map((p) => `<p>${p}</p>`),
      },
    ];
    for (const essay of essays) {
      await seedSavedArticle(testUser, {
        url: essay.url,
        title: essay.title,
        author: essay.author,
        domain: 'example.com',
        contentType: 'article',
        content: essay.body.join(''),
        wordCount: 400,
      });
    }

    await authedPage.goto('/home');
    const generate = authedPage.getByRole('button', { name: 'Generate issue' });
    await expect(generate).toBeVisible({ timeout: 15_000 });
    await generate.click();
    await expect(
      authedPage.getByRole('heading', { name: 'Daily magazine', exact: true })
    ).toBeVisible({ timeout: 15_000 });
    await expect(authedPage.locator('.issue-article').first()).toBeVisible({ timeout: 15_000 });
    await authedPage.evaluate(() => document.fonts.ready);
    await authedPage.screenshot({
      path: join(OUT_DIR, 'daily-magazine.png'),
      animations: 'disabled',
    });
  });
});

// ── Saving and highlights ───────────────────────────────────────────────────

test.describe('Saving and highlights', () => {
  test('saved list and a highlight in the reader', async ({ authedPage, testUser }) => {
    const saves = [
      {
        url: 'https://example.com/essays/attention',
        title: 'The Reading Room: Notes on Attention',
        author: 'A. Reader',
        description: 'Reading well is not a matter of speed.',
      },
      {
        url: 'https://slowweb.example.com/against-skimming',
        title: 'What we lose when we skim',
        author: 'J. Lector',
        description:
          'Skimming optimizes for coverage; understanding optimizes for collisions between ideas.',
      },
      {
        url: 'https://commonplace.example.com/personal-libraries',
        title: 'A field guide to personal libraries',
        author: 'E. Stacks',
        description: 'What a shelf arranged by memory can do that a database cannot.',
      },
    ];
    for (const [i, save] of saves.entries()) {
      await seedSavedArticle(testUser, {
        ...save,
        domain: new URL(save.url).hostname,
        contentType: 'article',
        content: READER_BODY.join(''),
        wordCount: 400,
        savedAt: Date.now() - i * 3 * 60 * 60_000,
      });
    }

    await prettifyAccount(authedPage);
    await authedPage.goto('/saved');
    await expect(authedPage.getByText(saves[0].title)).toBeVisible({ timeout: 15_000 });
    await authedPage.evaluate(() => document.fonts.ready);
    await authedPage.screenshot({ path: join(OUT_DIR, 'saved.png'), animations: 'disabled' });

    // Into the full-screen reader.
    await authedPage.getByText(saves[0].title).first().click();
    const reader = authedPage.locator('.reader-overlay');
    await expect(reader).toBeVisible({ timeout: 15_000 });
    const body = authedPage.locator('.reader-body');
    await expect(body).toContainText('Annotation is usually', { timeout: 15_000 });
    await authedPage.evaluate(() => document.fonts.ready);
    await authedPage.screenshot({ path: join(OUT_DIR, 'reader.png'), animations: 'disabled' });

    // Paged mode: the same article as page turns, then back to scroll.
    await reader.getByTitle('Switch to paged view').filter({ visible: true }).click();
    await expect(
      reader.getByTitle('Switch to scroll view').filter({ visible: true })
    ).toBeVisible();
    await authedPage.waitForTimeout(500);
    await authedPage.screenshot({
      path: join(OUT_DIR, 'paged-reader.png'),
      animations: 'disabled',
    });
    await reader.getByTitle('Switch to scroll view').filter({ visible: true }).click();
    await expect(reader.getByTitle('Switch to paged view').filter({ visible: true })).toBeVisible();

    // A highlight: double-click the second paragraph, then write a note beside
    // it by clicking its bracket in the margin.
    await body.locator('p').nth(1).dblclick();
    await expect(body.locator('mark.highlight')).toBeVisible();
    await reader.getByRole('button', { name: 'Add a note' }).click();
    await authedPage.keyboard.type('the decisions are the understanding. keep the pen.');
    await authedPage.keyboard.press('Escape');
    const note = reader.locator('.rail-right .note-read');
    await expect(note).toBeVisible();
    // The passage and its note: the region spans the column and the margin.
    const first = body.locator('p').nth(0);
    const last = body.locator('p').nth(2);
    await first.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await authedPage.evaluate(() => document.fonts.ready);
    const [a, b, n] = await Promise.all([
      first.boundingBox(),
      last.boundingBox(),
      note.boundingBox(),
    ]);
    if (!a || !b || !n) throw new Error('Cannot measure region for highlight.png');
    const x = Math.max(0, a.x - 20);
    const y = Math.max(0, a.y - 20);
    await authedPage.screenshot({
      path: join(OUT_DIR, 'highlight.png'),
      animations: 'disabled',
      clip: { x, y, width: n.x + n.width + 20 - x, height: b.y + b.height + 20 - y },
    });
  });

  test('review deck', async ({ authedPage, testUser }) => {
    const exacts = [
      'A note in the margin is not decoration on top of reading; it is the visible part of the reading itself.',
      'Every mark is a small decision about what matters, and the decisions are the understanding.',
      'You are not reviewing the book; you are reviewing a previous self in conversation with it.',
      'If you want reading to add up to something, give the small decisions somewhere to live.',
      'The second read is where the book actually happens.',
    ];
    const rkey = await seedSavedArticle(testUser, {
      url: 'https://example.com/essays/attention',
      title: 'The Reading Room: Notes on Attention',
      domain: 'example.com',
      contentType: 'article',
      content: READER_BODY.join(''),
      wordCount: 400,
    });
    await seedItemLabel(testUser, {
      itemKey: `at://${testUser.did}/app.skyreader.feed.saved/${rkey}`,
      itemType: 'saved',
      label: 'highlights',
      props: JSON.stringify({
        highlights: exacts.map((exact, i) => ({
          id: `docs-shot-${i}`,
          createdAt: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString(),
          selector: { type: 'TextQuoteSelector', exact },
        })),
      }).replaceAll("'", "''"),
    });

    await prettifyAccount(authedPage);
    await authedPage.goto('/highlights/review');
    await expect(authedPage.getByText(/1 of \d+/)).toBeVisible({ timeout: 15_000 });
    await authedPage.evaluate(() => document.fonts.ready);
    await authedPage.screenshot({ path: join(OUT_DIR, 'review-deck.png'), animations: 'disabled' });
  });
});

// ── Adding sources ──────────────────────────────────────────────────────────

test.describe('Adding sources', () => {
  test('add feed: the discovery picker', async ({ authedPage }) => {
    // Discovery needs a live site to crawl, so it's stubbed with the shape the
    // docs describe: a standard.site publication listed first, RSS after it.
    await authedPage.route('**/api/v2/feeds/discover*', (route) =>
      route.fulfill({
        json: {
          feeds: [
            'https://commonplace.example.com/feed.xml',
            'https://commonplace.example.com/comments.xml',
          ],
          standardSite: {
            did: 'did:plc:docs-shots-site',
            publicationUri: 'at://did:plc:docs-shots-site/site.standard.publication/3ljcommonplace',
            name: 'The Commonplace',
            url: 'https://commonplace.example.com',
            description: 'Notes on reading, remembering, and the tools between.',
          },
        },
      })
    );

    await authedPage.goto('/feeds');
    await authedPage.locator('button.add-trigger[aria-label="Add source"]').click();
    const input = authedPage.getByPlaceholder('Paste URL or @handle...');
    await input.fill('commonplace.example.com');
    await input.press('Enter');

    const modal = authedPage.locator('.modal');
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await modal.locator('button.add-btn', { hasText: 'Add' }).click();
    await expect(modal.getByText('Multiple feeds found')).toBeVisible();
    await authedPage.evaluate(() => document.fonts.ready);
    await shootElement(authedPage, modal, 'add-feed.png');
  });
});

// ── Getting started ─────────────────────────────────────────────────────────

test.describe('Getting started', () => {
  test('the guest welcome page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Start Reading' }).first()).toBeVisible({
      timeout: 15_000,
    });
    // Let the hero's entrance animation settle before freezing the frame.
    await page.waitForTimeout(1_200);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(OUT_DIR, 'welcome.png'), animations: 'disabled' });
  });
});

// ── Your data ───────────────────────────────────────────────────────────────

test.describe('Your data', () => {
  test('settings: subscriptions and Atmospheric sync', async ({ authedPage }) => {
    await stubLinkblogApi(authedPage);
    await authedPage.goto('/settings');
    const card = authedPage.locator('#subscriptions');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await shootElement(authedPage, card, 'atmospheric-sync.png');
  });
});

// ── Reading rooms ───────────────────────────────────────────────────────────

// A room is a foreign Semble collection, read through the backend, with
// presence from Constellation and profiles from the Bluesky appview. None of
// that exists in the e2e stack, so every hop is stubbed: the shot shows a
// small, believable neighbourhood of rooms rather than a live one.

const ROOMS_PDS = 'https://pds.docs-shots.example';
const SEMBLE_DID = 'did:plc:4vjd3fe2cgzq5d24j4f3zvar';
const CLUB_DID = 'did:plc:docsshotsclub';
const CLUB_ROOM = `at://${CLUB_DID}/network.cosmik.collection/3docsshotsclub`;

// Cover art as inline SVG so the shots are deterministic and need no network.
const swatch = (bg: string, fg: string, glyph: string) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">` +
      `<rect width="120" height="120" fill="${bg}"/>` +
      `<text x="60" y="78" font-family="Georgia,serif" font-size="56" fill="${fg}" text-anchor="middle">${glyph}</text>` +
      `</svg>`
  );

const avatar = (bg: string, initial: string) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">` +
      `<rect width="80" height="80" fill="${bg}"/>` +
      `<text x="40" y="52" font-family="system-ui,sans-serif" font-size="36" fill="#fff" text-anchor="middle">${initial}</text>` +
      `</svg>`
  );

// Collections by rkey: the four featured rooms (real rkeys, so FEATURED_ROOM_URIS
// resolves) plus the club room the seeded reader has joined.
const COLLECTIONS: Record<string, { name: string; description: string }> = {
  '3munguoqf5x25': {
    name: 'How We Read Now',
    description: 'Essays on attention, screens, and what reading is becoming.',
  },
  '3mungyyxm2w2p': {
    name: 'Tools for Thought',
    description: 'Notation, memory, and the machines that hold them.',
  },
  '3munh3tsvbf2l': {
    name: 'The Open Web',
    description: 'Feeds, protocols, and publishing without a landlord.',
  },
  '3munh5zxdih2t': {
    name: 'The Craft',
    description: 'Writing about writing, for people who do it.',
  },
  '3docsshotsclub': {
    name: 'Slow Reading Club',
    description: 'One long essay a week, read together. No hurry.',
  },
};

const PEOPLE: Record<string, { handle: string; displayName: string; avatar: string }> = {
  [SEMBLE_DID]: { handle: 'semble.so', displayName: 'Semble', avatar: avatar('#2c5282', 'S') },
  [CLUB_DID]: {
    handle: 'mpage.example.com',
    displayName: 'M. Page',
    avatar: avatar('#7b341e', 'M'),
  },
  'did:plc:docsshotsjl': {
    handle: 'jlector.example.com',
    displayName: 'J. Lector',
    avatar: avatar('#276749', 'J'),
  },
  'did:plc:docsshotses': {
    handle: 'estacks.example.com',
    displayName: 'E. Stacks',
    avatar: avatar('#1f2933', 'E'),
  },
  'did:plc:docsshotsrq': {
    handle: 'rquire.example.com',
    displayName: 'R. Quire',
    avatar: avatar('#553c9a', 'R'),
  },
};

// Who is reading along where. The seeded reader follows J. Lector and E. Stacks,
// and (see stubRoomsWorld) has joined Tools for Thought and How We Read Now.
const READ_ALONGS: Record<string, string[]> = {
  [CLUB_ROOM]: [CLUB_DID, 'did:plc:docsshotsjl', 'did:plc:docsshotses', 'did:plc:docsshotsrq'],
  [`at://${SEMBLE_DID}/network.cosmik.collection/3mungyyxm2w2p`]: ['did:plc:docsshotsrq'],
  [`at://${SEMBLE_DID}/network.cosmik.collection/3munguoqf5x25`]: ['did:plc:docsshotsjl'],
  [`at://${SEMBLE_DID}/network.cosmik.collection/3munh5zxdih2t`]: ['did:plc:docsshotsrq', CLUB_DID],
  [`at://${SEMBLE_DID}/network.cosmik.collection/3munh3tsvbf2l`]: ['did:plc:docsshotsrq'],
};

const CLUB_ITEMS = [
  {
    url: 'https://commonplace.example.com/annotation-thinking',
    title: 'Annotation is thinking',
    author: 'A. Reader',
    description:
      'Writing in the margins is not a record of reading. It is the reading, slowed down enough to notice itself.',
    image: swatch('#1f2933', '#f5f7fa', '¶'),
    readCount: 3,
  },
  {
    url: 'https://slowweb.example.com/against-skimming',
    title: 'What we lose when we skim',
    author: 'J. Lector',
    description:
      'Skimming optimizes for coverage. Understanding optimizes for collisions between ideas, and collisions take time.',
    image: swatch('#7b341e', '#fff5f0', '§'),
    readCount: 2,
  },
  {
    url: 'https://commonplace.example.com/personal-libraries',
    title: 'A field guide to personal libraries',
    author: 'E. Stacks',
    description:
      'What a shelf arranged by memory can do that a database cannot, and where the database quietly wins.',
    image: swatch('#2c5282', '#ebf4ff', '†'),
    readCount: 1,
  },
  {
    url: 'https://slowweb.example.com/paper-and-glass',
    title: 'Reading on paper, reading on glass',
    author: 'M. Page',
    description:
      'The screen is winning on convenience. The interesting question is what paper still knows that software has not learned.',
    image: swatch('#276749', '#f0fff4', '‡'),
    readCount: 0,
  },
];

function myReadAlongs(did: string): string[] {
  return Object.entries(READ_ALONGS)
    .filter(([, dids]) => dids.includes(did))
    .map(([subject]) => subject);
}

async function stubRoomsWorld(page: Page, selfDid: string) {
  const self = {
    handle: 'reader.example.com',
    displayName: 'A. Reader',
    avatar: avatar('#0066cc', 'A'),
  };
  const person = (did: string) => (did === selfDid ? self : PEOPLE[did]);
  const readAlongRecords = (did: string) =>
    myReadAlongs(did).map((subject, i) => ({
      uri: `at://${did}/app.skyreader.reading.readAlong/3docsshots${i}`,
      value: { subject, createdAt: '2026-09-01T12:00:00.000Z' },
    }));
  // The seeded reader has joined Tools for Thought and How We Read Now, but
  // not the club: the room shot shows the join moment.
  for (const rkey of ['3mungyyxm2w2p', '3munguoqf5x25']) {
    const subject = `at://${SEMBLE_DID}/network.cosmik.collection/${rkey}`;
    READ_ALONGS[subject] = [selfDid, ...READ_ALONGS[subject].filter((d) => d !== selfDid)];
  }

  // DID → PDS, for every account the page resolves.
  await page.route('https://plc.directory/**', (route) =>
    route.fulfill({
      json: {
        service: [
          { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: ROOMS_PDS },
        ],
      },
    })
  );

  // Own readAlong records, read off a PDS (the seeded user's is bsky.social).
  await page.route('**/xrpc/com.atproto.repo.listRecords?*', (route) => {
    const url = new URL(route.request().url());
    const repo = url.searchParams.get('repo') ?? '';
    const collection = url.searchParams.get('collection');
    if (collection !== 'app.skyreader.reading.readAlong')
      return route.fulfill({ json: { records: [] } });
    return route.fulfill({ json: { records: readAlongRecords(repo) } });
  });

  // Collection records, for the index rows' names and descriptions.
  await page.route('**/xrpc/com.atproto.repo.getRecord?*', (route) => {
    const url = new URL(route.request().url());
    const rkey = url.searchParams.get('rkey') ?? '';
    const meta = COLLECTIONS[rkey];
    if (!meta) return route.fulfill({ status: 404, json: { error: 'RecordNotFound' } });
    return route.fulfill({ json: { uri: '', cid: '', value: meta } });
  });

  // Constellation: who is reading along, and how many.
  await page.route('https://constellation.microcosm.blue/links/count/distinct-dids?*', (route) => {
    const target = new URL(route.request().url()).searchParams.get('target') ?? '';
    return route.fulfill({ json: { total: (READ_ALONGS[target] ?? []).length } });
  });
  await page.route('https://constellation.microcosm.blue/links/distinct-dids?*', (route) => {
    const target = new URL(route.request().url()).searchParams.get('target') ?? '';
    return route.fulfill({ json: { linking_dids: READ_ALONGS[target] ?? [] } });
  });

  // Bluesky appview: profiles and the follow graph.
  await page.route('https://public.api.bsky.app/xrpc/app.bsky.actor.getProfiles?*', (route) => {
    const actors = new URL(route.request().url()).searchParams.getAll('actors');
    return route.fulfill({
      json: {
        profiles: actors.flatMap((did) => {
          const p = person(did);
          return p ? [{ did, ...p }] : [];
        }),
      },
    });
  });
  await page.route('https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?*', (route) => {
    const did = new URL(route.request().url()).searchParams.get('actor') ?? '';
    const p = person(did);
    return p ? route.fulfill({ json: { did, ...p } }) : route.fulfill({ status: 404, json: {} });
  });
  await page.route('https://public.api.bsky.app/xrpc/app.bsky.graph.getFollows?*', (route) =>
    route.fulfill({
      json: {
        follows: ['did:plc:docsshotsjl', 'did:plc:docsshotses'].map((did) => ({
          did,
          ...PEOPLE[did],
        })),
      },
    })
  );

  // Favicons: the rows fall back to a letter mark without one, so give every
  // domain the same quiet glyph rather than asking Google.
  await page.route('https://www.google.com/s2/favicons?*', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="6" fill="#e2e8f0"/><circle cx="16" cy="16" r="6" fill="#4a5568"/></svg>`,
    })
  );

  // The backend's room read: the club's articles with their read counts.
  await page.route('**/api/rooms?uri=*', (route) => {
    const target = new URL(route.request().url()).searchParams.get('uri') ?? '';
    if (target !== CLUB_ROOM) return route.fulfill({ status: 404, json: { error: 'not found' } });
    return route.fulfill({
      json: {
        uri: CLUB_ROOM,
        provider: 'semble',
        ownerDid: CLUB_DID,
        name: COLLECTIONS['3docsshotsclub'].name,
        description: COLLECTIONS['3docsshotsclub'].description,
        canAdd: true,
        complete: true,
        items: CLUB_ITEMS.map((item, i) => ({
          ...item,
          urlNormalized: item.url,
          itemType: 'network.cosmik.card',
          addedAt: new Date(Date.UTC(2026, 7, 20 + i)).toISOString(),
          readByMe: false,
        })),
      },
    });
  });
  await page.route('**/api/rooms/join?uri=*', (route) =>
    route.fulfill({ json: { joined: false } })
  );
}

test.describe('Reading rooms', () => {
  // The index stacks the explainer, the open box and three sections; a taller
  // viewport keeps the whole neighbourhood in one shot.
  test.use({ viewport: { width: 1200, height: 1180 } });

  test('a room, then the rooms index', async ({ authedPage, testUser }) => {
    await stubRoomsWorld(authedPage, testUser.did);
    await prettifyAccount(authedPage);

    // The room first: opening it also writes the snapshot the index tiles its
    // cover art from, so the club row on the index shows what's in it.
    await authedPage.goto(`/rooms?uri=${encodeURIComponent(CLUB_ROOM)}`);
    await expect(authedPage.getByRole('heading', { name: 'Slow Reading Club' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(authedPage.getByText('4 reading along')).toBeVisible({ timeout: 15_000 });
    await expect(authedPage.locator('.room-avatar')).toHaveCount(4);
    await expect(authedPage.getByText('View collection on Semble')).toBeVisible();
    await expect(authedPage.getByText('3 read this')).toBeVisible();
    await authedPage.evaluate(() => document.fonts.ready);
    await authedPage.waitForTimeout(300);
    await shootRegion(
      authedPage,
      authedPage.locator('.room-back'),
      authedPage.locator('.room-list > li').last(),
      'room.png'
    );

    // Then the index: two joined rooms, the club where the follows are, the rest featured.
    await authedPage.getByRole('link', { name: 'All rooms' }).click();
    await expect(authedPage.getByRole('heading', { name: 'Your rooms' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      authedPage.getByRole('heading', { name: 'Where people you follow are reading' })
    ).toBeVisible({ timeout: 15_000 });
    await expect(authedPage.getByRole('heading', { name: 'Featured rooms' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(authedPage.getByText('The Craft')).toBeVisible();
    await expect(authedPage.getByText('Slow Reading Club')).toBeVisible();
    await expect(authedPage.getByText('2 reading along').first()).toBeVisible({ timeout: 15_000 });
    await authedPage.evaluate(() => document.fonts.ready);
    await authedPage.waitForTimeout(300);
    await shootRegion(
      authedPage,
      authedPage.locator('.room-intro'),
      authedPage.locator('.room-list').last().locator('> li').last(),
      'rooms.png'
    );

    // Starting a room: the disclosure under the open box, opened, with the
    // Semble defaults showing (closed access, description offered).
    await authedPage.getByRole('button', { name: 'Start a new room' }).click();
    const form = authedPage.getByRole('form', { name: 'Start a new room' });
    await expect(form).toBeVisible();
    await form.getByPlaceholder('What the room is reading').fill('Long Essays, Slowly');
    await form
      .getByPlaceholder('A line about the room, for people deciding whether to read along')
      .fill('One long piece a week. Take your time.');
    await authedPage.evaluate(() => document.fonts.ready);
    await authedPage.waitForTimeout(300);
    await shootElement(authedPage, form, 'room-create.png');
  });
});
