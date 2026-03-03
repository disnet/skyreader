import { Command } from 'commander';
import { getClient } from '../client.js';
import { outputJson, outputTable } from '../output.js';

interface SubscriptionRecord {
  uri: string;
  cid: string;
  value: {
    feedUrl: string;
    title?: string;
    customTitle?: string;
    sourceType?: string;
    createdAt?: string;
  };
}

interface RecordsResponse {
  records: SubscriptionRecord[];
}

export const subscriptionsCommand = new Command('subscriptions')
  .description('List feed subscriptions')
  .option('--json', 'Output as JSON')
  .action(async (opts: { json?: boolean }) => {
    const client = getClient();
    const data = await client.get<RecordsResponse>(
      '/api/records/list?collection=app.skyreader.feed.subscription'
    );

    if (opts.json) {
      outputJson(data.records);
    } else {
      const rows = data.records.map((r) => ({
        title: r.value.customTitle || r.value.title || '(untitled)',
        url: r.value.feedUrl,
        type: r.value.sourceType || 'feed',
      }));
      outputTable(rows, ['title', 'url', 'type']);
    }
  });
