// HTML entity map (common named entities + numeric)
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '\u2013',
  mdash: '\u2014',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
  bull: '\u2022',
  hellip: '\u2026',
  copy: '\u00A9',
  reg: '\u00AE',
  trade: '\u2122',
  laquo: '\u00AB',
  raquo: '\u00BB',
  larr: '\u2190',
  rarr: '\u2192',
  '#8217': '\u2019',
  '#8220': '\u201C',
  '#8221': '\u201D',
};

function decodeEntity(entity: string): string {
  // Named entity
  if (ENTITIES[entity]) return ENTITIES[entity];

  // Numeric entity: &#123; or &#x1a;
  if (entity.startsWith('#x') || entity.startsWith('#X')) {
    const code = parseInt(entity.slice(2), 16);
    return isNaN(code) ? `&${entity};` : String.fromCodePoint(code);
  }
  if (entity.startsWith('#')) {
    const code = parseInt(entity.slice(1), 10);
    return isNaN(code) ? `&${entity};` : String.fromCodePoint(code);
  }

  return `&${entity};`;
}

function decodeEntities(text: string): string {
  return text.replace(/&([a-zA-Z0-9#]+);/g, (_, entity) => decodeEntity(entity));
}

// Tags that produce a blank line before/after
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'aside',
  'main',
  'header',
  'footer',
  'nav',
  'figure',
  'figcaption',
  'details',
  'summary',
  'address',
  'hgroup',
]);

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const LIST_TAGS = new Set(['ul', 'ol']);
const SKIP_TAGS = new Set(['script', 'style', 'svg', 'math', 'template', 'noscript']);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr']);

interface Token {
  type: 'text' | 'open' | 'close' | 'self-close';
  tag?: string;
  attrs?: Record<string, string>;
  text?: string;
}

function parseAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_-][a-zA-Z0-9_-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let m;
  while ((m = re.exec(attrStr))) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const re =
    /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^>]*?)?)\s*(\/?)>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let lastIndex = 0;
  let m;

  while ((m = re.exec(html))) {
    // Text before this tag
    if (m.index > lastIndex) {
      tokens.push({ type: 'text', text: html.slice(lastIndex, m.index) });
    }
    lastIndex = m.index + m[0].length;

    // Skip comments
    if (m[0].startsWith('<!--')) continue;

    // CDATA
    if (m[4] !== undefined) {
      tokens.push({ type: 'text', text: m[4] });
      continue;
    }

    const tag = m[1].toLowerCase();
    const attrStr = m[2] || '';
    const isClosing = m[0].startsWith('</');
    const isSelfClosing = m[3] === '/' || VOID_TAGS.has(tag);

    if (isClosing) {
      tokens.push({ type: 'close', tag });
    } else if (isSelfClosing) {
      tokens.push({ type: 'self-close', tag, attrs: parseAttrs(attrStr) });
    } else {
      tokens.push({ type: 'open', tag, attrs: parseAttrs(attrStr) });
    }
  }

  // Trailing text
  if (lastIndex < html.length) {
    tokens.push({ type: 'text', text: html.slice(lastIndex) });
  }

  return tokens;
}

const HEADING_LEVEL: Record<string, string> = {
  h1: '# ',
  h2: '## ',
  h3: '### ',
  h4: '#### ',
  h5: '##### ',
  h6: '###### ',
};

