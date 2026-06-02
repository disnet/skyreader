<script lang="ts">
  // Resets the layout tree (the `@` escapes the auth-gated root +layout), so the
  // dev canvas renders against app.css design tokens only — no Sidebar, no auth.
  import '../../app.css';

  let { children } = $props();
</script>

{@render children()}
