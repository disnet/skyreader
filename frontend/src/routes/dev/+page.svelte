<script lang="ts">
  // /dev index — the catalog of every component harness. Lists each route from
  // the registry so humans and agents can iterate on the design with no auth and
  // no backend. Dev-only (the whole tree 404s in production; see +layout.ts).
  import { harnesses } from './_harness/registry';
</script>

<div class="catalog">
  <header class="head">
    <h1>Skyreader dev harnesses</h1>
    <p>
      Isolated component canvases — no login, no backend, just app.css design tokens. Pick a route
      to iterate on that surface, then the change flows to the real app through the same components.
    </p>
  </header>

  <ul class="grid">
    {#each harnesses as harness (harness.slug)}
      <li>
        <a class="card" href="/dev/{harness.slug}">
          <h2>{harness.title}</h2>
          <p class="desc">{harness.description}</p>
          <div class="chips">
            {#each harness.components as component (component)}
              <span class="chip">{component}</span>
            {/each}
          </div>
        </a>
      </li>
    {/each}
  </ul>
</div>

<style>
  .catalog {
    min-height: 100vh;
    background: var(--color-bg, #fff);
    color: var(--color-text, #111);
    padding: 2rem 1.5rem 4rem;
    max-width: 960px;
    margin: 0 auto;
  }

  .head {
    margin-bottom: 2rem;
  }

  .head h1 {
    font-size: var(--text-xl);
    font-weight: var(--weight-semibold);
    margin: 0 0 0.5rem;
  }

  .head p {
    margin: 0;
    max-width: 68ch;
    font-size: var(--text-md);
    color: var(--color-text-secondary, #666);
  }

  .grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1rem;
  }

  .card {
    display: block;
    height: 100%;
    padding: 1.25rem;
    border: 1px solid var(--color-border, #e5e5e5);
    border-radius: 10px;
    text-decoration: none;
    color: inherit;
    background: var(--color-bg, #fff);
    transition: border-color 0.12s ease;
  }

  .card:hover {
    border-color: var(--color-primary, #0066cc);
  }

  .card h2 {
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    margin: 0 0 0.4rem;
  }

  .desc {
    margin: 0 0 0.85rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary, #666);
    line-height: 1.45;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .chip {
    font-size: var(--text-xs);
    color: var(--color-text-secondary, #555);
    background: var(--color-bg-secondary, #f4f4f4);
    border-radius: 999px;
    padding: 0.15rem 0.55rem;
  }
</style>
