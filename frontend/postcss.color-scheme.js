// Lets the Settings theme choice (System / Light / Dark) override the OS.
//
// Every dark style in the app is written the plain way, as
// `@media (prefers-color-scheme: dark) { … }`, and should stay that way — it
// is what a contributor reaches for, and it is right for the default, which
// follows the system. But a media query can't be overridden from JS, so this
// rewrites each such block into two copies of its rules:
//
//   @media (prefers-color-scheme: dark) {
//     :where(:root:not([data-theme='light'])) .card { … }  ← system dark, unless pinned light
//   }
//   :where(:root[data-theme='dark']) .card { … }           ← pinned dark, whatever the OS says
//
// `<html data-theme>` is set by the inline script in app.html (before first
// paint) and by `applyColorScheme` (src/lib/utils/colorScheme.ts); it is absent
// when following the system. The guards sit in `:where()`, so each rule keeps
// exactly the specificity it was written with, and the pinned copy lands right
// after the media block, so source order is unchanged too — the cascade
// resolves just as it did. A selector that already starts at the root
// (`:root`, `html`) takes the guard on that compound instead of a descendant.
//
// Svelte scopes component styles, so inside a .svelte file the guard is
// wrapped in `:global(…)`. vitePreprocess runs this config over component
// styles with a `from` of `Component.svelte?lang.css`, which is how they're told
// apart from app.css.

const ATTR = 'data-theme';
const DARK_QUERY = /\(\s*prefers-color-scheme\s*:\s*dark\s*\)/i;
const ROOT_START = /^(:global\()?(:root|html)(?![\w-])/;

/** @param {string} params */
function isDarkQuery(params) {
  return DARK_QUERY.test(params);
}

/**
 * The query with the dark feature taken out, or '' if nothing else is left.
 * Only `a and (prefers-color-scheme: dark)` shapes occur; a query list or a
 * `not`/`or` around the feature can't be split this way and is left alone.
 * @param {string} params
 */
function withoutDark(params) {
  return params
    .replace(/\s+and\s+\(\s*prefers-color-scheme\s*:\s*dark\s*\)/i, '')
    .replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s+and\s+/i, '')
    .replace(DARK_QUERY, '')
    .trim();
}

/** @param {string} params */
function isSplittable(params) {
  return !/,|\bnot\b|\bor\b|\bonly\b/i.test(params);
}

/**
 * @param {string} selector
 * @param {string} guard   attribute condition for the root, e.g. `[data-theme='dark']`
 * @param {boolean} svelte wrap the guard in `:global()`
 */
export function guardSelector(selector, guard, svelte) {
  const trimmed = selector.trim();
  const root = ROOT_START.exec(trimmed);
  if (root) {
    // `:root` / `html` / `:global(:root…)`: guard that same element.
    const end = root[0].length;
    return `${trimmed.slice(0, end)}:where(${guard})${trimmed.slice(end)}`;
  }
  const prefix = `:where(:root${guard})`;
  return `${svelte ? `:global(${prefix})` : prefix} ${trimmed}`;
}

/**
 * @param {import('postcss').Container} container
 * @param {string} guard
 * @param {boolean} svelte
 */
function guardRules(container, guard, svelte) {
  container.each((node) => {
    if (node.type === 'rule') {
      // Keyframe steps aren't selectors.
      if (node.parent?.type === 'atrule' && /keyframes$/i.test(node.parent.name)) return;
      node.selectors = node.selectors.map((s) => guardSelector(s, guard, svelte));
    } else if (node.type === 'atrule' && node.nodes && !/keyframes$/i.test(node.name)) {
      guardRules(node, guard, svelte);
    }
  });
}

/** @type {import('postcss').PluginCreator<void>} */
const colorScheme = () => {
  return {
    postcssPlugin: 'skyreader-color-scheme',
    Once(root, { result, AtRule }) {
      const svelte = /\.svelte(\?|$)/.test(result.opts.from ?? '');
      root.walkAtRules('media', (media) => {
        if (!isDarkQuery(media.params) || !isSplittable(media.params)) return;
        // Only top-level blocks (or inside other at-rules); a block nested in a
        // style rule holds declarations, which a selector guard can't reach.
        for (let p = media.parent; p && p.type !== 'root'; p = p.parent) {
          if (p.type === 'rule') return;
        }
        // Already rewritten: Vite runs PostCSS again over a component's
        // compiled CSS (`?svelte&type=style`), after vitePreprocess has.
        if (media.toString().includes(`[${ATTR}=`)) return;

        const pinned = media.clone();
        guardRules(media, `:not([${ATTR}='light'])`, svelte);
        guardRules(pinned, `[${ATTR}='dark']`, svelte);

        const rest = withoutDark(media.params);
        if (rest) {
          media.after(new AtRule({ name: 'media', params: rest, nodes: pinned.nodes }));
        } else {
          media.after(pinned.nodes);
        }
      });
    },
  };
};
colorScheme.postcss = true;

export default colorScheme;
