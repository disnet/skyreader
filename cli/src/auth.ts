import http from 'node:http';
import { execFile } from 'node:child_process';

interface CallbackResult {
  sessionId: string;
}

export function startCallbackServer(): Promise<{
  port: number;
  waitForCallback: () => Promise<CallbackResult>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    let callbackResolve: (result: CallbackResult) => void;
    const callbackPromise = new Promise<CallbackResult>((res) => {
      callbackResolve = res;
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1`);

      if (url.pathname === '/callback') {
        const sessionId = url.searchParams.get('session_id');

        if (sessionId) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            '<html><body><h1>Login successful!</h1><p>You can close this tab and return to the terminal.</p></body></html>'
          );
          callbackResolve!({ sessionId });
        } else {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing session_id parameter');
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to start callback server'));
        return;
      }
      resolve({
        port: addr.port,
        waitForCallback: () => callbackPromise,
        close: () => server.close(),
      });
    });

    server.on('error', reject);
  });
}

export function openInBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';

  execFile(cmd, [url], (err) => {
    if (err) {
      process.stderr.write(`Could not open browser. Please visit:\n${url}\n`);
    }
  });
}
