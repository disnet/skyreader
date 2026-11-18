// The landing page's hero: the whole app, as a reader sees it, in light and
// dark. Rides the docs-shots stack (`npm run shots:docs`), but writes into the
// frontend's static assets, since the landing page serves it. Every feed, title
// and handle here is a sample; the handle is swapped for a reserved one.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../e2e/fixtures';
import { seedSubscription, seedFeedItems, cleanupFeedItems } from '../e2e/seed';

const OUT_DIR = join(import.meta.dirname, '../frontend/static/landing');
mkdirSync(OUT_DIR, { recursive: true });

const FEEDS = [
  {
    url: 'https://longhand.example/feed.xml',
    title: 'Longhand',
    items: [
      [
        'the-library',
        'The Library Is Not a Warehouse',
        'A library isn’t measured by what it holds, but by what its readers can find again.',
      ],
      [
        'slow-notes',
        'Notes kept slowly',
        'Why the best notebooks are the ones you reread, not the ones you fill.',
      ],
    ],
  },
  {
    url: 'https://fieldnotes.example/feed.xml',
    title: 'Field Notes',
    items: [
      [
        'searchable',
        'Searchable by Default',
        'How often we go looking for old notes, and what we do when we find them.',
      ],
      [
        'margins',
        'A short history of the margin',
        'Readers have argued with books in their margins for as long as there have been margins.',
      ],
    ],
  },
  {
    url: 'https://weeknotes.example/feed.xml',
    title: 'Weeknotes',
    items: [
      [
        'weeknotes-112',
        'Weeknotes 112: the garden, the move',
        'Boxes, tomatoes, and a reading list that survived both.',
      ],
    ],
  },
  {
    url: 'https://typesetter.example/feed.xml',
    title: 'The Typesetter',
    items: [
      [
        'measure',
        'Measure, leading, and the comfortable line',
        'Sixty-six characters is not a rule. It is a description of where most eyes stop straining.',
      ],
      [
        'quiet-pages',
        'In praise of quiet pages',
        'What a page leaves out is half of what makes it easy to read.',
      ],
    ],
  },
  {
    url: 'https://cityriver.example/feed.xml',
    title: 'City & River',
    items: [
      [
        'floods',
        'How cities remember floods',
        'Watermarks on old walls are a city’s footnotes. Most of us walk past them.',
      ],
    ],
  },
] as const;

const LIBRARY_BODY = [
  'We keep talking about libraries as if their job were storage: more shelves, more square feet, more of everything kept somewhere.',
  'But storage was never the point. A library isn’t measured by what it holds, but by what its readers can find again. Everything else is a warehouse with better lighting.',
  'The same is true of a reading life. The articles we meant to come back to, the line we underlined on a train, the argument we half remembered in a meeting: what matters is whether any of it can be found when we need it.',
  'That asks for very little. Somewhere to keep the passage, a word about why it mattered, and a way back to it. The rest is habit.',
]
  .map((p) => `<p>${p}</p>`)
  .join('');

const SHOTS = [
  { name: 'desktop', viewport: { width: 1440, height: 860 }, scale: 2 },
  { name: 'phone', viewport: { width: 390, height: 760 }, scale: 3 },
] as const;

for (const shot of SHOTS) {
  test.describe(`Landing, ${shot.name}`, () => {
    test.use({ viewport: shot.viewport, deviceScaleFactor: shot.scale });

    for (const scheme of ['light', 'dark'] as const) {
      test(`the app, ${scheme}`, async ({ authedPage, testUser }) => {
        let n = 0;
        for (const feed of FEEDS) {
          await seedSubscription(testUser, { feedUrl: feed.url, title: feed.title });
          await seedFeedItems(
            feed.url,
            feed.items.map(([guid, title, summary]) => ({
              guid,
              title,
              summary,
              url: `https://${new URL(feed.url).hostname}/${guid}`,
              content: guid === 'the-library' ? LIBRARY_BODY : undefined,
              publishedAt: new Date(Date.now() - (n++ * 53 + 12) * 60_000).toISOString(),
            })),
            { title: feed.title }
          );
        }
        try {
          await authedPage.emulateMedia({ colorScheme: scheme });
          await authedPage.evaluate(() => {
            const raw = localStorage.getItem('skyreader-auth');
            if (!raw) return;
            const parsed = JSON.parse(raw);
            parsed.user.handle = 'reader.example.com';
            parsed.user.displayName = 'A. Reader';
            localStorage.setItem('skyreader-auth', JSON.stringify(parsed));
          });
          await authedPage.goto('/feeds');
          await expect(authedPage.getByText('The Library Is Not a Warehouse').first()).toBeVisible({
            timeout: 15_000,
          });
          // The one-time "links from people you follow" offer isn't the app.
          const notNow = authedPage.getByRole('button', { name: 'Not now' });
          if (await notNow.isVisible()) await notNow.click();
          const expand = authedPage.getByRole('button', { name: 'Expand' });
          if (await expand.isVisible()) await expand.click();
          // The account menu reads the handle from the session, not from
          // localStorage, so swap the test user's generated handle in place.
          await authedPage.evaluate(() => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              if (node.nodeValue?.includes('@testuser')) node.nodeValue = '@reader.example.com';
            }
          });
          await authedPage.evaluate(() => document.fonts.ready);
          await authedPage.waitForTimeout(500);
          await authedPage.screenshot({
            path: join(OUT_DIR, `app-${shot.name}-${scheme}.jpg`),
            type: 'jpeg',
            quality: 82,
            animations: 'disabled',
          });
        } finally {
          for (const feed of FEEDS) await cleanupFeedItems(feed.url);
        }
      });
    }
  });
}
