<script lang="ts">
  // The landing page's middle: one article's life, told by the scroll. On a
  // wide screen the stage stays put beside the beats and changes scene as each
  // beat reaches the middle of the viewport, with its clock moving forward. On
  // a phone there's no room for a stage beside the text, so each beat carries
  // its own frame above it and nothing depends on scroll position.
  //
  // Without JS, or before the observer fires, the stage shows the first scene
  // and the phone frames are all there, so nothing is hidden behind motion.
  import type { Snippet } from 'svelte';
  import StoryStage from './StoryStage.svelte';
  import { STORY_BEATS } from './story';

  interface Props {
    /** The page's opening (the hero). It sits beside the story's first scene. */
    intro?: Snippet;
  }

  let { intro }: Props = $props();

  let active = $state(0);

  function track(node: HTMLElement, index: number) {
    if (typeof IntersectionObserver === 'undefined') return;
    // A band through the middle of the viewport: the beat crossing it is
    // the one being read.
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) active = index;
      },
      { rootMargin: '-45% 0px -45% 0px' }
    );
    io.observe(node);
    return { destroy: () => io.disconnect() };
  }
</script>

<div class="story">
  <div class="story-grid">
    <div class="words">
      {#if intro}
        <div class="intro" use:track={0}>{@render intro()}</div>
      {/if}
      <ol id="story" class="beats" aria-label="One article, from Tuesday to March">
        {#each STORY_BEATS as beat, i (beat.id)}
          <li class="beat" class:on={i === active} use:track={i}>
            <div class="beat-frame">
              <StoryStage step={i} fit />
            </div>
            <p class="beat-time">{beat.time}</p>
            <h2 class="beat-title">{beat.title}</h2>
            <p class="beat-body">{beat.body}</p>
            {#if beat.aside}<p class="beat-aside">{beat.aside}</p>{/if}
          </li>
        {/each}
      </ol>
    </div>

    <div class="stage-col">
      <div class="stage">
        <StoryStage step={active} />
        <ol class="ticks" aria-hidden="true">
          {#each STORY_BEATS as beat, i (beat.id)}
            <li class:done={i <= active}></li>
          {/each}
        </ol>
      </div>
    </div>
  </div>
</div>

<style>
  .story {
    --stage-h: 26rem;
    max-width: 72rem;
    margin: 0 auto;
  }
  .intro {
    max-width: 34rem;
    margin: 0 auto clamp(3rem, 9vw, 4.5rem);
  }
  .beats {
    scroll-margin-top: 4.5rem;
  }

  /* ── Phone first: each beat is a frame and its words ─────── */
  .beats {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: clamp(3.5rem, 10vw, 5rem);
  }
  .beat {
    max-width: 34rem;
    margin: 0 auto;
    width: 100%;
  }
  .beat-frame {
    margin-bottom: 1.25rem;
  }
  .beat-time {
    margin: 0 0 0.35rem;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    font-variant-numeric: tabular-nums;
    color: var(--color-primary);
  }
  .beat-title {
    margin: 0;
    font-size: clamp(1.3rem, 2.4vw, 1.6rem);
    font-weight: var(--weight-bold);
    line-height: 1.2;
    letter-spacing: -0.015em;
    text-wrap: balance;
  }
  .beat-body {
    margin: 0.6rem 0 0;
    font-size: var(--text-lg);
    line-height: var(--leading-relaxed);
    color: var(--color-text-secondary);
    text-wrap: pretty;
  }
  .beat-aside {
    margin: 0.75rem 0 0;
    font-size: var(--text-sm);
    line-height: var(--leading-relaxed);
    color: var(--color-text-secondary);
  }
  .stage-col {
    display: none;
  }

  /* ── Wide: words on the left, one stage held on the right ─ */
  @media (min-width: 900px) {
    .story-grid {
      display: grid;
      grid-template-columns: minmax(0, 0.85fr) minmax(0, 1fr);
      gap: clamp(2.5rem, 5vw, 5rem);
    }
    .intro {
      /* The first viewport: the opening, level with the first scene. */
      min-height: calc(100svh - 4rem);
      display: flex;
      flex-direction: column;
      justify-content: center;
      max-width: 36rem;
      margin: 0;
    }
    .beats {
      gap: 0;
    }
    .beat {
      min-height: 72vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      max-width: 26rem;
      margin: 0;
      opacity: 0.35;
      transition: opacity 0.4s ease;
    }
    .beat.on {
      opacity: 1;
    }
    .beat-frame {
      display: none;
    }
    .stage-col {
      display: block;
    }
    .stage-col {
      /* Start where the sticky stage will hold, so it doesn't jump. */
      padding-top: calc(50svh - var(--stage-h) / 2 - 4rem);
    }
    .stage {
      position: sticky;
      top: calc(50svh - var(--stage-h) / 2);
    }
    .ticks {
      list-style: none;
      display: flex;
      gap: 0.4rem;
      margin: 1rem 0 0;
      padding: 0;
    }
    .ticks li {
      flex: 1;
      height: 3px;
      border-radius: 2px;
      background: var(--color-border);
      transition: background-color 0.35s ease;
    }
    .ticks li.done {
      background: var(--color-primary);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .beat,
    .ticks li {
      transition: none;
    }
  }
</style>
