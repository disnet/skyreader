import { describe, expect, it } from 'vitest';
import { omnivoreHighlights, parseExportFiles, toEpochMs, type ImportFile } from './parsers';
import { parseCsv } from './csv';

const enc = new TextEncoder();
const file = (name: string, text: string): ImportFile => ({ name, bytes: enc.encode(text) });

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A zip the way an export arrives: deflated entries, then the central directory. */
async function zip(name: string, entries: Record<string, string>): Promise<ImportFile> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [entryName, text] of Object.entries(entries)) {
    const nameBytes = enc.encode(entryName);
    const raw = enc.encode(text);
    const data = await deflateRaw(raw);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, eocd];
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return { name, bytes };
}

describe('parseCsv', () => {
  it('reads quoted commas, doubled quotes, line breaks and a BOM', () => {
    const rows = parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\r\n\r\nplain,\n');
    expect(rows).toEqual([
      { a: 'x, y', b: 'say "hi"\nthere' },
      { a: 'plain', b: '' },
    ]);
  });
});

describe('toEpochMs', () => {
  it('reads seconds, ms, ISO and Readwise dates', () => {
    expect(toEpochMs('2021-03-05T10:00:00+0100')).toBe(Date.UTC(2021, 2, 5, 9));
    expect(toEpochMs('1600000000')).toBe(1600000000000);
    expect(toEpochMs(1600000000000)).toBe(1600000000000);
    expect(toEpochMs('2023-08-11T15:45:05.000Z')).toBe(Date.UTC(2023, 7, 11, 15, 45, 5));
    expect(toEpochMs('2023-08-11 15:45:05.519000+00:00')).toBe(
      Date.UTC(2023, 7, 11, 15, 45, 5, 519)
    );
    expect(toEpochMs('')).toBeUndefined();
    expect(toEpochMs('soon')).toBeUndefined();
  });
});

describe('Pocket', () => {
  it('reads the CSV with its highlights file from the zip', async () => {
    const archive = await zip('pocket.zip', {
      'part_000000.csv':
        'title,url,time_added,tags,status\n' +
        'One,https://example.com/1,1600000000,history|essays,archive\n' +
        'Two,https://example.com/2,1600000100,,unread\n' +
        'Bad,not-a-url,1600000200,,unread\n',
      'annotations/part_000000.json': JSON.stringify([
        {
          url: 'https://example.com/1',
          title: 'One',
          highlights: [{ quote: 'A line from one.', created_at: 1600000500 }],
        },
      ]),
    });
    const { saves, warnings } = await parseExportFiles([archive]);
    expect(warnings).toEqual([]);
    expect(saves).toEqual([
      {
        source: 'pocket',
        url: 'https://example.com/1',
        title: 'One',
        savedAt: 1600000000000,
        archived: true,
        tags: ['history', 'essays'],
        highlights: [{ text: 'A line from one.', createdAt: 1600000500000 }],
      },
      {
        source: 'pocket',
        url: 'https://example.com/2',
        title: 'Two',
        savedAt: 1600000100000,
        archived: false,
        tags: [],
        highlights: [],
      },
    ]);
  });

  it('keeps an archived save archived when its highlights file comes first', async () => {
    const { saves } = await parseExportFiles([
      file(
        'annotations.json',
        JSON.stringify([{ url: 'https://example.com/1', highlights: [{ quote: 'Q' }] }])
      ),
      file(
        'pocket.csv',
        'title,url,time_added,tags,status\nOne,https://example.com/1,1,,archive\n'
      ),
    ]);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ archived: true, title: 'One', highlights: [{ text: 'Q' }] });
  });

  it('reads the older HTML export', async () => {
    const html = `<!DOCTYPE html><html><head><title>Pocket Export</title></head><body>
<h1>Unread</h1><ul>
<li><a href="https://example.com/a?x=1&amp;y=2" time_added="1500000000" tags="one,two">A &amp; B</a></li>
</ul>
<h1>Read Archive</h1><ul>
<li><a href="https://example.com/b" time_added="1500000001" tags="">B</a></li>
</ul></body></html>`;
    const { saves } = await parseExportFiles([file('ril_export.html', html)]);
    expect(saves.map((s) => [s.url, s.title, s.archived, s.tags, s.savedAt])).toEqual([
      ['https://example.com/a?x=1&y=2', 'A & B', false, ['one', 'two'], 1500000000000],
      ['https://example.com/b', 'B', true, [], 1500000001000],
    ]);
  });
});

