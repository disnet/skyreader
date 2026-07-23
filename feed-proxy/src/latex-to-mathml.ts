import { parseHTML } from 'linkedom';
import temml from 'temml';

const IGNORED_TAGS = new Set([
  'code',
  'kbd',
  'math',
  'noscript',
  'option',
  'pre',
  'script',
  'style',
  'textarea',
]);

const MAX_EXPRESSION_LENGTH = 4096;

interface Delimiter {
  left: string;
  right: string;
  display: boolean;
  singleDollar?: boolean;
}

// Longest openers must come first so $$ is never consumed as an empty $…$ pair.
const DELIMITERS: Delimiter[] = [
  { left: '$$', right: '$$', display: true },
  { left: '\\[', right: '\\]', display: true },
  { left: '\\(', right: '\\)', display: false },
  { left: '$', right: '$', display: false, singleDollar: true },
];

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

function findClosingDelimiter(
  text: string,
  start: number,
  delimiter: Delimiter
): number | undefined {
  let braceDepth = 0;

  for (let i = start; i <= text.length - delimiter.right.length; i++) {
    const char = text[i];

    if (braceDepth <= 0 && text.startsWith(delimiter.right, i)) {
      if (delimiter.singleDollar) {
        // Follow TeX/Markdown's whitespace convention and reject the common
        // currency shape "$5 to $10" (a closing dollar followed by a digit).
        if (i === start || /\s/.test(text[i - 1]) || /\d/.test(text[i + 1] ?? '')) {
          continue;
        }
      }
      return i;
    }

    if (char === '\\') {
      // A backslash escapes the next character, including a dollar delimiter.
      i++;
      continue;
    }
    if (char === '{') {
      braceDepth++;
      continue;
    }
    if (char === '}') {
      braceDepth--;
      continue;
    }
  }

  return undefined;
}

function findNextOpener(
  text: string,
  from: number
): { index: number; delimiter: Delimiter } | undefined {
  for (let i = from; i < text.length; i++) {
    if (isEscaped(text, i)) continue;

    for (const delimiter of DELIMITERS) {
      if (!text.startsWith(delimiter.left, i)) continue;
      if (delimiter.singleDollar && /\s/.test(text[i + 1] ?? '')) continue;
      return { index: i, delimiter };
    }
  }

  return undefined;
}

function renderTextMath(text: string): string {
  let cursor = 0;
  let output = '';
  let changed = false;

  while (cursor < text.length) {
    const opener = findNextOpener(text, cursor);
    if (!opener) break;

    const expressionStart = opener.index + opener.delimiter.left.length;
    const close = findClosingDelimiter(text, expressionStart, opener.delimiter);
    if (close === undefined) {
      // This opener is unmatched. Keep scanning after it in case a later,
      // independent expression is valid.
      output += text.slice(cursor, expressionStart);
      cursor = expressionStart;
      continue;
    }

    const expression = text.slice(expressionStart, close);
    const rawEnd = close + opener.delimiter.right.length;
    if (!expression.trim() || expression.length > MAX_EXPRESSION_LENGTH) {
      output += text.slice(cursor, rawEnd);
      cursor = rawEnd;
      continue;
    }

    try {
      const mathml = temml.renderToString(expression, {
        annotate: false,
        displayMode: opener.delimiter.display,
        maxExpand: 1000,
        throwOnError: true,
        trust: false,
        xml: true,
      });
      output += text.slice(cursor, opener.index) + mathml;
      cursor = rawEnd;
      changed = true;
    } catch {
      // Unsupported publisher macros should remain readable TeX rather than
      // dropping the expression or failing the whole feed parse.
      output += text.slice(cursor, rawEnd);
      cursor = rawEnd;
    }
  }

  if (!changed) return text;
  return output + text.slice(cursor);
}

/**
 * Converts TeX delimiters in feed HTML/text to native presentation MathML.
 *
 * Feed publishers such as arXiv put `$…$` TeX in RSS descriptions even though
 * their article pages contain MathML. Conversion happens in the proxy so every
 * client/view receives the same cacheable markup and the browser needs no math
 * runtime. Existing MathML and literal/code contexts are left untouched.
 */
export function convertLatexToMathML(content: string | undefined): string | undefined {
  if (!content || (!content.includes('$') && !content.includes('\\'))) return content;

  const { document } = parseHTML(
    '<!doctype html><html><body><div id="skyreader-math-root"></div></body></html>'
  );
  const root = document.getElementById('skyreader-math-root');
  if (!root) return content;
  root.innerHTML = content;

  function visit(node: Node): void {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        const original = child.textContent ?? '';
        const rendered = renderTextMath(original);
        if (rendered === original) continue;

        const holder = document.createElement('span');
        holder.innerHTML = rendered;
        child.replaceWith(...holder.childNodes);
        continue;
      }

      if (child.nodeType !== 1) continue;
      const element = child as Element;
      if (!IGNORED_TAGS.has(element.localName.toLowerCase())) visit(element);
    }
  }

  visit(root);
  return root.innerHTML;
}
