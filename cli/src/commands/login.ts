import { Command } from 'commander';
import { loadConfig, saveConfig } from '../config.js';
import { startCallbackServer, openInBrowser } from '../auth.js';

export const loginCommand = new Command('login')
  .description('Log in to Skyreader via browser')
  .requiredOption('--handle <handle>', 'Your Bluesky handle (e.g. user.bsky.social)')
  .option('--server <url>', 'Backend server URL')
  .action(async (opts: { handle: string; server?: string }) => {
    const config = loadConfig();
    const server = opts.server || config.server;

    process.stderr.write('Starting login flow...\n');

    const { port, waitForCallback, close } = await startCallbackServer();

    const loginUrl = `${server}/api/auth/login?handle=${encodeURIComponent(opts.handle)}&cli_port=${port}`;

    try {
      const res = await fetch(loginUrl);
      if (!res.ok) {
        const text = await res.text();
        process.stderr.write(`Login failed: ${text}\n`);
        close();
        process.exit(1);
      }

      const data = (await res.json()) as { authUrl: string };

      process.stderr.write('Opening browser for authentication...\n');
      openInBrowser(data.authUrl);
      process.stderr.write('Waiting for authentication...\n');

      const { sessionId } = await waitForCallback();
      close();

      saveConfig({
        server,
        sessionId,
        handle: opts.handle,
      });

      process.stderr.write(`Logged in as ${opts.handle}\n`);
    } catch (err) {
      close();
      const message = err instanceof Error ? err.message : String(err);
      const cause =
        err instanceof TypeError && err.cause instanceof Error ? `: ${err.cause.message}` : '';
      process.stderr.write(`Login error: ${message}${cause}\n`);
      if (message === 'fetch failed') {
        process.stderr.write(`Could not connect to ${server}. Is the backend running?\n`);
      }
      process.exit(1);
    }
  });
