#!/usr/bin/env node
// Emit public/version.json so the deploy smoke check can verify the site is
// serving this commit, mirroring SvelteKit's /_app/version.json convention.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const version = process.env.GITHUB_SHA || 'dev';
const dir = fileURLToPath(new URL('../public', import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/version.json`, JSON.stringify({ version }) + '\n');
