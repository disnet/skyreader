import { Command } from 'commander';
import { getClient } from '../client.js';
import { outputJson } from '../output.js';

interface MeResponse {
  did: string;
  handle: string;
  displayName?: string;
  avatarUrl?: string;
  pdsUrl?: string;
  tier?: string;
}

export const whoamiCommand = new Command('whoami')
  .description('Show current user info')
  .option('--json', 'Output as JSON')
  .action(async (opts: { json?: boolean }) => {
    const client = getClient();
    const me = await client.get<MeResponse>('/api/auth/me');

    if (opts.json) {
      outputJson(me);
    } else {
      process.stdout.write(`Handle:  ${me.handle}\n`);
      process.stdout.write(`DID:     ${me.did}\n`);
      if (me.displayName) process.stdout.write(`Name:    ${me.displayName}\n`);
      if (me.tier) process.stdout.write(`Tier:    ${me.tier}\n`);
    }
  });
