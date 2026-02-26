import { env } from 'cloudflare:test';

// Import all migration files in order
const migrationFiles = import.meta.glob('../migrations/*.sql', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

// Sort by filename to ensure correct order
const sortedMigrations = Object.entries(migrationFiles).sort(([a], [b]) => a.localeCompare(b));

// Run each migration sequentially
for (const [, sql] of sortedMigrations) {
  const statements = sql
    .replace(/--.*$/gm, '') // Remove comments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (statements.length > 0) {
    await env.DB.batch(statements.map((stmt) => env.DB.prepare(stmt)));
  }
}
