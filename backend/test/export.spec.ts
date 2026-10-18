import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import {
  firstPdfPageText,
  idsFromFirstPage,
  idsFromUrl,
  normalizeDoi,
  scholarlyIds,
} from '../src/services/export/identifiers';
import {
  citationKeys,
  renderBibtex,
  renderMarkdown,
  splitAuthors,
  type ExportDocument,
  type ExportSource,
} from '../src/services/export/render';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('identifiers from a URL', () => {
  it.each([
    ['https://doi.org/10.1145/3290605.3300233', { doi: '10.1145/3290605.3300233' }],
    ['https://dx.doi.org/10.1038/nature14539', { doi: '10.1038/nature14539' }],
    ['https://dl.acm.org/doi/10.1145/3290605.3300233', { doi: '10.1145/3290605.3300233' }],
    ['https://dl.acm.org/doi/pdf/10.1145/3290605.3300233.pdf', { doi: '10.1145/3290605.3300233' }],
    ['https://onlinelibrary.wiley.com/doi/full/10.1002/asi.24750', { doi: '10.1002/asi.24750' }],
    [
      'https://www.biorxiv.org/content/10.1101/2020.03.22.002386v4.full',
      { doi: '10.1101/2020.03.22.002386' },
    ],
    [
      'https://arxiv.org/abs/1706.03762v7',
      { arxivId: '1706.03762', doi: '10.48550/arXiv.1706.03762' },
    ],
    [
      'https://arxiv.org/pdf/2401.12345.pdf',
      { arxivId: '2401.12345', doi: '10.48550/arXiv.2401.12345' },
    ],
    [
      'https://arxiv.org/html/2401.12345v2',
      { arxivId: '2401.12345', doi: '10.48550/arXiv.2401.12345' },
    ],
    [
      'https://arxiv.org/abs/hep-th/9901001',
      { arxivId: 'hep-th/9901001', doi: '10.48550/arXiv.hep-th/9901001' },
    ],
    [
      'https://doi.org/10.48550/arXiv.1706.03762',
      { doi: '10.48550/arXiv.1706.03762', arxivId: '1706.03762' },
    ],
    ['https://example.com/blog/10.1145/not-a-doi-path', {}],
    ['https://arxiv.org/list/cs.CL/recent', {}],
    ['not a url', {}],
    ['', {}],
  ])('%s', (url, expected) => {
    expect(idsFromUrl(url)).toEqual(expected);
  });

  it('trims sentence punctuation and unbalanced brackets, keeps balanced ones', () => {
    expect(normalizeDoi('10.1000/xyz123.')).toBe('10.1000/xyz123');
    expect(normalizeDoi('(see 10.1000/xyz123)')).toBe('10.1000/xyz123');
    // Cut short at its <, a SICI DOI would name nothing: no DOI beats a wrong one.
    expect(
      normalizeDoi('10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-0')
    ).toBeUndefined();
    expect(normalizeDoi('10.1002/(SICI)1097-4571(199806)')).toBe('10.1002/(SICI)1097-4571(199806)');
    expect(normalizeDoi('10.1000/')).toBeUndefined();
  });
});

