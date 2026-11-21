<script lang="ts">
  // One frame of the landing page's story: the same sample article, drawn the
  // way Skyreader shows it at each point in its life. `step` picks the scene;
  // every scene is rendered and stacked in one grid cell, so the frame keeps
  // the tallest scene's height and switching is a crossfade, not a reflow.
  //
  // Everything in here is a sample (article, people, sites), drawn from the
  // app's own patterns rather than screenshots, and the frame says so. It's an
  // illustration: the beat beside it carries the words, so the frame is hidden
  // from assistive tech.
  import Icon from '$lib/components/Icon.svelte';
  import { STORY_ARTICLE as A, STORY_BEATS } from './story';

  interface Props {
    step: number;
    /** Size to this scene alone (a fixed frame per beat) rather than to the tallest. */
    fit?: boolean;
  }

  let { step, fit = false }: Props = $props();

  const feed = [
    { title: A.title, src: 'The Marginalian', icon: 'rss', at: '7:02', mine: true },
    { title: 'A Notebook Fit for a Walk', src: 'Ridgeline, by email', icon: 'mail', at: '6:40' },
    { title: 'The power of group thought', src: 'Psyche · Video', icon: 'globe', at: '6:15' },
    {
      title: 'Why anything exists',
      src: 'Shared by Ana Ruiz on Bluesky',
      icon: 'bluesky',
      at: '5:58',
    },
    {
      title: 'Typewriter interview with Grant Snider',
      src: 'Austin Kleon',
      icon: 'rss',
      at: '5:30',
    },
  ] as const;

  const discussion = [
    {
      who: 'Ana Ruiz',
      follow: true,
      kind: 'Post',
      icon: 'bluesky',
      text: 'The best thing I read this week. The paper ball in a glass of water is going to stay with me.',
    },
    {
      who: 'Jonah Pell',
      follow: false,
      kind: 'Linkblog',
      icon: 'link',
      text: 'Read it next to anything you’ve been meaning to care about more.',
    },
    {
      who: 'Sam Oduya',
      follow: false,
      kind: 'Annotation',
      icon: 'highlighter',
      text: 'On “the quality of attention”: the whole piece in five words.',
    },
  ] as const;
</script>

