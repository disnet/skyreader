#!/usr/bin/env node
import { Command } from 'commander';
import { loginCommand } from './commands/login.js';
import { whoamiCommand } from './commands/whoami.js';
import { subscriptionsCommand } from './commands/subscriptions.js';
import { feedsCommand } from './commands/feeds.js';
import { savedCommand } from './commands/saved.js';

const program = new Command()
  .name('skyreader')
  .description('Skyreader CLI - Read and manage RSS feeds from the terminal')
  .version('0.1.0');

program.addCommand(loginCommand);
program.addCommand(whoamiCommand);
program.addCommand(subscriptionsCommand);
program.addCommand(feedsCommand);
program.addCommand(savedCommand);

program.parseAsync().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