describe('identifiers on a PDF first page', () => {
  const page = (text: string, rest = '') =>
    `<section data-pdf-page="1">\n<p>${text}</p>\n</section>\n<section data-pdf-page="2">\n<p>${rest}</p>\n</section>`;

  it('reads a labelled DOI and the arXiv stamp from page one only', () => {
    const html = page(
      'Deep learning. Nature 521, 436–444. https://doi.org/10.1038/nature14539.',
      'References: doi:10.9999/other arXiv:2001.00001 [cs.LG]'
    );
    expect(idsFromFirstPage(firstPdfPageText(html))).toEqual({ doi: '10.1038/nature14539' });
    expect(
      idsFromFirstPage(firstPdfPageText(page('arXiv:2401.12345v2 [cs.CL] 3 Jan 2024')))
    ).toEqual({ arxivId: '2401.12345' });
  });

  it('ignores an unlabelled DOI and an arXiv id cited without the stamp', () => {
    expect(
      idsFromFirstPage(
        firstPdfPageText(page('as in 10.1038/nature14539 and arXiv preprint arXiv:2001.00001'))
      )
    ).toEqual({});
  });

  it('prefers the URL, and only searches a PDF body', () => {
    const html = page('DOI: 10.1234/page-doi');
    expect(
      scholarlyIds({
        url: 'https://example.com/paper.pdf',
        contentType: 'pdf',
        firstPageHtml: html,
      })
    ).toEqual({ doi: '10.1234/page-doi' });
    expect(
      scholarlyIds({ url: 'https://doi.org/10.1145/url', contentType: 'pdf', firstPageHtml: html })
    ).toEqual({ doi: '10.1145/url' });
    expect(
      scholarlyIds({ url: 'https://example.com/post', contentType: 'webpage', firstPageHtml: html })
    ).toEqual({});
    // The DOI the page declared comes first, its URL's arXiv id still counts.
    expect(scholarlyIds({ url: 'https://example.com/paper', doi: '10.1234/declared' })).toEqual({
      doi: '10.1234/declared',
    });
    expect(
      scholarlyIds({
        url: 'https://dl.acm.org/doi/10.1145/url',
        doi: '10.1145/declared',
        contentType: 'pdf',
        firstPageHtml: html,
      })
    ).toEqual({ doi: '10.1145/declared' });
    expect(
      scholarlyIds({ url: 'https://arxiv.org/abs/1706.03762', doi: '10.5555/3295222.3295349' })
    ).toEqual({ doi: '10.5555/3295222.3295349', arxivId: '1706.03762' });
    expect(
      scholarlyIds({ url: 'https://example.com/p', doi: '10.48550/arXiv.1706.03762' })
    ).toEqual({ doi: '10.48550/arXiv.1706.03762', arxivId: '1706.03762' });
    expect(scholarlyIds({ url: 'https://example.com/p', doi: 'not a doi' })).toEqual({});
    // An arXiv PDF's page DOI is its journal version: kept alongside the id.
    expect(
      scholarlyIds({
        url: 'https://example.com/a.pdf',
        contentType: 'pdf',
        firstPageHtml: page('arXiv:1706.03762v7 [cs.CL] DOI: 10.5555/3295222.3295349'),
      })
    ).toEqual({ doi: '10.5555/3295222.3295349', arxivId: '1706.03762' });
  });
});

describe('authors and citation keys', () => {
  it.each([
    ['Jane Doe', ['Jane Doe']],
    ['Doe, Jane', ['Doe, Jane']],
    ['Jane Doe, John Smith', ['Jane Doe', 'John Smith']],
    ['Jane Doe, John Smith, and Ada Lovelace', ['Jane Doe', 'John Smith', 'Ada Lovelace']],
    ['Doe, J. and Smith, K.', ['Doe, J.', 'Smith, K.']],
    ['Doe; Smith', ['Doe', 'Smith']],
    ['', []],
  ])('%s', (raw, expected) => {
    expect(splitAuthors(raw)).toEqual(expected);
  });

  it('builds surname-year-word keys and disambiguates repeats', () => {
    const source = (title: string, extra: Partial<ExportSource> = {}): ExportSource => ({
      kind: 'save',
      title,
      highlights: [],
      ...extra,
    });
    expect(
      citationKeys([
        source('Attention Is All You Need', {
          author: 'Ashish Vaswani, Noam Shazeer',
          publishedAt: '2017-06-12T00:00:00.000Z',
        }),
        source('Attention, again', {
          author: 'Ashish Vaswani',
          publishedAt: '2017-01-01T00:00:00.000Z',
        }),
        source('The Ørsted effect', { author: 'Hans Christian Ørsted' }),
        source('', { url: 'https://www.example.com/x' }),
        source('', {}),
      ])
    ).toEqual([
      'vaswani2017attention',
      'vaswani2017attentiona',
      'orstedorsted',
      'examplecom',
      'untitled',
    ]);
  });

  it("keeps an older source's key when a newer one with the same key arrives", () => {
    const paper = (savedAt: string): ExportSource => ({
      kind: 'save',
      title: 'Attention',
      author: 'Ashish Vaswani',
      publishedAt: '2017-01-01T00:00:00.000Z',
      savedAt,
      highlights: [],
    });
    const old = paper('2026-01-01T00:00:00.000Z');
    expect(citationKeys([old])).toEqual(['vaswani2017attention']);
    // Newest first, as the export lists them.
    expect(citationKeys([paper('2026-05-01T00:00:00.000Z'), old])).toEqual([
      'vaswani2017attentiona',
      'vaswani2017attention',
    ]);
  });
});

const doc = (sources: ExportSource[], skipped = 0): ExportDocument => ({
  sources,
  exportedAt: '2026-10-18T00:00:00.000Z',
  skipped,
});

