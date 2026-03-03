#!/usr/bin/env node
import { Command } from 'commander';
import { createRequire } from 'module';
import { loginCommand } from './commands/login.js';
import { whoamiCommand } from './commands/whoami.js';
import { subscriptionsCommand } from './commands/subscriptions.js';
import { feedsCommand } from './commands/feeds.js';
import { savedCommand } from './commands/saved.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const program = new Command()
  .name('skyreader')
  .description('Skyreader CLI - Read and manage RSS feeds from the terminal')
  .version(version);

program.addCommand(loginCommand);
program.addCommand(whoamiCommand);
program.addCommand(subscriptionsCommand);
program.addCommand(feedsCommand);
program.addCommand(savedCommand);

program.parseAsync().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
