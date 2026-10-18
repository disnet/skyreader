import type { Env } from '../types';
import { collectExport } from '../services/export/collect';
import { renderBibtex, renderMarkdown } from '../services/export/render';

/**
 * GET /api/export?format=markdown|bibtex — the reader's saves, highlights and
 * notes as one file, with DOI and arXiv ids where a save has them. Free on
 * every plan: what a reader saved and wrote is theirs to take anywhere.
 */
const FORMATS = {
  markdown: { render: renderMarkdown, type: 'text/markdown', extension: 'md' },
  bibtex: { render: renderBibtex, type: 'application/x-bibtex', extension: 'bib' },
} as const;

export async function handleExport(request: Request, env: Env, did: string): Promise<Response> {
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  const format = new URL(request.url).searchParams.get('format') ?? 'markdown';
  if (!Object.hasOwn(FORMATS, format)) {
    return Response.json({ error: 'format must be markdown or bibtex' }, { status: 400 });
  }
  const { render, type, extension } = FORMATS[format as keyof typeof FORMATS];
  const doc = await collectExport(env, did);
  const filename = `skyreader-export-${doc.exportedAt.slice(0, 10)}.${extension}`;
  return new Response(render(doc), {
    headers: {
      'Content-Type': `${type}; charset=utf-8`,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