describe('Markdown', () => {
  it('renders a source with its metadata, highlights and notes', () => {
    const md = renderMarkdown(
      doc([
        {
          kind: 'save',
          title: 'Attention Is All You Need',
          url: 'https://arxiv.org/abs/1706.03762',
          author: 'Ashish Vaswani',
          publishedAt: '2017-06-12T00:00:00.000Z',
          savedAt: '2026-10-01T10:00:00.000Z',
          arxivId: '1706.03762',
          doi: '10.48550/arXiv.1706.03762',
          highlights: [
            { text: 'The dominant sequence\ntransduction models', note: 'Key claim' },
            { text: '', note: 'A note on its own' },
          ],
        },
      ])
    );
    expect(md).toBe(
      [
        '# Skyreader export',
        '',
        'Exported 2026-10-18: 1 save, with 2 highlights and 2 notes.',
        '',
        '---',
        '',
        '## Attention Is All You Need',
        '',
        '- Author: Ashish Vaswani',
        '- Link: [arxiv.org](<https://arxiv.org/abs/1706.03762>)',
        '- DOI: [10.48550/arXiv.1706.03762](<https://doi.org/10.48550/arXiv.1706.03762>)',
        '- arXiv: [1706.03762](<https://arxiv.org/abs/1706.03762>)',
        '- Published: 2017-06-12',
        '- Saved: 2026-10-01',
        '- Cite as: `vaswani2017attention`',
        '',
        '### Highlights',
        '',
        '> The dominant sequence',
        '> transduction models',
        '',
        '**Note:** Key claim',
        '',
        '> …',
        '',
        '**Note:** A note on its own',
        '',
      ].join('\n')
    );
  });

  it('escapes text that would change the structure', () => {
    const md = renderMarkdown(
      doc(
        [
          {
            kind: 'highlighted',
            title: '# Not a [heading]\n*really*',
            url: 'https://example.com/a b>',
            highlights: [{ text: '- not a list\n1. nor this <b>tag</b> #tag $x$' }],
          },
        ],
        1
      )
    );
    expect(md).toContain('## \\# Not a \\[heading\\] \\*really\\*');
    expect(md).toContain('(<https://example.com/a%20b%3E>)');
    expect(md).toContain('> \\- not a list\n> 1\\. nor this \\<b\\>tag\\</b\\> \\#tag \\$x\\$');
    expect(md).toContain("1 item couldn't be read and is left out.");
    // Underlines that would make the line above a heading, a rule, an Obsidian comment.
    const lines = renderMarkdown(
      doc([
        {
          kind: 'save',
          title: 'T',
          highlights: [{ text: 'para\n===\nmore', note: 'line one\n---\n%%hidden%%' }],
        },
      ])
    );
    expect(lines).toContain('> para\n> \\===\n> more');
    expect(lines).toContain('**Note:** line one\n\\---\n\\%\\%hidden\\%\\%');
    expect(md).toContain('0 saves and 1 other page you highlighted');
  });
});

describe('BibTeX', () => {
  it('writes a @misc entry with identifiers, escaped text and highlights in annote', () => {
    const bib = renderBibtex(
      doc([
        {
          kind: 'save',
          title: 'Costs & {benefits} of 100% recall_rate',
          url: 'https://arxiv.org/abs/1706.03762',
          author: 'Ashish Vaswani, Noam Shazeer',
          publishedAt: '2017-06-12T00:00:00.000Z',
          savedAt: '2026-10-01T10:00:00.000Z',
          arxivId: '1706.03762',
          doi: '10.48550/arXiv.1706.03762',
          highlights: [{ text: 'A quote\nover lines', note: 'mine' }, { text: 'Second' }],
        },
        { kind: 'save', title: 'An upload', filename: 'paper.pdf', highlights: [] },
        { kind: 'highlighted', url: 'https://blog.example/post?q={x}', highlights: [] },
      ])
    );
    expect(bib).toBe(
      [
        '% Skyreader export, 2026-10-18. 3 entries.',
        '',
        '@misc{vaswani2017costs,',
        '  title = {{Costs \\& \\textbraceleft{}benefits\\textbraceright{} of 100\\% recall\\_rate}},',
        '  author = {Ashish Vaswani and Noam Shazeer},',
        '  year = {2017},',
        '  date = {2017-06-12},',
        '  doi = {10.48550/arXiv.1706.03762},',
        '  eprint = {1706.03762},',
        '  archivePrefix = {arXiv},',
        '  eprinttype = {arxiv},',
        '  url = {https://arxiv.org/abs/1706.03762},',
        '  urldate = {2026-10-01},',
        '  annote = {“A quote over lines” Note: mine \\par “Second”}',
        '}',
        '',
        '@misc{upload,',
        '  title = {{An upload}}',
        '}',
        '',
        '@misc{blogexample,',
        '  title = {{blog.example}},',
        '  url = {https://blog.example/post?q=%7Bx%7D},',
        '  howpublished = {blog.example}',
        '}',
        '',
      ].join('\n')
    );
  });
});

