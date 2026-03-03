import { loadConfig } from './config.js';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function getClient() {
  const config = loadConfig();

  if (!config.sessionId) {
    process.stderr.write('Not logged in. Run: skyreader login --handle <your-handle>\n');
    process.exit(2);
  }

  const server = config.server;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.sessionId}`,
    'Content-Type': 'application/json',
  };

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${server}${path}`;
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401) {
      process.stderr.write('Session expired. Run: skyreader login --handle <your-handle>\n');
      process.exit(2);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new ApiError(res.status, `${method} ${path} failed (${res.status}): ${text}`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return (await res.json()) as T;
    }
    return (await res.text()) as unknown as T;
  }

  return {
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
    config,
  };
}