export function htmlToText(html: string): string {
  const tokens = tokenize(html);
  const parts: string[] = [];
  const listStack: ('ul' | 'ol')[] = [];
  const olCounters: number[] = [];
  let skipDepth = 0;
  let preDepth = 0;
  let inLink: string | null = null;
  // Suppress the next block-level break when a marker (>, -, 1.) was just emitted,
  // so that <blockquote><p> or <li><p> don't split the marker from its content.
  let suppressNextBlockBreak = false;

  function pushBreak(count: 1 | 2) {
    // Ensure we have `count` newlines at the end
    // Avoid duplicating breaks
    let trailing = 0;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i] === '\n') trailing++;
      else break;
    }
    while (trailing < count) {
      parts.push('\n');
      trailing++;
    }
  }

  function indent(): string {
    return '  '.repeat(Math.max(0, listStack.length - 1));
  }

  for (const token of tokens) {
    if (skipDepth > 0) {
      if (token.type === 'open' && SKIP_TAGS.has(token.tag!)) skipDepth++;
      if (token.type === 'close' && SKIP_TAGS.has(token.tag!)) skipDepth--;
      continue;
    }

    const tag = token.tag;

    if (token.type === 'text') {
      let text = decodeEntities(token.text!);
      if (preDepth === 0) {
        // Collapse whitespace in non-pre context
        text = text.replace(/[\t\n\r ]+/g, ' ');
        // If we just emitted a marker, strip leading space from the first text
        if (suppressNextBlockBreak) {
          text = text.replace(/^ /, '');
        }
      }
      if (text) {
        suppressNextBlockBreak = false;
        parts.push(text);
      }
      continue;
    }

    if (token.type === 'open' && SKIP_TAGS.has(tag!)) {
      skipDepth = 1;
      continue;
    }

    if (token.type === 'open' || token.type === 'self-close') {
      switch (tag) {
        case 'br':
          parts.push('\n');
          suppressNextBlockBreak = false;
          break;

        case 'hr':
          pushBreak(2);
          parts.push('---');
          pushBreak(2);
          suppressNextBlockBreak = false;
          break;

        case 'img': {
          const alt = token.attrs?.alt;
          if (alt) parts.push(`[${alt}]`);
          suppressNextBlockBreak = false;
          break;
        }

        case 'a':
          if (token.type === 'open') {
            inLink = token.attrs?.href || null;
          }
          break;

        case 'pre':
        case 'code':
          if (tag === 'pre') preDepth++;
          break;

        case 'blockquote':
          pushBreak(2);
          parts.push('> ');
          suppressNextBlockBreak = true;
          break;

        case 'li': {
          pushBreak(1);
          const prefix = indent();
          const listType = listStack[listStack.length - 1];
          if (listType === 'ol') {
            const counter = olCounters[olCounters.length - 1]++;
            parts.push(`${prefix}${counter}. `);
          } else {
            parts.push(`${prefix}- `);
          }
          suppressNextBlockBreak = true;
          break;
        }

        case 'ul':
          listStack.push('ul');
          if (listStack.length === 1) pushBreak(2);
          break;

        case 'ol':
          listStack.push('ol');
          olCounters.push(1);
          if (listStack.length === 1) pushBreak(2);
          break;

        default:
          if (HEADING_TAGS.has(tag!)) {
            pushBreak(2);
            parts.push(HEADING_LEVEL[tag!]);
            suppressNextBlockBreak = true;
          } else if (BLOCK_TAGS.has(tag!)) {
            if (suppressNextBlockBreak) {
              suppressNextBlockBreak = false;
            } else {
              pushBreak(2);
            }
          }
          break;
      }
    }

    if (token.type === 'close') {
      switch (tag) {
        case 'a':
          if (inLink) {
            // Show link URL inline if it's not redundant with the link text
            const linkText = parts.length > 0 ? parts[parts.length - 1].trim() : '';
            if (inLink !== linkText && !linkText.startsWith('http')) {
              parts.push(` (${inLink})`);
            }
            inLink = null;
          }
          break;

        case 'pre':
          preDepth = Math.max(0, preDepth - 1);
          pushBreak(2);
          break;

        case 'code':
          break;

        case 'blockquote':
          pushBreak(2);
          break;

        case 'ul':
          listStack.pop();
          if (listStack.length === 0) pushBreak(2);
          break;

        case 'ol':
          listStack.pop();
          olCounters.pop();
          if (listStack.length === 0) pushBreak(2);
          break;

        case 'li':
          suppressNextBlockBreak = false;
          break;

        default:
          if (BLOCK_TAGS.has(tag!) || HEADING_TAGS.has(tag!)) {
            pushBreak(2);
          }
          break;
      }
    }
  }

  return parts
    .join('')
    .replace(/ +$/gm, '') // trailing spaces per line
    .replace(/\n{3,}/g, '\n\n') // max 2 consecutive newlines
    .trim();
}