// ─── The route, over D1 ─────────────────────────────────────────────────────────

let userSeq = 0;

async function createUser() {
  userSeq++;
  const did = `did:plc:export${userSeq}x${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = `export-session-${did}`;
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, 'free', unixepoch())`
  )
    .bind(did, `${did}.test`, 'https://test.pds.example')
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at)
     VALUES (?, ?, ?, ?, 'a', 'r', ?, ?)`
  )
    .bind(
      sessionId,
      did,
      `${did}.test`,
      'https://test.pds.example',
      '{"kty":"EC"}',
      Date.now() + 3600000
    )
    .run();
  return { did, sessionId };
}

type User = Awaited<ReturnType<typeof createUser>>;

async function save(
  user: User,
  opts: {
    rkey: string;
    url: string;
    title: string;
    savedAt: number;
    itemGuid?: string;
    contentType?: string;
    content?: string;
    source?: string;
    doi?: string;
  }
) {
  await env.DB.prepare(
    `INSERT INTO saved_articles (user_did, rkey, record_uri, url, title, content, saved_at, source, item_guid, content_type, doi)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      user.did,
      opts.rkey,
      `at://${user.did}/app.skyreader.feed.saved/${opts.rkey}`,
      opts.url,
      opts.title,
      opts.content ?? null,
      opts.savedAt,
      opts.source ?? (opts.itemGuid ? 'feed' : 'url'),
      opts.itemGuid ?? null,
      opts.contentType ?? null,
      opts.doi ?? null
    )
    .run();
}