describe('Omnivore', () => {
  it('reads metadata files and attaches each slug’s highlights', async () => {
    const archive = await zip('omnivore.zip', {
      'metadata_0_to_20.json': JSON.stringify([
        {
          id: '1',
          slug: 'first-slug',
          title: 'First',
          author: 'Ada',
          description: 'About it',
          url: 'https://example.com/first',
          state: 'Archived',
          labels: ['Newsletter', 'Later'],
          savedAt: '2024-03-01T10:00:00.000Z',
        },
        {
          id: '2',
          slug: 'second-slug',
          title: 'Second',
          url: 'https://example.com/second',
          state: 'Active',
          labels: [],
          savedAt: '2024-03-02T10:00:00.000Z',
        },
      ]),
      'content/first-slug.html': '<p>Body</p>',
      'highlights/first-slug.md':
        '> The first passage. \n\n#idea #quote\n\nMy note on it.\n\n> A second\n> \nspanning paragraphs. ',
    });
    const { saves } = await parseExportFiles([archive]);
    expect(saves).toHaveLength(2);
    expect(saves[0]).toMatchObject({
      source: 'omnivore',
      title: 'First',
      author: 'Ada',
      description: 'About it',
      archived: true,
      tags: ['Newsletter', 'Later'],
      savedAt: Date.UTC(2024, 2, 1, 10),
      highlights: [
        { text: 'The first passage.', note: 'My note on it.' },
        { text: 'A second\n\nspanning paragraphs.' },
      ],
    });
    expect(saves[1]).toMatchObject({ archived: false, highlights: [] });
  });

  it('reads labels with spaces as labels, not as the note', () => {
    expect(omnivoreHighlights('> Quote one. \n\n#Read Later #idea\n\nMy note')).toEqual([
      { text: 'Quote one.', note: 'My note' },
    ]);
  });

  it('reads a note-only highlights file as no highlights', () => {
    expect(omnivoreHighlights('Just a page note.\n\n')).toEqual([]);
  });
});

describe('Instapaper', () => {
  it('reads the CSV: Archive is archived, other folders and Tags become tags', async () => {
    const csv =
      'URL,Title,Selection,Folder,Timestamp,Tags\n' +
      'https://example.com/1,One,A summary,Archive,1700000000,"[""ai""]"\n' +
      'https://example.com/2,Two,,Unread,1700000001,[]\n' +
      'https://example.com/3,Three,,Research,1700000002,\n';
    const { saves } = await parseExportFiles([file('instapaper-export.csv', csv)]);
    expect(saves.map((s) => [s.title, s.archived, s.tags, s.description])).toEqual([
      ['One', true, ['ai'], 'A summary'],
      ['Two', false, [], undefined],
      ['Three', false, ['Research'], undefined],
    ]);
  });

  it('reads the HTML export', async () => {
    const html = `<html><head><title>Instapaper: Export</title></head><body>
<h1>Unread</h1><ol><li><a href="https://example.com/u">U</a></li></ol>
<h1>Archive</h1><ol><li><a href="https://example.com/a">A</a></li></ol>
<h1>Starred</h1><ol><li><a href="https://example.com/s">S</a></li></ol></body></html>`;
    const { saves } = await parseExportFiles([file('instapaper-export.html', html)]);
    expect(saves.map((s) => [s.url, s.archived, s.tags])).toEqual([
      ['https://example.com/u', false, []],
      ['https://example.com/a', true, []],
      ['https://example.com/s', false, ['Starred']],
    ]);
  });
});

