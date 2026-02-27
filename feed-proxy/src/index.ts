import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { createApp, initDatabase, cleanupCache } from './app';

// Config
const PROXY_SECRET = process.env.PROXY_SECRET;
const DATA_DIR = process.env.DATA_DIR || './data';
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_SECONDS || '900', 10) * 1000; // 15 min default
const STALE_TTL_MS = parseInt(process.env.STALE_TTL_SECONDS || '3600', 10) * 1000; // 1 hour default
const DEFAULT_LIMIT = 100;

// Ensure data directory exists
try {
	mkdirSync(DATA_DIR, { recursive: true });
} catch {
	// May already exist
}

// Database setup
const db = new Database(`${DATA_DIR}/cache.db`);
initDatabase(db);

console.log(`[Proxy] Initialized database at ${DATA_DIR}/cache.db`);
console.log(`[Proxy] TTL: ${CACHE_TTL_MS / 1000}s fresh, ${STALE_TTL_MS / 1000}s stale`);

// Create app
const { app } = createApp(db, {
	proxySecret: PROXY_SECRET,
	cacheTtlMs: CACHE_TTL_MS,
	staleTtlMs: STALE_TTL_MS,
	defaultLimit: DEFAULT_LIMIT,
});

// Run cleanup on startup and every hour
const initialCleanup = cleanupCache(db);
if (initialCleanup > 0) {
	console.log(`[Proxy] Cleaned up ${initialCleanup} old entries`);
}
setInterval(() => {
	const cleaned = cleanupCache(db);
	if (cleaned > 0) {
		console.log(`[Proxy] Cleaned up ${cleaned} old entries`);
	}
}, 60 * 60 * 1000);

const port = parseInt(process.env.PORT || '3000', 10);
console.log(`[Proxy] Starting on port ${port}`);

export default {
	port,
	fetch: app.fetch,
};
