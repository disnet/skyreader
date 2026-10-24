/**
 * RFC 4180 CSV: quoted fields may hold commas, doubled quotes and line breaks.
 * Returns one object per data row, keyed by the header row's (trimmed) names.
 * A leading byte-order mark is dropped; blank lines are skipped.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = csvRows(text.replace(/^﻿/, ''));
  const header = rows.shift()?.map((h) => h.trim());
  if (!header) return [];
  return rows
    .filter((row) => row.some((cell) => cell !== ''))
    .map((row) => Object.fromEntries(header.map((name, i) => [name, row[i] ?? ''])));
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
