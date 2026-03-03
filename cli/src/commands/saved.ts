import { Command } from 'commander';
import { getClient } from '../client.js';
import { outputJson, outputTable } from '../output.js';

interface SavedArticle {
  rkey: string;
  url: string;
  title?: string;
  author?: string;
  description?: string;
  domain?: string;
  savedAt?: string;
  source?: string;
}

interface SavedResponse {
  articles: SavedArticle[];
}

export const savedCommand = new Command('saved')
  .description('List saved articles')
  .option('--json', 'Output as JSON')
  .action(async (opts: { json?: boolean }) => {
    const client = getClient();
    const data = await client.get<SavedResponse>('/api/saved');

    if (opts.json) {
      outputJson(data.articles);
    } else {
      const rows = data.articles.map((a) => ({
        title: a.title || '(untitled)',
        url: a.url,
        domain: a.domain || '',
        saved: a.savedAt ? new Date(a.savedAt).toLocaleDateString() : '',
      }));
      outputTable(rows, ['title', 'url', 'domain', 'saved']);
    }
  });
