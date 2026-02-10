import type { Subscription } from '$lib/types';

/**
 * Generate OPML XML from a list of subscriptions.
 * Groups feeds by category when present.
 */
export function generateOPML(subscriptions: Subscription[]): string {
  const now = new Date().toUTCString();

  // Group subscriptions by category
  const byCategory = new Map<string | undefined, Subscription[]>();
  for (const sub of subscriptions) {
    const category = sub.category || undefined;
    if (!byCategory.has(category)) {
      byCategory.set(category, []);
    }
    byCategory.get(category)!.push(sub);
  }

  // Build XML
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Skyreader Subscriptions</title>
    <dateCreated>${escapeXml(now)}</dateCreated>
  </head>
  <body>
`;

  // First, output uncategorized feeds
  const uncategorized = byCategory.get(undefined) || [];
  for (const sub of uncategorized) {
    xml += `    ${buildOutline(sub)}\n`;
  }

  // Then, output categorized feeds grouped in folder outlines
  for (const [category, subs] of byCategory) {
    if (category === undefined) continue;

    xml += `    <outline text="${escapeXml(category)}" title="${escapeXml(category)}">\n`;
    for (const sub of subs) {
      xml += `      ${buildOutline(sub)}\n`;
    }
    xml += `    </outline>\n`;
  }

  xml += `  </body>
</opml>`;

  return xml;
}

function buildOutline(sub: Subscription): string {
  const title = sub.customTitle || sub.title || sub.feedUrl;
  let outline = `<outline type="rss" text="${escapeXml(title)}" title="${escapeXml(title)}" xmlUrl="${escapeXml(sub.feedUrl)}"`;

  if (sub.siteUrl) {
    outline += ` htmlUrl="${escapeXml(sub.siteUrl)}"`;
  }

  outline += ' />';
  return outline;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Trigger a download of the OPML file.
 */
export function downloadOPML(subscriptions: Subscription[], filename?: string): void {
  const xml = generateOPML(subscriptions);
  const blob = new Blob([xml], { type: 'application/xml' });
  const url = URL.createObjectURL(blob);

  const date = new Date().toISOString().split('T')[0];
  const name = filename || `skyreader-subscriptions-${date}.opml`;

  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
