<script lang="ts">
  import '../app.css';

  let { children } = $props();
</script>

<main class="wrap">
  {@render children()}
</main>
