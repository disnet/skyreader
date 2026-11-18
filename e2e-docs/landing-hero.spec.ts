// The landing page's hero: the whole app, as a reader sees it, in light and
// dark. Rides the docs-shots stack (`npm run shots:docs`), but writes into the
// frontend's static assets, since the landing page serves it. The feeds are
// real; the test user's handle is swapped for a reserved one.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../e2e/fixtures';
import { seedSubscription, seedFeedItems, cleanupFeedItems, seedChannel } from '../e2e/seed';

const OUT_DIR = join(import.meta.dirname, '../frontend/static/landing');
mkdirSync(OUT_DIR, { recursive: true });

// Real publications, with articles each one actually ran (titles, links, dates
// and summaries from its own feed), so the sidebar wears their real favicons.
// Picked for a reader who reads to understand: attention, notebooks, libraries.
// Summaries only, as a feed reader shows them; no article bodies.
type Item = { guid: string; title: string; summary: string; url: string; date: string };
const FEEDS: { key: string; url: string; title: string; items: Item[] }[] = [
  {
    key: 'marginalian',
    url: 'https://www.themarginalian.org/feed/',
    title: 'The Marginalian',
    items: [
      {
        guid: 'susan-orlean',
        title:
          'Embrace Your Obsessions: Susan Orlean on the Antidote to the Meaninglessness of Life',
        summary:
          'Every great book, whatever its subject or genre or style, is about one thing only: the eternal question of what gives meaning to our tiny, transient lives. And every answer given, however faintly whispered, points to one thing only: the quality of attention we pay to those lives.',
        url: 'https://www.themarginalian.org/2026/11/14/susan-orlean-orchid-thief/',
        date: '2026-11-14T14:31:26Z',
      },
    ],
  },
  {
    key: 'aeon',
    url: 'https://aeon.co/feed.rss',
    title: 'Aeon',
    items: [
      {
        guid: 'why-anything-exists',
        title: 'Why anything exists',
        summary:
          'Here’s a new answer to the old question ‘why is there something rather than nothing?’ (It’s neither simple nor easy.)',
        url: 'https://aeon.co/essays/a-new-answer-to-why-there-is-something-rather-than-nothing',
        date: '2026-11-12T11:00:00Z',
      },
    ],
  },
  {
    key: 'kleon',
    url: 'https://austinkleon.com/feed/',
    title: 'Austin Kleon',
    items: [
      {
        guid: 'grant-snider',
        title: 'Typewriter interview with Grant Snider',
        summary: 'My latest typewriter interview is with cartoonist Grant Snider.',
        url: 'https://austinkleon.com/2026/11/12/typewriter-interview-with-grant-snider/',
        date: '2026-11-12T18:18:20Z',
      },
    ],
  },
  {
    key: 'appleton',
    url: 'https://maggieappleton.com/rss.xml',
    title: 'Maggie Appleton',
    items: [
      {
        guid: 'fortune-telling',
        title: 'Fortune Telling and Speculative Design',
        summary:
          'Practical tools for design engineers to explore possible futures through speculative design.',
        url: 'https://maggieappleton.com/fortune-telling',
        date: '2026-11-04T00:00:00Z',
      },
    ],
  },
  {
    key: 'pdr',
    url: 'https://publicdomainreview.org/rss.xml',
    title: 'The Public Domain Review',
    items: [
      {
        guid: 'wonderful-weather',
        title: 'Wonderful Weather: Floods and Foreboding in 17th-Century Britain',
        summary:
          'When the Bristol Channel flooded in 1607, it was not just one of the worst natural disasters in British history, it was also a sign, for many, that they had strayed from the path of God.',
        url: 'https://publicdomainreview.org/essay/wonderful-weather',
        date: '2026-10-28T15:47:00Z',
      },
    ],
  },
  {
    key: 'signal',
    url: 'https://blogs.loc.gov/thesignal/feed/',
    title: 'The Signal',
    items: [
      {
        guid: 'embedded-catalog',
        title: 'AI Sandbox Series: The Embedded Catalog',
        summary:
          'The latest in a series on the Library of Congress’s AI Sandbox: experiments in text recognition and searchability, metadata, and more.',
        url: 'https://blogs.loc.gov/thesignal/2026/10/ai-sandbox-series-embedded-catalog/',
        date: '2026-10-26T17:41:42Z',
      },
      {
        guid: 'preserving-more-than-the-web',
        title:
          'Preserving More Than the Web: Building an Archive of Online Resources for Preservation and Conservation',
        summary:
          'How web archiving is supporting the work of conservators and preservation scientists at the Library, and how the archive can help future researchers understand the history of the field.',
        url: 'https://blogs.loc.gov/thesignal/2026/10/preserving-more-than-the-web-building-an-archive-of-online-resources-for-preservation-and-conservation/',
        date: '2026-10-22T15:30:21Z',
      },
    ],
  },
  {
    key: 'mod',
    url: 'https://craigmod.com/index.xml',
    title: 'Craig Mod',
    items: [
      {
        guid: 'notebook-fit-for-a-walk',
        title: '[RIDGELINE] A Notebook Fit for a Walk',
        summary:
          'I made a notebook. I didn’t mean to make a notebook but, you see, I had no choice.',
        url: 'https://craigmod.com/ridgeline/237/',
        date: '2026-10-19T00:00:00Z',
      },
    ],
  },
];

// A few channels, so the sidebar looks like a reader's, not a fresh account's.
// Each names the feeds it reads from, so their counts differ the way a reader's would.
const CHANNELS = [
  { name: 'Essays', feeds: ['marginalian', 'aeon', 'pdr'] },
  { name: 'Libraries & archives', feeds: ['signal', 'pdr'] },
  { name: 'Notebooks', feeds: ['mod', 'kleon'] },
  { name: 'Design', feeds: ['appleton'] },
];

const SHOTS = [
  { name: 'desktop', viewport: { width: 1440, height: 860 }, scale: 2 },
  { name: 'phone', viewport: { width: 390, height: 760 }, scale: 3 },
] as const;

for (const shot of SHOTS) {
  test.describe(`Landing, ${shot.name}`, () => {
    test.use({ viewport: shot.viewport, deviceScaleFactor: shot.scale });

    for (const scheme of ['light', 'dark'] as const) {
      test(`the app, ${scheme}`, async ({ authedPage, testUser }) => {
        const rkeys = new Map<string, string>();
        for (const feed of FEEDS) {
          const rkey = await seedSubscription(testUser, { feedUrl: feed.url, title: feed.title });
          rkeys.set(feed.key, rkey);
          await seedFeedItems(
            feed.url,
            feed.items.map(({ date, ...item }) => ({ ...item, publishedAt: date })),
            { title: feed.title }
          );
        }
        for (const [i, channel] of CHANNELS.entries()) {
          await seedChannel(testUser, {
            uuid: `00000000-0000-4000-8000-0000000000${String(i + 1).padStart(2, '0')}`,
            name: channel.name,
            config: {
              readFilter: 'all',
              sortOrder: 'newest',
              sourceMode: 'include',
              sourceKeys: channel.feeds.map((f) => `rss~${rkeys.get(f)}`),
            },
            position: i,
          });
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
          await expect(authedPage.getByText(FEEDS[0].items[0].title).first()).toBeVisible({
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