let labelSeq = 0;
async function label(
  user: User,
  itemKey: string,
  name: 'read' | 'highlights',
  props: unknown,
  opts: { updatedAt?: number; deletedAt?: number } = {}
) {
  labelSeq++;
  const at = opts.updatedAt ?? 1_700_000_000;
  await env.DB.prepare(
    `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at, deleted_at)
     VALUES (?, ?, 'article', ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      user.did,
      itemKey,
      name,
      JSON.stringify(props),
      `rk${labelSeq}`,
      at,
      at,
      at * 1000,
      opts.deletedAt ?? null
    )
    .run();
}

const hl = (id: string, exact: string, createdAt: number, extra: Record<string, unknown> = {}) => ({
  id,
  selector: { type: 'TextQuoteSelector', exact },
  createdAt,
  ...extra,
});

async function exportAs(user: User, format?: string) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new IncomingRequest(`http://localhost/api/export${format ? `?format=${format}` : ''}`, {
      headers: { Cookie: `session_id=${user.sessionId}`, Origin: 'http://localhost:5173' },
    }),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe('GET /api/export', () => {
  it('needs a session and a known format', async () => {
    const ctx = createExecutionContext();
    const anon = await worker.fetch(new IncomingRequest('http://localhost/api/export'), env, ctx);
    expect(anon.status).toBe(401);
    const user = await createUser();
    expect((await exportAs(user, 'csv')).status).toBe(400);
  });

  it('exports saves with merged alias highlights, then highlighted pages', async () => {
    const user = await createUser();
    await save(user, {
      rkey: '3mwhuiodre72s',
      url: 'https://blog.example/feed-post',
      title: 'Feed post',
      savedAt: 2_000,
      itemGuid: 'guid-1',
    });
    await save(user, {
      rkey: '3mwhuiodre73s',
      url: 'https://example.com/paper.pdf',
      title: 'A paper',
      savedAt: 3_000,
      contentType: 'pdf',
      content:
        '<section data-pdf-page="1">\n<p>Journal 1 (2020). DOI: 10.1234/abc.5</p>\n</section>',
    });
    const saveUri = `at://${user.did}/app.skyreader.feed.saved/3mwhuiodre72s`;
    // The same highlight in two alias rows: the newer row's copy (with a note) wins.
    await label(
      user,
      saveUri,
      'highlights',
      { highlights: [hl('h1', 'old text', 10)] },
      { updatedAt: 1_700_000_000 }
    );
    await label(
      user,
      'guid-1',
      'highlights',
      {
        highlights: [
          hl('h1', 'first quote', 10, { note: 'my note' }),
          hl('h2', 'second quote', 20),
        ],
      },
      { updatedAt: 1_700_000_100 }
    );
    // Deleted rows and id-less elements stay out.
    await label(
      user,
      'gone',
      'highlights',
      { highlights: [hl('h3', 'deleted', 5)] },
      { deletedAt: 1 }
    );
    await label(user, 'guid-unsaved', 'highlights', {
      highlights: [{ selector: { exact: 'no id' } }, hl('h4', 'unsaved quote', 30)],
    });
    await label(user, 'guid-unsaved', 'read', {
      itemUrl: 'https://doi.org/10.5555/unsaved',
      itemTitle: 'Read but not saved',
    });

    const response = await exportAs(user);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('Content-Disposition')).toMatch(
      /^attachment; filename="skyreader-export-\d{4}-\d{2}-\d{2}\.md"$/
    );
    const md = await response.text();
    expect(md).toContain('2 saves and 1 other page you highlighted, with 3 highlights and 1 note.');
    // Newest save first, then the highlighted page.
    const order = ['## A paper', '## Feed post', '## Read but not saved'].map((h) => md.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(md).toContain('- DOI: [10.1234/abc.5](<https://doi.org/10.1234/abc.5>)');
    expect(md).toContain('> first quote\n\n**Note:** my note\n\n> second quote');
    expect(md).not.toContain('old text');
    expect(md).not.toContain('deleted');
    expect(md).toContain('- DOI: [10.5555/unsaved](<https://doi.org/10.5555/unsaved>)');

    const bib = await (await exportAs(user, 'bibtex')).text();
    expect(bib).toContain('% Skyreader export');
    expect(bib).toContain('doi = {10.1234/abc.5}');
    expect(bib.match(/^@misc\{/gm)).toHaveLength(3);
  });

  it("files a backed save's highlights under its foreign item uri", async () => {
    const user = await createUser();
    const collection = `at://${user.did}/network.cosmik.collection/c1`;
    await env.DB.prepare(
      `INSERT INTO user_settings (user_did, backing, last_backing_poll, last_successful_backing_poll)
       VALUES (?, ?, 1, 1)`
    )
      .bind(user.did, `semble:${collection}`)
      .run();
    // A has a row (a backed save has no record_uri); B was added in Semble.
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, record_uri, url, url_normalized, title, saved_at, source)
       VALUES (?, '3mwhuiodre74s', NULL, 'https://a.test/a', 'https://a.test/a', 'Backed A', 5000, 'url')`
    )
      .bind(user.did)
      .run();
    for (const [key, uri, metadata] of [
      ['a', 'at://other/network.cosmik.card/a', null],
      ['b', 'at://other/network.cosmik.card/b', JSON.stringify({ title: 'Backed only B' })],
    ]) {
      await env.DB.prepare(
        `INSERT INTO backed_collection_members
           (user_did, external_collection, url_normalized, url, external_provider, external_item_uri, external_link_uri, metadata)
         VALUES (?, ?, ?, ?, 'semble', ?, ?, ?)`
      )
        .bind(
          user.did,
          collection,
          `https://a.test/${key}`,
          `https://a.test/${key}`,
          uri,
          `${uri}-link`,
          metadata
        )
        .run();
      await label(user, uri!, 'highlights', { highlights: [hl(`h${key}`, `quote on ${key}`, 10)] });
    }

    const md = await (await exportAs(user)).text();
    expect(md).toContain('2 saves, with 2 highlights');
    expect(md).toMatch(/## Backed A\n[\s\S]*> quote on a\n/);
    expect(md).toMatch(/## Backed only B\n[\s\S]*> quote on b\n/);
    expect(md).not.toContain('Untitled');
    // B has no save time of its own, so it carries none.
    expect(md.slice(md.indexOf('## Backed only B'))).not.toContain('Saved:');
  });

  it('cites a save by the DOI its page declared', async () => {
    const user = await createUser();
    await save(user, {
      rkey: '3mwhuiodre74s',
      url: 'https://www.nature.example/articles/nature12373',
      title: 'Declared',
      savedAt: 1_000,
      doi: '10.1038/nature12373',
    });
    const bib = await (await exportAs(user, 'bibtex')).text();
    expect(bib).toContain('doi = {10.1038/nature12373}');
  });

  it('exports an empty library', async () => {
    const user = await createUser();
    expect(await (await exportAs(user)).text()).toContain(
      '0 saves, with 0 highlights and 0 notes.'
    );
  });
});
