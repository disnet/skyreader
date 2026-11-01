import colorScheme from './postcss.color-scheme.js';
import shellMedia from './postcss.shell-media.js';

// Vite runs this over app.css, and vitePreprocess runs it over every Svelte
// component's <style>. See postcss.color-scheme.js and postcss.shell-media.js.
export default {
  plugins: [shellMedia(), colorScheme()],
};