<div class="frame" class:fit aria-hidden="true">
  <div class="bar">
    <span class="where">
      {#each STORY_BEATS as beat, i (beat.id)}
        <span class="where-label" class:on={i === step}>{beat.place}</span>
      {/each}
    </span>
    <span class="sample">Sample</span>
  </div>

  <div class="scenes">
    <!-- 0 · Feeds: one list, in order -->
    {#if !fit || step === 0}
      <section class="scene" class:on={step === 0}>
        <p class="list-head">Today <span>5 new</span></p>
        <ul class="feed">
          {#each feed as row (row.title)}
            <li class="row" class:mine={'mine' in row}>
              <span class="row-icon"><Icon name={row.icon} size={14} /></span>
              <span class="row-body">
                <span class="row-title">{row.title}</span>
                <span class="row-meta">{row.src} · {row.at}</span>
              </span>
              {#if 'mine' in row}<span class="dot" title="Unread"></span>{/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <!-- 1 · Reader: just the words, offline -->
    {#if !fit || step === 1}
      <section class="scene" class:on={step === 1}>
        <div class="reader">
          <p class="status"><span class="status-dot"></span>Offline · reading from this device</p>
          <p class="byline">{A.site} · {A.author} · {A.minutes} min</p>
          <p class="title">{A.title}</p>
          <p class="prose">{A.para1}</p>
          <p class="prose">{A.before}{A.passage}{A.after}</p>
        </div>
      </section>
    {/if}

    <!-- 2 · Reader: highlight + margin note -->
    {#if !fit || step === 2}
      <section class="scene" class:on={step === 2}>
        <div class="reader reader--marked">
          <p class="status status--saved"><Icon name="bookmark" size={12} /> Saved</p>
          <p class="byline">{A.site} · {A.author} · {A.minutes} min</p>
          <p class="title">{A.title}</p>
          <p class="prose prose--faint">{A.para1}</p>
          <div class="marked">
            <p class="prose">
              {A.before}<mark class="hl">{A.passage}</mark>{A.after}
            </p>
            <span class="note">{A.note}</span>
          </div>
        </div>
      </section>
    {/if}

    <!-- 3 · Discussion at the end of the article -->
    {#if !fit || step === 3}
      <section class="scene" class:on={step === 3}>
        <div class="reader">
          <p class="prose prose--faint end">…{A.closing}</p>
          <p class="disc-head">Discussion <span>6</span></p>
          <ul class="disc">
            {#each discussion as d (d.who)}
              <li class="disc-row">
                <span class="avatar">{d.who[0]}</span>
                <span class="disc-body">
                  <span class="disc-who">
                    {d.who}
                    {#if d.follow}<span class="follow">You follow</span>{/if}
                    <span class="disc-kind"><Icon name={d.icon} size={11} /> {d.kind}</span>
                  </span>
                  <span class="disc-text">{d.text}</span>
                </span>
              </li>
            {/each}
          </ul>
        </div>
      </section>
    {/if}

    <!-- 4 · New connection on Home: the loop closes -->
    {#if !fit || step === 4}
      <section class="scene" class:on={step === 4}>
        <p class="list-head">New connections <span>1</span></p>
        <div class="conn">
          <p class="conn-save">
            <Icon name="bookmark" size={12} /> Your save · <strong>{A.title}</strong>
          </p>
          <div class="conn-edge">
            <span class="avatar avatar--sm">T</span>
            <span><strong>Theo Marsh</strong> connected it to</span>
          </div>
          <div class="conn-target">
            <span class="conn-rel">related</span>
            <span class="conn-title">{A.next.title}</span>
            <span class="row-meta">{A.next.site}</span>
          </div>
          <p class="conn-note">“{A.next.note}”</p>
        </div>
        <ul class="feed feed--after">
          <li class="row mine">
            <span class="row-icon"><Icon name="book-open" size={14} /></span>
            <span class="row-body">
              <span class="row-title">{A.next.title}</span>
              <span class="row-meta">Opened from the connection · {A.next.minutes} min</span>
            </span>
          </li>
        </ul>
      </section>
    {/if}

    <!-- 5 · Review deck -->
    {#if !fit || step === 5}
      <section class="scene" class:on={step === 5}>
        <p class="list-head">Review <span>3 of 5</span></p>
        <div class="card">
          <p class="card-quote"><mark class="hl">{A.passage}</mark></p>
          <p class="note note--inline">{A.note}</p>
          <p class="row-meta">{A.title} · {A.site} · highlighted 3 weeks ago</p>
        </div>
        <div class="intents">
          <span class="intent on">Soon</span>
          <span class="intent">Later</span>
          <span class="intent">Someday</span>
        </div>
      </section>
    {/if}

    <!-- 6 · In your notes app, with citation details -->
    {#if !fit || step === 6}
      <section class="scene" class:on={step === 6}>
        <div class="vault">
          <p class="vault-path">Reading / {A.title}.md</p>
          <dl class="props">
            <dt>author</dt>
            <dd>{A.author}</dd>
            <dt>url</dt>
            <dd>{A.url}</dd>
            <dt>saved</dt>
            <dd>2026-11-17</dd>
          </dl>
          <p class="md-h">## Highlights</p>
          <p class="md-quote">&gt; {A.passage}</p>
          <p class="md-text">{A.note}</p>
          <p class="md-mine">In my talk: open with this, then the orchid thief.</p>
        </div>
      </section>
    {/if}
  </div>
</div>

<style>
  .frame {
    --hl: color-mix(in srgb, #f5c518 42%, transparent);
    border: 1px solid var(--color-border);
    border-radius: 14px;
    background: var(--color-bg);
    overflow: hidden;
    font-size: var(--text-sm);
    text-align: left;
    container: story / inline-size;
  }
  /* The held stage floats beside the scrolling text, so it earns a shadow;
     a phone's in-flow frames stay flat. */
  .frame:not(.fit) {
    box-shadow:
      0 1px 2px rgb(0 0 0 / 0.04),
      0 12px 32px -12px rgb(0 0 0 / 0.14);
  }

  /* ── Top bar: where in Skyreader this scene is ──────────── */
  .bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 0.9rem;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg-secondary);
  }
  .where {
    display: grid;
    font-weight: var(--weight-semibold);
    color: var(--color-text);
  }
  .where-label {
    grid-area: 1 / 1;
    opacity: 0;
    transition: opacity 0.35s ease;
    white-space: nowrap;
  }
  .where-label.on {
    opacity: 1;
  }
  .sample {
    margin-left: auto;
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    color: var(--color-text-secondary);
  }

  /* ── Scenes stack in one cell; the active one shows ──────── */
  .scenes {
    display: grid;
  }
  .scene {
    grid-area: 1 / 1;
    padding: 1rem 1.1rem 1.2rem;
    opacity: 0;
    visibility: hidden;
    transform: translateY(6px);
    transition:
      opacity 0.4s ease,
      transform 0.5s cubic-bezier(0.2, 0.7, 0.2, 1),
      visibility 0s linear 0.4s;
  }
  .scene.on {
    opacity: 1;
    visibility: visible;
    transform: none;
    transition:
      opacity 0.4s ease 0.08s,
      transform 0.5s cubic-bezier(0.2, 0.7, 0.2, 1) 0.08s,
      visibility 0s;
  }
  @media (prefers-reduced-motion: reduce) {
    .scene,
    .scene.on,
    .where-label {
      transition: none;
      transform: none;
    }
  }

  /* ── Feed rows ───────────────────────────────────────────── */
  .list-head,
  .disc-head {
    display: flex;
    justify-content: space-between;
    margin: 0 0 0.5rem;
    font-weight: var(--weight-semibold);
  }
  .list-head span,
  .disc-head span {
    font-weight: var(--weight-regular);
    color: var(--color-text-secondary);
  }
  .feed {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    padding: 0.6rem 0.5rem;
    border-top: 1px solid var(--color-border);
    color: var(--color-text-secondary);
  }
  .row.mine {
    color: var(--color-text);
    border-radius: 8px;
    background: color-mix(in srgb, var(--color-primary) 8%, transparent);
    border-top-color: transparent;
  }
  .row.mine + .row {
    border-top-color: transparent;
  }
  .row-icon {
    display: inline-flex;
    flex: none;
    color: var(--color-text-secondary);
  }
  .row-body {
    display: grid;
    min-width: 0;
    flex: 1;
  }
  .row-title {
    font-weight: var(--weight-medium);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row.mine .row-title {
    font-weight: var(--weight-semibold);
  }
  .row-meta {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }
  .dot {
    width: 8px;
    height: 8px;
    flex: none;
    border-radius: 50%;
    background: var(--color-primary);
  }

  /* ── Reader ──────────────────────────────────────────────── */
  .reader {
    max-width: 34rem;
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0 0 0.85rem;
    padding: 0.15rem 0.55rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }
  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-text-secondary);
  }
  .status--saved {
    color: var(--color-primary);
    border-color: color-mix(in srgb, var(--color-primary) 35%, transparent);
  }
  .byline {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }
  .title {
    margin: 0.2rem 0 0.7rem;
    font-family: var(--font-serif);
    font-size: 1.3rem;
    font-weight: var(--weight-bold);
    line-height: 1.2;
    letter-spacing: -0.01em;
  }
  .prose {
    margin: 0 0 0.7rem;
    font-family: var(--font-serif);
    font-size: 0.98rem;
    line-height: 1.6;
    color: var(--color-text);
  }
  .prose--faint {
    color: var(--color-text-secondary);
  }
  .end {
    margin-bottom: 1rem;
  }
  .hl {
    background: var(--hl);
    color: inherit;
    padding: 0.05em 0;
    border-radius: 2px;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  }

  /* Margin note: beside the passage on a wide frame, under it on a narrow one. */
  .marked {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 9.5rem;
    gap: 1rem;
    align-items: start;
  }
  .reader--marked {
    max-width: none;
  }
  .note {
    position: relative;
    padding-left: 0.7rem;
    border-left: 2px solid var(--ink-note-soft);
    font-family: var(--font-hand);
    font-size: 0.95rem;
    line-height: 1.35;
    color: var(--ink-note);
  }
  .note--inline {
    margin: 0.6rem 0;
    display: block;
  }
  @container story (max-width: 30rem) {
    .marked {
      grid-template-columns: 1fr;
      gap: 0.25rem;
    }
  }

  /* ── Discussion ──────────────────────────────────────────── */
  .disc-head {
    padding-top: 0.8rem;
    border-top: 1px solid var(--color-border);
  }
  .disc {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.75rem;
  }
  .disc-row {
    display: flex;
    gap: 0.6rem;
  }
  .avatar {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
  }
  .avatar--sm {
    width: 22px;
    height: 22px;
  }
  .disc-body {
    display: grid;
    gap: 0.1rem;
  }
  .disc-who {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    font-weight: var(--weight-semibold);
  }
  .follow {
    font-size: var(--text-2xs);
    font-weight: var(--weight-medium);
    color: var(--color-primary);
  }
  .disc-kind {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    font-size: var(--text-xs);
    font-weight: var(--weight-regular);
    color: var(--color-text-secondary);
  }
  .disc-text {
    color: var(--color-text);
    line-height: 1.45;
  }

  /* ── New connection ──────────────────────────────────────── */
  .conn {
    border: 1px solid var(--color-border);
    border-radius: 10px;
    padding: 0.8rem 0.9rem;
    display: grid;
    gap: 0.55rem;
  }
  .conn-save {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }
  .conn-save :global(svg) {
    vertical-align: -1px;
  }
  .conn-save strong {
    color: var(--color-text);
    font-weight: var(--weight-medium);
  }
  .conn-edge {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .conn-target {
    display: grid;
    gap: 0.1rem;
    margin-left: 0.7rem;
    padding-left: 0.85rem;
    border-left: 2px solid var(--color-border);
  }
  .conn-rel {
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    color: var(--color-text-secondary);
  }
  .conn-title {
    font-weight: var(--weight-semibold);
    color: var(--color-primary);
  }
  .conn-note {
    margin: 0;
    color: var(--color-text);
    line-height: 1.45;
  }
  .feed--after {
    margin-top: 0.75rem;
  }

  /* ── Review deck ─────────────────────────────────────────── */
  .card {
    border: 1px solid var(--color-border);
    border-radius: 10px;
    padding: 1rem 1rem 0.85rem;
  }
  .card-quote {
    margin: 0;
    font-family: var(--font-serif);
    font-size: 1.05rem;
    line-height: 1.55;
  }
  .intents {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.85rem;
  }
  .intent {
    padding: 0.3rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }
  .intent.on {
    border-color: var(--color-primary);
    color: var(--color-primary);
    background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  }

  /* ── Notes app ───────────────────────────────────────────── */
  .vault {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.6;
    color: var(--color-text);
  }
  .vault-path {
    margin: 0 0 0.6rem;
    color: var(--color-text-secondary);
  }
  .props {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.1rem 0.9rem;
    margin: 0 0 0.8rem;
    padding: 0.6rem 0.75rem;
    border-radius: 8px;
    background: var(--color-bg-secondary);
  }
  .props dt {
    color: var(--color-text-secondary);
  }
  .props dd {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .md-h {
    margin: 0 0 0.35rem;
    font-weight: var(--weight-semibold);
  }
  .md-quote {
    margin: 0;
    padding-left: 0.6rem;
    border-left: 2px solid var(--color-border);
  }
  .md-text {
    margin: 0.35rem 0 0.8rem;
    color: var(--color-text-secondary);
  }
  .md-mine {
    margin: 0;
    padding-top: 0.6rem;
    border-top: 1px dashed var(--color-border);
    color: var(--color-primary);
  }
</style>
