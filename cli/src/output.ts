export function outputJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

export function outputTable(rows: Record<string, unknown>[], columns?: string[]): void {
  if (rows.length === 0) {
    process.stdout.write('(no results)\n');
    return;
  }

  const keys = columns || Object.keys(rows[0]);
  const widths = keys.map((k) => {
    const values = rows.map((r) => String(r[k] ?? ''));
    return Math.max(k.length, ...values.map((v) => v.length));
  });

  // Header
  const header = keys.map((k, i) => k.padEnd(widths[i])).join('  ');
  process.stdout.write(header + '\n');
  process.stdout.write(widths.map((w) => '─'.repeat(w)).join('  ') + '\n');

  // Rows
  for (const row of rows) {
    const line = keys.map((k, i) => String(row[k] ?? '').padEnd(widths[i])).join('  ');
    process.stdout.write(line + '\n');
  }
}

export function outputList(
  items: Record<string, unknown>[],
  titleKey: string,
  detailKeys?: string[]
): void {
  if (items.length === 0) {
    process.stdout.write('(no results)\n');
    return;
  }

  for (const item of items) {
    process.stdout.write(`- ${item[titleKey]}\n`);
    if (detailKeys) {
      for (const key of detailKeys) {
        if (item[key] != null && item[key] !== '') {
          process.stdout.write(`  ${key}: ${item[key]}\n`);
        }
      }
    }
  }
}
