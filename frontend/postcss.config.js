import colorScheme from './postcss.color-scheme.js';

// Vite runs this over app.css, and vitePreprocess runs it over every Svelte
// component's <style>. See postcss.color-scheme.js.
export default {
  plugins: [colorScheme()],
};
