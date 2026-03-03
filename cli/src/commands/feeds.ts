import { Command } from 'commander';
import { getClient } from '../client.js';
import { outputJson } from '../output.js';
import { htmlToText } from '../html-to-text.js';

interface FeedItem {
  guid: string;
  title?: string;
  url?: string;
  link?: string;
  publishedAt?: string;
  pubDate?: string;
  description?: string;
  content?: string;
  summary?: string;
  author?: string;
}

interface FeedResponse {
  title?: string;
  description?: string;
  siteUrl?: string;
  items: FeedItem[];
}

interface BatchFeedEntry {
  title?: string;
  items: FeedItem[];
  status?: string;
  error?: string;
}

interface BatchResponse {
  feeds: Record<string, BatchFeedEntry>;
}

interface SubscriptionRecord {
  value: { feedUrl: string; title?: string; customTitle?: string; sourceType?: string };
}

interface RecordsResponse {
  records: SubscriptionRecord[];
}

interface ReadPosition {
  item_guid: string;
}

interface ReadPositionsResponse {
  positions: ReadPosition[];
}

export const feedsCommand = new Command('feeds')
  .description('Fetch feed articles')
  .argument('[url]', 'Feed URL to fetch (omit for all subscriptions)')
  .option('--all', 'Fetch all subscribed feeds')
  .option('--limit <n>', 'Max items per feed', '20')
  .option('--content', 'Include article content in output')
  .option('--unread', 'Only show unread articles')
  .option('--since <date>', 'Only show articles published after this date (e.g. 2024-01-01, "3 days ago")')
  .option('--json', 'Output as JSON')
  .action(
    async (
      url: string | undefined,
      opts: { all?: boolean; limit: string; content?: boolean; unread?: boolean; since?: string; json?: boolean }
    ) => {
      const client = getClient();
      const limit = parseInt(opts.limit, 10);

      // Build read GUIDs set if filtering by unread
      let readGuids: Set<string> | null = null;
      if (opts.unread) {
        const data = await client.get<ReadPositionsResponse>('/api/reading/positions');
        readGuids = new Set(data.positions.map((p) => p.item_guid));
      }

      // Parse --since date
      let sinceDate: Date | null = null;
      if (opts.since) {
        sinceDate = parseSinceDate(opts.since);
        if (isNaN(sinceDate.getTime())) {
          process.stderr.write(`Invalid date: ${opts.since}\n`);
          process.exit(1);
        }
      }

      if (url) {
        // Single feed
        const data = await client.get<FeedResponse>(
          `/api/v2/feeds/fetch?url=${encodeURIComponent(url)}&limit=${limit}`
        );

        const filtered = filterItems(data.items, readGuids, sinceDate);

        if (opts.json) {
          outputJson({ ...data, items: filtered });
        } else {
          process.stdout.write(`${data.title || url}\n\n`);
          outputArticles(filtered, opts.content);
        }
      } else if (opts.all) {
        // All subscribed feeds
        const subs = await client.get<RecordsResponse>(
          '/api/records/list?collection=app.skyreader.feed.subscription'
        );

        const feedUrls = subs.records
          .filter((r) => !r.value.sourceType || r.value.sourceType === 'feed')
          .map((r) => ({ url: r.value.feedUrl, limit }));

        if (feedUrls.length === 0) {
          process.stderr.write('No feed subscriptions found.\n');
          process.exit(0);
        }

        const data = await client.post<BatchResponse>('/api/v2/feeds/batch', {
          feeds: feedUrls,
        });

        if (opts.json) {
          // Apply filters to JSON output too
          const filteredData: BatchResponse = { feeds: {} };
          for (const [feedUrl, feed] of Object.entries(data.feeds)) {
            if (feed.error) {
              filteredData.feeds[feedUrl] = feed;
            } else {
              filteredData.feeds[feedUrl] = { ...feed, items: filterItems(feed.items, readGuids, sinceDate) };
            }
          }
          outputJson(filteredData);
        } else {
          for (const [feedUrl, feed] of Object.entries(data.feeds)) {
            if (feed.error) {
              process.stderr.write(`[error] ${feedUrl}: ${feed.error}\n`);
              continue;
            }
            const filtered = filterItems(feed.items, readGuids, sinceDate);
            process.stdout.write(`\n## ${feed.title || feedUrl}\n\n`);
            outputArticles(filtered, opts.content);
          }
        }
      } else {
        process.stderr.write('Provide a feed URL or use --all to fetch all subscriptions.\n');
        process.exit(1);
      }
    }
  );

function filterItems(
  items: FeedItem[],
  readGuids: Set<string> | null,
  sinceDate: Date | null
): FeedItem[] {
  let filtered = items;
  if (readGuids) {
    filtered = filtered.filter((item) => !readGuids.has(item.guid));
  }
  if (sinceDate) {
    const sinceTime = sinceDate.getTime();
    filtered = filtered.filter((item) => {
      const dateStr = item.publishedAt || item.pubDate;
      if (!dateStr) return false;
      return new Date(dateStr).getTime() >= sinceTime;
    });
  }
  return filtered;
}

function parseSinceDate(input: string): Date {
  // Try direct date parse first (ISO, common formats)
  const direct = new Date(input);
  if (!isNaN(direct.getTime())) return direct;

  // Try relative date patterns like "3 days ago", "1 week ago"
  const match = input.match(/^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/i);
  if (match) {
    const amount = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const now = new Date();
    switch (unit) {
      case 'minute':
        now.setMinutes(now.getMinutes() - amount);
        break;
      case 'hour':
        now.setHours(now.getHours() - amount);
        break;
      case 'day':
        now.setDate(now.getDate() - amount);
        break;
      case 'week':
        now.setDate(now.getDate() - amount * 7);
        break;
      case 'month':
        now.setMonth(now.getMonth() - amount);
        break;
      case 'year':
        now.setFullYear(now.getFullYear() - amount);
        break;
    }
    return now;
  }

  // Try "today" and "yesterday"
  if (input.toLowerCase() === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (input.toLowerCase() === 'yesterday') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // Return invalid date to trigger error
  return new Date('invalid');
}

function outputArticles(items: FeedItem[], showContent?: boolean): void {
  if (!items || items.length === 0) {
    process.stdout.write('  (no articles)\n');
    return;
  }
  for (const item of items) {
    const dateStr = item.publishedAt || item.pubDate;
    const date = dateStr ? new Date(dateStr).toLocaleDateString() : '';
    const link = item.url || item.link;
    process.stdout.write(`- ${item.title || '(untitled)'}\n`);
    if (link) process.stdout.write(`  ${link}\n`);
    if (date) process.stdout.write(`  ${date}`);
    if (item.author) process.stdout.write(`  by ${item.author}`);
    if (date || item.author) process.stdout.write('\n');

    if (showContent) {
      const raw = item.content || item.summary || item.description;
      if (raw) {
        const text = htmlToText(raw);
        process.stdout.write('\n');
        process.stdout.write(
          text
            .split('\n')
            .map((line) => `  ${line}`)
            .join('\n')
        );
        process.stdout.write('\n\n');
      }
    }
  }
}
