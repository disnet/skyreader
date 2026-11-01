// Expands the app shell's two named media queries.
//
// Styles write `@media (--shell-framed) { … }` or `@media (--shell-mobile) { … }`
// (custom-media syntax) instead of spelling out the breakpoint, because the
// breakpoint is no longer one width: it depends on the pointer too. See
// src/lib/utils/shellMedia.js, which the JS side reads as well, so the two can't
// drift. Runs over app.css and every component's <style> (via vitePreprocess).

import { SHELL_FRAMED_QUERY, SHELL_MOBILE_QUERY } from './src/lib/utils/shellMedia.js';

const NAMED = {
  '--shell-framed': SHELL_FRAMED_QUERY,
  '--shell-mobile': SHELL_MOBILE_QUERY,
};

/** @type {import('postcss').PluginCreator<void>} */
const shellMedia = () => ({
  postcssPlugin: 'skyreader-shell-media',
  AtRule: {
    media(atRule) {
      const name = atRule.params.trim().replace(/^\(\s*|\s*\)$/g, '');
      if (name in NAMED) {
        atRule.params = NAMED[/** @type {keyof typeof NAMED} */ (name)];
      } else if (/--shell-/.test(atRule.params)) {
        throw atRule.error(
          `Unknown or combined shell media query "${atRule.params}". Use (--shell-framed) or (--shell-mobile) on its own.`
        );
      }
    },
  },
});
shellMedia.postcss = true;

export default shellMedia;