describe('Readwise Reader', () => {
  const documents =
    'Title,URL,ID,Document tags,Saved date,Reading progress,Location,Seen\n' +
    `Essay,https://example.com/essay,01h,"['craft', ""it's""]",2023-08-11 15:45:05.519000+00:00,0.5,archive,True\n` +
    'Feed thing,https://example.com/feed,01i,[],2023-08-12 10:00:00+00:00,0,feed,False\n' +
    'Later,https://example.com/later,01j,,2023-08-13 10:00:00+00:00,0,later,False\n' +
    `Short,https://example.com/short,01k,"['craft', 'Shortlist']",2023-08-14 10:00:00+00:00,0,shortlist,False\n` +
    `Tagged,https://example.com/tagged,01l,"['shortlist']",2023-08-15 10:00:00+00:00,0,later,False\n`;

  it('reads documents, leaving feed items behind', async () => {
    const { saves } = await parseExportFiles([file('reader.csv', documents)]);
    expect(saves.map((s) => [s.title, s.archived, s.tags, s.savedAt])).toEqual([
      ['Essay', true, ['craft', "it's"], Date.UTC(2023, 7, 11, 15, 45, 5, 519)],
      ['Later', false, [], Date.UTC(2023, 7, 13, 10)],
      ['Short', false, ['shortlist', 'craft'], Date.UTC(2023, 7, 14, 10)],
      ['Tagged', false, ['shortlist'], Date.UTC(2023, 7, 15, 10)],
    ]);
  });

  it('matches the Readwise highlights file to documents by title', async () => {
    const highlights =
      'Highlight,Book Title,Book Author,Amazon Book ID,Note,Color,Tags,Location Type,Location,Highlighted at,Document tags\n' +
      'Words worth keeping,ESSAY ,Someone,,A note,yellow,,offset,10,2023-08-12 09:00:00+00:00,\n' +
      'Orphan,Not here,,,,,,,,,\n';
    const { saves, warnings } = await parseExportFiles([
      file('reader.csv', documents),
      file('readwise-data.csv', highlights),
    ]);
    expect(saves[0].highlights).toEqual([
      { text: 'Words worth keeping', note: 'A note', createdAt: Date.UTC(2023, 7, 12, 9) },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^1 highlight didn't match/);
  });
});

describe('Matter', () => {
  it('reads _matter_history.csv from the archive; out of the queue is archived', async () => {
    const archive = await zip('Archive.zip', {
      'Archive/_matter_history.csv':
        'Title,Author,Publisher,URL,Tags,Word Count,In Queue,Favorited,Read,Highlight_Count,Last Interaction Date,File Id\n' +
        'Done,Ann,Pub,https://example.com/done,tech;longform,1000,False,True,True,2,2022-05-01T12:00:00Z,abc\n' +
        'Queued,,Pub,https://example.com/queued,,500,True,False,False,0,2022-05-02T12:00:00Z,def\n',
      'Archive/abc': '<html>copy of the article</html>',
    });
    const { saves, warnings } = await parseExportFiles([archive]);
    expect(warnings).toEqual([]);
    expect(saves.map((s) => [s.source, s.title, s.author, s.archived, s.tags])).toEqual([
      ['matter', 'Done', 'Ann', true, ['tech', 'longform']],
      ['matter', 'Queued', undefined, false, []],
    ]);
  });
});

describe('Wallabag', () => {
  it('reads the JSON export: archive, tags, authors and annotations', async () => {
    const entries = [
      {
        is_archived: 0,
        given_url: 'https://example.com/only-given',
        created_at: '2021-03-01T10:00:00+00:00',
      },
      {
        is_archived: 1,
        is_starred: 0,
        tags: ['tech', 'long read'],
        id: 1,
        title: 'Done',
        url: 'https://example.com/done',
        given_url: 'https://example.com/done?ref=x',
        content: '<p>The whole article.</p>',
        created_at: '2021-03-04T10:00:00+01:00',
        published_by: ['Ann', 'Bo'],
        annotations: [
          { user: 'me', text: 'A note.', quote: 'Quoted passage. ', ranges: [] },
          { text: '', quote: 'Just a highlight.', ranges: [] },
          { text: 'No quote', quote: '', ranges: [] },
        ],
        mimetype: 'text/html',
      },
      { is_archived: 0, title: 'No link', annotations: [] },
      {
        is_archived: 0,
        tags: [],
        title: 'Unread',
        given_url: 'https://example.com/unread',
        created_at: '2021-03-05T10:00:00+0000',
        annotations: [],
      },
    ];
    const { saves, warnings } = await parseExportFiles([
      file('All articles.json', JSON.stringify(entries)),
    ]);
    expect(warnings).toEqual([]);
    expect(saves).toEqual([
      {
        source: 'wallabag',
        url: 'https://example.com/only-given',
        title: undefined,
        author: undefined,
        savedAt: Date.UTC(2021, 2, 1, 10),
        archived: false,
        tags: [],
        highlights: [],
      },
      {
        source: 'wallabag',
        url: 'https://example.com/done',
        title: 'Done',
        author: 'Ann, Bo',
        savedAt: Date.UTC(2021, 2, 4, 9),
        archived: true,
        tags: ['tech', 'long read'],
        highlights: [{ text: 'Quoted passage.', note: 'A note.' }, { text: 'Just a highlight.' }],
      },
      {
        source: 'wallabag',
        url: 'https://example.com/unread',
        title: 'Unread',
        author: undefined,
        savedAt: Date.UTC(2021, 2, 5, 10),
        archived: false,
        tags: [],
        highlights: [],
      },
    ]);
  });
});

describe('parseExportFiles', () => {
  it('skips a JSON list of something other than records', async () => {
    const { saves, warnings } = await parseExportFiles([file('list.json', '["a", null]')]);
    expect(saves).toEqual([]);
    expect(warnings).toEqual(["Skipped a file that didn't look like an export: list.json"]);
  });

  it('names files it could not read', async () => {
    const { saves, warnings } = await parseExportFiles([file('notes.csv', 'a,b\n1,2\n')]);
    expect(saves).toEqual([]);
    expect(warnings).toEqual(["Skipped a file that didn't look like an export: notes.csv"]);
  });
});
