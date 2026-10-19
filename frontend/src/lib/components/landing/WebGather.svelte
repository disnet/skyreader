<script lang="ts">
  // The landing page's opening: the web as it usually arrives (a blog behind a
  // cookie banner, a newsletter in an inbox, a video in its player, a post
  // wrapped in counts, plus tabs and pop-ups that are only noise) piles up
  // around the headline. Then the clutter falls away, and what's left of each
  // page, its title and opening line, slides onto the matching card in the app
  // shot underneath. AppShowcase fades its frame in as these fade out.
  //
  // Decoration only: it's hidden from assistive tech and takes no pointer, and
  // AppShowcase leaves it out entirely under reduced motion.
  import { onMount } from 'svelte';
  import { timelineCards } from './showcaseData';

  interface Props {
    /** The cards the pages settle onto, in timelineCards order. */
    targets: () => (Element | null)[];
    /** The app frame: a page whose card sits below its bottom edge fades out instead. */
    frame: () => Element | null;
    /** The clutter is gone and the pages are on their way to the list. */
    onsettle: () => void;
    /** The pages have landed; the frame can take over. */
    onland: () => void;
    /** Finished: the layer can go. */
    ondone: () => void;
  }

  let { targets, frame, onsettle, onland, ondone }: Props = $props();

  type Phase = 'pile' | 'in' | 'strip' | 'settle' | 'land';
  let phase = $state<Phase>('pile');
  let layerEl = $state<HTMLElement | null>(null);

  /** A card's body as plain paragraphs, the way its card lays them out. */
  const paras = (html: string | undefined) =>
    (html ?? '')
      .split(/<\/p>/)
      .map((p) => p.replace(/<[^>]+>/g, '').trim())
      .filter(Boolean);
  const [blog, mail, video, post, doc] = timelineCards;

  // Where each piece sits in the pile, as [left, top, width]: left and width
  // are fractions of the layer's width, top is px from the layer's top. Wide
  // layouts reach up beside the headline, which is left-aligned with room to
  // its right; narrow ones pile below it.
  type Spot = [number, number, number];
  interface Piece {
    id: string;
    /** Which timelineCards entry it settles onto; noise has none and just leaves. */
    row?: number;
    wide: Spot;
    narrow: Spot;
  }
  const pieces: Piece[] = [
    { id: 'tabs', wide: [0.02, 6, 0.58], narrow: [0, 0, 1] },
    { id: 'blog', row: 0, wide: [0.04, 52, 0.31], narrow: [0, 40, 0.86] },
    { id: 'mail', row: 1, wide: [0.31, 104, 0.29], narrow: [0.1, 124, 0.86] },
    { id: 'video', row: 2, wide: [0.63, -292, 0.35], narrow: [0.14, 214, 0.86] },
    { id: 'post', row: 3, wide: [0.72, 196, 0.26], narrow: [0.04, 334, 0.86] },
    { id: 'doc', row: 4, wide: [0.47, 300, 0.27], narrow: [0.12, 424, 0.86] },
    { id: 'toast', wide: [0.8, -392, 0.19], narrow: [0.36, 404, 0.62] },
    { id: 'popup', wide: [0.18, 236, 0.24], narrow: [0.08, 300, 0.78] },
  ];
  const WIDE = 1000;

  interface Box {
    left: number;
    top: number;
    width: number;
    height: number | null;
    gone: boolean;
  }
  let boxes = $state<Record<string, Box>>({});
  const els: Record<string, HTMLElement> = {};
  const cores: Record<string, HTMLElement> = {};

  function pile() {
    if (!layerEl) return;
    const w = layerEl.clientWidth;
    const wide = w >= WIDE;
    const next: Record<string, Box> = {};
    for (const p of pieces) {
      const [x, y, pw] = wide ? p.wide : p.narrow;
      next[p.id] = { left: x * w, top: y, width: pw * w, height: null, gone: false };
    }
    boxes = next;
  }

  /** Each piece shrinks to just its words: the core, at the width it already has. */
  function strip() {
    const next = { ...boxes };
    for (const p of pieces) {
      if (p.row === undefined) next[p.id] = { ...next[p.id], gone: true };
      else if (cores[p.id]) next[p.id] = { ...next[p.id], height: cores[p.id].offsetHeight };
    }
    boxes = next;
  }

  function settle() {
    if (!layerEl) return;
    const base = layerEl.getBoundingClientRect();
    const cards = targets();
    const bottom = frame()?.getBoundingClientRect().bottom ?? Infinity;
    const next = { ...boxes };
    for (const p of pieces) {
      if (p.row === undefined) continue;
      const r = cards[p.row]?.getBoundingClientRect();
      if (!r) {
        next[p.id] = { ...next[p.id], gone: true };
        continue;
      }
      next[p.id] = {
        left: r.left - base.left,
        top: r.top - base.top,
        width: r.width,
        height: r.height,
        // Its card is out of the frame's view: let it go rather than land on nothing.
        gone: r.top > bottom - 48,
      };
    }
    boxes = next;
  }

  function play(at: (ms: number, fn: () => void) => void) {
    // Measure the pile's natural heights so the later shrink can animate.
    at(30, () => {
      const next = { ...boxes };
      for (const p of pieces) {
        const el = els[p.id];
        if (el) next[p.id] = { ...next[p.id], height: el.offsetHeight };
      }
      boxes = next;
      phase = 'in';
    });
    at(1800, () => {
      phase = 'strip';
      strip();
    });
    at(2800, () => {
      phase = 'settle';
      settle();
      onsettle();
    });
    at(3700, () => {
      phase = 'land';
      onland();
    });
    at(4400, ondone);
  }

  onMount(() => {
    pile();
    const t: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, fn: () => void) => t.push(setTimeout(fn, ms));
    // A wide pile reaches up beside the headline, so it plays at once. A
    // narrow one sits below the headline, so it waits until it's well into
    // view; otherwise it would settle where nobody sees it.
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        play(at);
      },
      { rootMargin: '0px 0px -40% 0px' }
    );
    if (layerEl && layerEl.clientWidth < WIDE) io.observe(layerEl);
    else play(at);

    // A resize mid-play re-reads the targets; before the settle it re-piles.
    const onResize = () => {
      if (phase === 'settle' || phase === 'land') settle();
      else if (phase === 'pile' || phase === 'in') pile();
    };
    window.addEventListener('resize', onResize);
    return () => {
      io.disconnect();
      t.forEach(clearTimeout);
      window.removeEventListener('resize', onResize);
    };
  });

  function place(id: string) {
    const b = boxes[id];
    if (!b) return '';
    return `left:${b.left}px;top:${b.top}px;width:${b.width}px;${b.height === null ? '' : `height:${b.height}px;`}`;
  }
