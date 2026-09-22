/**
 * Hydrates the `.op-math[data-tex]` placeholders the document renderers emit.
 *
 * The TeX parser (~250 KB) is imported here, on demand, so it costs nothing on the
 * card path that renders every article — a document without math never loads it. Its
 * stylesheet rides the same dynamic import, because Temml positions stretchy
 * delimiters and radicals from CSS classes that nothing else in the app defines. That
 * stylesheet is written for a page Temml owns (bare `math`, `math > mrow`, …), so it
 * is scoped under `.op-math` before it goes in — otherwise one Leaflet equation would
 * restyle every native MathML article (arXiv, LaTeXML) for the rest of the session.
 *
 * Until it resolves — and forever, if it fails to — the placeholder's own `<pre>` of
 * TeX source stays on screen, which is the honest degradation: the equation as the
 * author typed it rather than a blank.
 */

type Temml = { renderToString: (tex: string, options?: Record<string, unknown>) => string };

let parser: Promise<Temml | null> | null = null;

function loadTemml(): Promise<Temml | null> {
  parser ??= (async () => {
    try {
      const [module, css] = await Promise.all([
        import('temml'),
        // Fonts and layout for the MathML the parser emits. Failing to load it is
        // not a reason to drop the equation, so it is awaited but never thrown on.
        import('temml/dist/Temml-Local.css?inline').catch(() => null),
      ]);
      if (css) installScopedStyles(css.default);
      return (module.default ?? module) as unknown as Temml;
    } catch {
      return null;
    }
  })();
  return parser;
}

const SCOPE = '.op-math';

/** Prefix each selector in a list with the math scope. `body` rules (the equation
 *  counter reset) stay global: numbering runs across the whole document. */
function scopeSelector(selectorText: string): string {
  return selectorText
    .split(',')
    .map((part) => part.trim())
    .map((part) => (/^body\b/.test(part) ? part : `${SCOPE} ${part}`))
    .join(', ');
}

function scopeRules(rules: CSSRuleList): string {
  let out = '';
  for (const rule of Array.from(rules)) {
    if ('selectorText' in rule && 'style' in rule) {
      const styleRule = rule as CSSStyleRule;
      out += `${scopeSelector(styleRule.selectorText)} { ${styleRule.style.cssText} }\n`;
    } else if ('conditionText' in rule && 'cssRules' in rule) {
      const group = rule as CSSConditionRule;
      const at = rule instanceof CSSMediaRule ? '@media' : '@supports';
      out += `${at} ${group.conditionText} {\n${scopeRules(group.cssRules)}}\n`;
    } else {
      // @font-face and anything else without a selector applies as-is.
      out += `${rule.cssText}\n`;
    }
  }
  return out;
}

/** Parse Temml's stylesheet, rewrite it under `.op-math`, and add it to the page. */
export function installScopedStyles(css: string): void {
  const style = document.createElement('style');
  // Parsed while inert, so the unscoped rules never apply even for a frame.
  style.media = 'not all';
  style.textContent = css;
  document.head.append(style);
  try {
    style.textContent = style.sheet ? scopeRules(style.sheet.cssRules) : '';
    style.removeAttribute('media');
  } catch {
    style.remove();
  }
}

async function hydrateMath(element: Element): Promise<void> {
  const tex = element.getAttribute('data-tex');
  if (!tex) return;
  element.setAttribute('data-math-hydrated', 'true');

  const temml = await loadTemml();
  if (!temml) return;
  try {
    element.innerHTML = temml.renderToString(tex, { displayMode: true, throwOnError: true });
  } catch {
    // Malformed TeX: keep the source, which is more use than an error box.
  }
}

/** Render every unhydrated math placeholder under `node`. Awaitable, for tests. */
export async function hydrateMathIn(node: ParentNode): Promise<void> {
  const targets = [...node.querySelectorAll('.op-math[data-tex]:not([data-math-hydrated])')];
  await Promise.all(targets.map(hydrateMath));
}

/** Svelte action: render every math placeholder inside a container, and any added later. */
export function mathRender(node: HTMLElement) {
  const hydrate = () => void hydrateMathIn(node);

  hydrate();

  const observer = new MutationObserver(() => hydrate());
  observer.observe(node, { childList: true, subtree: true });

  return {
    destroy() {
      observer.disconnect();
    },
  };
}
