<script lang="ts">
  // Resets the layout tree (the `@` escapes the auth-gated root +layout), so the
  // dev canvas renders against app.css design tokens only — no Sidebar, no auth.
  import '../../app.css';

  let { children } = $props();
</script>

{@render children()}

<style>
  /* The canvas has no Sidebar, so the content column is the whole window.
     Zero the sidebar width here and anything that insets by it (the share
     composer drawer) centers on the canvas instead of hanging off to the right. */
  :global(body) {
    --sidebar-width: 0px;
  }
</style>