</script>

{#snippet head(card: (typeof timelineCards)[number])}
  <div class="head">
    <img src={card.faviconUrl} alt="" />
    <h3>{card.itemTitle}</h3>
    <span class="src">{card.displayFeedTitle} · {card.relativeDate}</span>
  </div>
{/snippet}

<div class="gather {phase}" bind:this={layerEl} aria-hidden="true">
  <!-- Noise: these leave entirely. -->
  <div
    class="piece noise tabs"
    class:gone={boxes.tabs?.gone}
    style={place('tabs')}
    bind:this={els.tabs}
  >
    {#each [blog.itemTitle, 'Inbox (1,284)', video.itemTitle, 'Bluesky', post.itemTitle, doc.itemTitle, '(3) Notifications', 'Close Reading.pdf', 'Untitled', 'Sign in', 'Sale ends tonight'] as tab, i (i)}
      <span>{tab}</span>
    {/each}
  </div>

  <div
    class="piece web blog"
    class:gone={boxes.blog?.gone}
    style={place('blog')}
    bind:this={els.blog}
  >
    <div class="chrome blog-nav">
      <b>{blog.displayFeedTitle?.toUpperCase()}</b>Essays&ensp;Archive<span class="pill"
        >Subscribe</span
      >
    </div>
    <div class="core" bind:this={cores.blog}>
      {@render head(blog)}
      {#each paras(blog.sanitizedContent) as para, i (i)}<p>{para}</p>{/each}
    </div>
    <div class="chrome ad">Advertisement</div>
    <div class="chrome cookie">
      <span>We value your privacy. We and our 842 partners use cookies.</span><span class="pill"
        >Accept all</span
      >
    </div>
  </div>

  <div
    class="piece web mail"
    class:gone={boxes.mail?.gone}
    style={place('mail')}
    bind:this={els.mail}
  >
    <div class="chrome">
      <div class="mail-bar">Inbox ▾&ensp;Archive&ensp;Spam<b>1,284 unread</b></div>
      <div class="mail-from">
        {mail.displayFeedTitle} &lt;hello@slowweb.example&gt;<u>View in browser</u>
      </div>
      <div class="mail-band">{mail.displayFeedTitle?.toUpperCase()} · No. 112</div>
    </div>
    <div class="core" bind:this={cores.mail}>
      {@render head(mail)}
      {#each paras(mail.sanitizedContent) as para, i (i)}<p>{para}</p>{/each}
    </div>
    <div class="chrome mail-foot">
      <span class="pill">Upgrade to paid · $8/mo</span>
      <span>You're receiving this because you signed up. Unsubscribe</span>
    </div>
  </div>

  <div
    class="piece web video"
    class:gone={boxes.video?.gone}
    style={place('video')}
    bind:this={els.video}
  >
    <div class="chrome player"><span class="play"></span></div>
    <div class="core" bind:this={cores.video}>
      {@render head(video)}
      {#each paras(video.sanitizedContent) as para, i (i)}<p>{para}</p>{/each}
    </div>
    <div class="chrome">
      <div class="channel">
        <span class="dot"></span>{video.displayFeedTitle} · 48K<span class="pill">Subscribe</span>
      </div>
      <div class="up-next"><span>Up next · 1.2M views</span><span>Autoplay ●</span></div>
    </div>
  </div>

  <div
    class="piece web post"
    class:gone={boxes.post?.gone}
    style={place('post')}
    bind:this={els.post}
  >
    <div class="chrome post-head">
      <span class="avatar"></span>
      <span
        ><b>Mira Okafor</b> <em>@mira.example · 4h</em><br />best thing I've read on attention all
        year, and it's not close</span
      >
    </div>
    <div class="core" bind:this={cores.post}>
      {@render head(post)}
      {#each paras(post.sanitizedContent) as para, i (i)}<p>{para}</p>{/each}
    </div>
    <div class="chrome counts">
      <span>17 replies</span><span>38 reposts</span><span>214 likes</span>
    </div>
  </div>

  <div class="piece web doc" class:gone={boxes.doc?.gone} style={place('doc')} bind:this={els.doc}>
    <div class="chrome doc-head">{doc.displayFeedTitle}<span class="pill">Subscribe</span></div>
    <div class="core" bind:this={cores.doc}>
      {@render head(doc)}
      {#each paras(doc.sanitizedContent) as para, i (i)}<p>{para}</p>{/each}
    </div>
    <div class="chrome doc-foot">Sign in to comment · 12 comments</div>
  </div>

  <div
    class="piece noise toast"
    class:gone={boxes.toast?.gone}
    style={place('toast')}
    bind:this={els.toast}
  >
    <span class="dot"></span><span><b>9 new notifications</b>Someone liked your post</span>
  </div>
  <div
    class="piece noise popup"
    class:gone={boxes.popup?.gone}
    style={place('popup')}
    bind:this={els.popup}
  >
    <b>Before you go…</b>Get 50% off your first year.
    <span class="pill">Subscribe now</span>
    <small>No thanks, I like missing out</small>
  </div>
</div>

<style>
  .gather {
    --ease: cubic-bezier(0.22, 0.8, 0.24, 1);
    position: absolute;
    inset: 0;
    z-index: 30;
    pointer-events: none;
  }

  /* A page as the web serves it: its own surface, floating in the pile. The
     colours are the web's, not ours, so they stay literal in both themes. */
  .piece {
    position: absolute;
    overflow: hidden;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 8px;
    background: #fff;
    color: #222;
    text-align: left;
    box-shadow:
      0 12px 32px rgba(0, 0, 0, 0.14),
      0 1px 3px rgba(0, 0, 0, 0.08);
    opacity: 0;
    transform: translateY(14px) scale(0.98);
    transition:
      left 0.9s var(--ease),
      top 0.9s var(--ease),
      width 0.9s var(--ease),
      height 0.7s var(--ease),
      opacity 0.45s var(--ease),
      transform 0.6s var(--ease),
      background-color 0.6s,
      color 0.6s,
      box-shadow 0.6s,
      border-color 0.6s,
      border-radius 0.6s;
  }
  .in .piece,
  .strip .piece,
  .settle .piece {
    opacity: 1;
    transform: none;
  }
  /* The pile builds up over a beat rather than popping in at once. */
  .in .piece:nth-child(2) {
    transition-delay: 0.08s;
  }
  .in .piece:nth-child(3) {
    transition-delay: 0.16s;
  }
  .in .piece:nth-child(4) {
    transition-delay: 0.24s;
  }
  .in .piece:nth-child(5) {
    transition-delay: 0.32s;
  }
  .in .piece:nth-child(6) {
    transition-delay: 0.4s;
  }
  .in .piece:nth-child(7) {
    transition-delay: 0.48s;
  }
  .in .piece:nth-child(8) {
    transition-delay: 0.56s;
  }
  .piece.gone {
    opacity: 0 !important;
    transform: translateY(18px) scale(0.97) !important;
  }
  /* The frame fades in underneath first; then the pages lift off it. */
  .land .piece {
    opacity: 0;
    transition-duration: 0.4s;
    transition-delay: 0.45s;
  }

  .chrome {
    overflow: hidden;
    max-height: 26rem;
    transition:
      opacity 0.35s var(--ease),
      max-height 0.6s var(--ease),
      padding 0.6s var(--ease),
      margin 0.6s var(--ease),
      transform 0.4s var(--ease);
  }
  .strip .chrome,
  .settle .chrome,
  .land .chrome {
    opacity: 0;
    max-height: 0;
    padding-block: 0 !important;
    margin-block: 0 !important;
    border-width: 0 !important;
    transform: translateY(6px);
  }

  .core {
    padding: 0.75rem 0.875rem;
    transition: padding 0.6s var(--ease);
  }
  .core h3 {
    margin: 0;
    transition:
      font-size 0.6s var(--ease),
      color 0.6s;
  }
  .core p {
    margin: 0.25rem 0 0;
    font-size: 0.8125rem;
    line-height: 1.45;
    transition:
      font-size 0.6s,
      color 0.6s;
  }
  /* The card's own head (favicon, source, time) is hidden until the page settles. */
  .head {
    display: flex;
    align-items: baseline;
    gap: 0;
  }
  .head h3 {
    flex: 1;
    min-width: 0;
  }
  .head img,
  .head .src {
    flex: none;
    max-width: 0;
    overflow: hidden;
    opacity: 0;
    white-space: nowrap;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    transition:
      max-width 0.6s var(--ease),
      opacity 0.4s 0.2s,
      margin 0.6s var(--ease);
  }
  .head img {
    align-self: center;
    width: 16px;
    height: 16px;
    border-radius: 3px;
  }
  .head .src {
    margin-left: auto;
  }

  /* Settled: every page is the same quiet card, in the app's own colours. */
  .settle .web,
  .land .web {
    border-color: transparent;
    border-radius: 0;
    background: var(--color-bg);
    color: var(--color-text);
    box-shadow: none;
  }
  /* Lined up with ArticleCardView's own title row and body. */
  .settle .core,
  .land .core {
    padding: 0 1.5rem 0 0.75rem;
  }
  .settle .head,
  .land .head {
    margin-top: -0.3rem;
    padding-left: 1.625rem;
  }
  .head {
    transition:
      padding 0.6s var(--ease),
      margin 0.6s var(--ease);
  }
  .settle .head img,
  .land .head img {
    max-width: 16px;
    margin-right: 0.5rem;
    opacity: 1;
  }
  .settle .head .src,
  .land .head .src {
    max-width: 16rem;
    padding-left: 1rem;
    opacity: 1;
  }
  /* A phone's card puts the source on its own line under the title; the
     title alone lines up better there than a squeezed copy of both. */
  @media (max-width: 600px) {
    .settle .head .src,
    .land .head .src {
      max-width: 0;
      padding-left: 0;
      opacity: 0;
    }
  }
  .settle .core h3,
  .land .core h3 {
    min-width: 0;
    font: var(--weight-regular) var(--text-lg) / 1.4 var(--font-sans, inherit) !important;
    text-align: left !important;
    color: var(--color-primary) !important;
  }
  .settle .core p,
  .land .core p {
    margin-top: 0.55rem;
    font-family: var(--article-font, Georgia, serif) !important;
    font-size: var(--article-font-size, 1.0625rem) !important;
    line-height: 1.8;
    text-align: left !important;
    color: var(--color-text) !important;
  }
  .settle .core p + p,
  .land .core p + p {
    margin-top: 0.8rem;
  }

  .pill {
    display: inline-block;
    padding: 0.25rem 0.6rem;
    border-radius: 4px;
    font-weight: 600;
    white-space: nowrap;
  }

  /* ── The pages, each in its native look ────────────────────── */
  .blog .core h3 {
    font:
      700 1.375rem/1.2 Georgia,
      serif;
  }
  .blog .core p {
    font-family: Georgia, serif;
    font-size: 0.875rem;
  }
  .blog-nav {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 0.875rem;
    border-bottom: 1px solid #eee;
    font-size: 0.6875rem;
    color: #555;
  }
  .blog-nav b {
    margin-right: auto;
    font:
      700 0.8125rem Georgia,
      serif;
    letter-spacing: 0.12em;
    color: #2f6f5e;
  }
  .blog-nav .pill {
    background: #2f6f5e;
    color: #fff;
  }
  .ad {
    display: grid;
    place-items: center;
    height: 4rem;
    margin: 0 0.875rem 0.6rem;
    background: repeating-linear-gradient(45deg, #f1f1f1 0 8px, #e9e9e9 8px 16px);
    font-size: 0.625rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #888;
  }
  .cookie {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.6rem 0.875rem;
    background: #1f2933;
    font-size: 0.71875rem;
    color: #e5e7eb;
  }
  .cookie .pill {
    background: #fbbf24;
    color: #111;
  }

  .mail .chrome {
    font-size: 0.71875rem;
    color: #555;
  }
  .mail-bar {
    display: flex;
    gap: 0.6rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid #e3e6ea;
    background: #f2f4f7;
  }
  .mail-bar b {
    margin-left: auto;
    color: #c0392b;
  }
  .mail-from {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid #eee;
    white-space: nowrap;
    overflow: hidden;
  }
  .mail-from u {
    text-decoration: none;
    color: #2563eb;
  }
  .mail-band {
    padding: 0.75rem;
    background: #8a4b2a;
    font: 700 0.75rem sans-serif;
    letter-spacing: 0.2em;
    text-align: center;
    color: #fff;
  }
  .mail .core h3 {
    font: 800 1.3rem/1.2 sans-serif;
    text-align: center;
  }
  .mail .core p {
    text-align: center;
  }
  .mail-foot {
    display: grid;
    justify-items: center;
    gap: 0.4rem;
    padding: 0 0.75rem 0.75rem;
    font-size: 0.6875rem !important;
    color: #777;
    text-align: center;
  }
  .mail-foot .pill {
    border-radius: 20px;
    background: #8a4b2a;
    color: #fff;
  }

  .video {
    background: #0f0f0f;
    color: #f1f1f1;
  }
  .player {
    position: relative;
    display: grid;
    place-items: center;
    aspect-ratio: 16 / 8.2;
    background: #000;
  }
  .player::after {
    content: '';
    position: absolute;
    left: 0;
    bottom: 0;
    width: 38%;
    height: 3px;
    background: #f00;
  }
  .play {
    display: grid;
    place-items: center;
    width: 3.6rem;
    height: 2.5rem;
    border-radius: 12px;
    background: #f00;
  }
  .play::before {
    content: '';
    margin-left: 4px;
    border-left: 15px solid #fff;
    border-top: 9px solid transparent;
    border-bottom: 9px solid transparent;
  }
  .video .core h3 {
    font:
      700 1rem/1.3 Roboto,
      sans-serif;
  }
  .video .core p {
    color: #aaa;
  }
  .channel {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.875rem 0.6rem;
    font-size: 0.75rem;
    color: #aaa;
  }
  .channel .dot {
    width: 1.6rem;
    height: 1.6rem;
    border-radius: 50%;
    background: #c4302b;
  }
  .channel .pill {
    margin-left: auto;
    border-radius: 16px;
    background: #f1f1f1;
    color: #0f0f0f;
  }
  .up-next {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
    padding: 0 0.875rem 0.75rem;
    font-size: 0.6875rem;
    color: #aaa;
  }
  .up-next span::before {
    content: '';
    display: block;
    aspect-ratio: 16 / 9;
    margin-bottom: 0.25rem;
    border-radius: 6px;
    background: linear-gradient(135deg, #3a3a3a, #232323);
  }

  .post-head {
    display: flex;
    gap: 0.6rem;
    padding: 0.75rem 0.875rem 0;
    font-size: 0.8125rem;
    line-height: 1.35;
  }
  .post-head .avatar {
    flex: none;
    width: 2.1rem;
    height: 2.1rem;
    border-radius: 50%;
    background: linear-gradient(135deg, #f4a261, #e76f51);
  }
  .post-head em {
    font-style: normal;
    color: #6b7280;
  }
  .post .core {
    margin: 0.6rem 0.875rem 0;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    transition:
      margin 0.6s var(--ease),
      border-color 0.6s,
      padding 0.6s var(--ease);
  }
  .settle .post .core,
  .land .post .core {
    margin: 0;
    border-color: transparent;
  }
  .post .core h3 {
    font: 600 0.875rem/1.3 sans-serif;
  }
  .post .core p {
    font-size: 0.75rem;
    color: #6b7280;
  }
  .counts {
    display: flex;
    gap: 1.25rem;
    padding: 0.6rem 0.875rem 0.75rem;
    font-size: 0.75rem;
    color: #6b7280;
  }

  .doc-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.6rem 0.875rem;
    border-bottom: 1px solid #eee;
    font-size: 0.71875rem;
    color: #5b4a9e;
  }
  .doc-head .pill {
    border: 1px solid #5b4a9e;
    border-radius: 12px;
    font-weight: 400;
  }
  .doc .core h3 {
    font: 600 1.2rem/1.25 sans-serif;
    color: #2d2552;
  }
  .doc-foot {
    padding: 0 0.875rem 0.75rem;
    font-size: 0.71875rem;
    color: #888;
  }

  .tabs {
    display: flex;
    gap: 2px;
    padding: 7px 8px 0;
    background: #dee1e6;
  }
  .tabs span {
    flex: 1 1 0;
    min-width: 0;
    height: 1.6rem;
    padding: 0.35rem;
    overflow: hidden;
    border-radius: 7px 7px 0 0;
    background: #eceef1;
    font-size: 0.625rem;
    white-space: nowrap;
    color: #555;
  }
  .tabs span:first-child {
    background: #fff;
  }
  .toast {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.75rem 0.875rem;
    font-size: 0.78rem;
  }
  .toast .dot {
    flex: none;
    width: 1.6rem;
    height: 1.6rem;
    border-radius: 6px;
    background: #6b7280;
  }
  .toast b {
    display: block;
  }
  .popup {
    display: grid;
    justify-items: center;
    gap: 0.35rem;
    padding: 1.1rem;
    font-size: 0.8125rem;
    text-align: center;
  }
  .popup b {
    font-size: 1.05rem;
  }
  .popup .pill {
    margin-top: 0.4rem;
    padding: 0.5rem 1rem;
    background: #e11d48;
    color: #fff;
  }
  .popup small {
    color: #999;
    text-decoration: underline;
  }
</style>
