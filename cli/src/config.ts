import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface Config {
  server: string;
  sessionId?: string;
  handle?: string;
  did?: string;
}

const DEFAULT_SERVER = 'https://api.skyreader.app';

function getConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  const base = xdgConfig || path.join(os.homedir(), '.config');
  return path.join(base, 'skyreader');
}

function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function loadConfig(): Config {
  const configPath = getConfigPath();
  try {
    const data = fs.readFileSync(configPath, 'utf-8');
    return { server: DEFAULT_SERVER, ...JSON.parse(data) };
  } catch {
    return { server: DEFAULT_SERVER };
  }
}

export function saveConfig(config: Config): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600,
  });
}
