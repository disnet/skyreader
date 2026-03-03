import { Command } from 'commander';
import { Defuddle } from 'defuddle/node';
import { getClient } from '../client.js';
import { outputJson } from '../output.js';

interface SavedArticle {
  rkey: string;
  uri?: string;
  url: string;
  title?: string;
  author?: string;
  description?: string;
  content?: string;
  domain?: string;
  savedAt?: string;
  source?: string;
  wordCount?: number;
  itemGuid?: string;
}

interface SavedResponse {
  articles: SavedArticle[];
}

interface LabelEntry {
  itemKey: string;
  label: string;
}

interface LabelsResponse {
  labels: LabelEntry[];
  cursor?: string;
}

async function getArchivedKeys(client: ReturnType<typeof getClient>): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ label: 'archived', limit: '500' });
    if (cursor) params.set('cursor', cursor);
    const data = await client.get<LabelsResponse>(`/api/labels?${params}`);
    for (const l of data.labels) {
      keys.add(l.itemKey);
    }
    cursor = data.cursor;
  } while (cursor);
  return keys;
}

function articleKey(a: SavedArticle): string {
  return a.uri || a.itemGuid || '';
}

async function defuddleHtml(html: string, url?: string): Promise<string | undefined> {
  try {
    const result = await Defuddle(html, url, { markdown: true });
    return result.content || undefined;
  } catch {
    return undefined;
  }
}

async function fetchAndExtract(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const html = await res.text();
    return defuddleHtml(html, url);
  } catch {
    return undefined;
  }
}

export const savedCommand = new Command('saved')
  .description('List saved articles')
  .option('--all', 'Show all saved articles (inbox + archive)')
  .option('--archive', 'Show only archived articles')
  .option('--content', 'Include article content in output')
  .option('--json', 'Output as JSON')
  .action(async (opts: { all?: boolean; archive?: boolean; content?: boolean; json?: boolean }) => {
    const client = getClient();
    const data = await client.get<SavedResponse>('/api/saved');

    let articles = data.articles;

    const archivedKeys = await getArchivedKeys(client);
    if (opts.archive) {
      articles = articles.filter((a) => archivedKeys.has(articleKey(a)));
    } else if (!opts.all) {
      articles = articles.filter((a) => !archivedKeys.has(articleKey(a)));
    }

    if (opts.json) {
      outputJson(articles);
    } else {
      if (articles.length === 0) {
        process.stdout.write('No saved articles.\n');
        return;
      }
      for (const a of articles) {
        const date = a.savedAt ? new Date(a.savedAt).toLocaleDateString() : '';
        process.stdout.write(`- ${a.title || '(untitled)'}\n`);
        if (a.url) process.stdout.write(`  ${a.url}\n`);
        if (date) process.stdout.write(`  ${date}`);
        if (a.author) process.stdout.write(`  by ${a.author}`);
        if (a.domain) process.stdout.write(`  [${a.domain}]`);
        if (date || a.author || a.domain) process.stdout.write('\n');

        if (opts.content) {
          let text: string | undefined;
          if (a.content) {
            text = await defuddleHtml(a.content, a.url);
          } else if (a.url) {
            text = await fetchAndExtract(a.url);
          }
          if (!text && a.description) {
            text = await defuddleHtml(a.description, a.url);
          }
          if (text) {
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
  });
