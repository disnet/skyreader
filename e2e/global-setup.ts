import { execFileSync } from 'node:child_process';
import path from 'node:path';

const BACKEND_DIR = path.resolve(import.meta.dirname, '..', 'backend');

export default function globalSetup() {
  console.log('Applying D1 migrations...');
  try {
    execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'skyreader', '--local'], {
      cwd: BACKEND_DIR,
      stdio: 'pipe',
    });
    console.log('D1 migrations applied.');
  } catch (err: unknown) {
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? (err as { stderr: Buffer }).stderr?.toString() ?? ''
        : '';
    // If the error is about a duplicate column or table already existing,
    // the local DB already has the migrations applied — that's fine.
    if (/duplicate column|already exists|SQLITE_ERROR/i.test(stderr)) {
      console.log('D1 migrations already applied (local DB is up to date).');
    } else {
      throw err;
    }
  }
}
