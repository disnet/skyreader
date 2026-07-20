<script lang="ts">
  // No auth required - this is a public page
</script>

<svelte:head>
  <title>Privacy Policy - Skyreader</title>
</svelte:head>

<div class="privacy-page">
  <h1>Privacy Policy</h1>
  <p class="last-updated">Last updated: July 2026</p>

  <section>
    <p class="lede">
      Skyreader is a reading app. We collect the least we can to run it, we do not track you, and we
      do not sell your data. This page explains what we store, why, and how to get it back or delete
      it.
    </p>
  </section>

  <section>
    <h2>1. Who We Are</h2>
    <p>
      Skyreader is a reading app built on the AT Protocol (the network behind Bluesky, which we call
      the Atmosphere). It brings the feeds, newsletters, and posts you follow into one place to
      read, highlight, and make sense of. This policy covers the Skyreader web app, the public
      linkblog site, and the Chrome extension.
    </p>
  </section>

  <section>
    <h2>2. What We Collect</h2>
    <p>We store the following to make the app work:</p>
    <ul>
      <li>
        <strong>Your account identity.</strong> When you sign in with your AT Protocol account, we store
        your DID (your account identifier), handle, display name, avatar URL, and the address of your
        Personal Data Server (PDS). This comes from your existing account; we never see or store your
        password.
      </li>
      <li>
        <strong>Sign-in sessions.</strong> We keep the OAuth tokens and a session cookie needed to keep
        you logged in.
      </li>
      <li>
        <strong>Your reading library.</strong> Your subscriptions, saved articles, read and unread state,
        highlights, notes, channels, and daily magazines. This is stored on our servers so it stays in
        sync across your devices.
      </li>
      <li>
        <strong>A copy of what you follow.</strong> To show shares and follows, we keep a cached copy
        of your public follow graph from Bluesky.
      </li>
      <li>
        <strong>Feed content.</strong> We fetch and cache the feeds and articles you subscribe to so they
        load quickly. This is public content from the sites you follow.
      </li>
    </ul>
    <p>
      We do not use analytics, advertising, tracking pixels, or third-party trackers. We do not
      build a profile of you to sell or share.
    </p>
  </section>

  <section>
    <h2>3. Where Your Data Lives</h2>
    <p>
      Most of your data lives on our servers, stored privately. Some of it can become portable
      across the Atmosphere if you turn that on:
    </p>
    <ul>
      <li>
        <strong>Saved articles are private to Skyreader.</strong> Your Saved list is stored only on our
        servers. It is not written to your PDS and is not public, unless you choose to back it with an
        external collection (see below).
      </li>
      <li>
        <strong>Subscriptions can be made portable.</strong> By default your subscriptions are stored
        privately on our servers. If you turn on Atmospheric sync, we also write them to your PDS. That
        makes them backed up and portable to any Atmospheric app, and it also makes them publicly visible.
        This is off unless you enable it.
      </li>
      <li>
        <strong>External backing is your choice.</strong> If you connect a Semble or Margin backup, your
        Saved list is stored in that external collection, which is public. Connecting one of these is
        entirely up to you.
      </li>
    </ul>
    <p>
      Anything you publish deliberately, such as a public linkblog post, is public by design and
      visible to anyone.
    </p>
  </section>

  <section>
    <h2>4. On Your Device</h2>
    <p>
      For offline reading, Skyreader stores a copy of your library in your browser using IndexedDB
      and local storage. This stays on your device and is cleared when you sign out or clear your
      browser data.
    </p>
  </section>

  <section>
    <h2>5. The Chrome Extension</h2>
    <p>
      The Skyreader extension saves an article when you click its button. To do that, it reads the
      content of the page you are on at that moment so it can extract the article text. It only
      reads a page when you ask it to save, and it sends the result to your Skyreader account. It
      does not run in the background or track your browsing.
    </p>
  </section>

  <section>
    <h2>6. Who We Share Data With</h2>
    <p>
      We do not sell your data. We rely on a small number of service providers to run Skyreader, and
      we share only what each one needs:
    </p>
    <ul>
      <li><strong>Cloudflare</strong> hosts the app, API, and database.</li>
      <li><strong>Fly.io</strong> runs the proxy that fetches and caches feeds.</li>
      <li>
        <strong>Your PDS and Bluesky</strong> handle sign-in and, if you enable it, receive the data you
        choose to sync. Public social data may be read from the Bluesky firehose and related public directories.
      </li>
      <li>
        <strong>Semble, Margin, Leaflet, and Standard.site</strong> receive data only if you connect one
        of those integrations.
      </li>
    </ul>
    <p>
      We may disclose content if required by law, or to remove illegal or abusive material as
      described in our <a href="/terms">Terms of Service</a>.
    </p>
  </section>

  <section>
    <h2>7. Keeping Your Data</h2>
    <p>
      We keep your account data for as long as your account is active. Cached feed content and
      sessions are cleared on a rolling basis. When you delete your account, we remove your data
      from our servers. Data you synced to your own PDS stays there under your control, and anything
      held by an external integration you connected is governed by that service.
    </p>
  </section>

  <section>
    <h2>8. Your Choices</h2>
    <ul>
      <li>You can turn Atmospheric sync and external backing on or off at any time in settings.</li>
      <li>
        You can export your data, since your synced records live in your own PDS and are portable.
      </li>
      <li>You can ask us for a copy of the data we hold about you, or ask us to delete it.</li>
      <li>You can sign out to clear the copy stored in your browser.</li>
    </ul>
    <p>
      To make a request, email
      <a href="mailto:privacy@skyreader.app">privacy@skyreader.app</a>.
    </p>
  </section>

  <section>
    <h2>9. Children</h2>
    <p>
      Skyreader is not directed at children under 13, and we do not knowingly collect their data.
    </p>
  </section>

  <section>
    <h2>10. Changes</h2>
    <p>
      We may update this policy from time to time. If we make a meaningful change, we will update
      the date at the top of this page.
    </p>
  </section>

  <section class="contact">
    <h2>Contact</h2>
    <p>
      Privacy questions and data requests:
      <a href="mailto:privacy@skyreader.app">privacy@skyreader.app</a>
    </p>
    <p>
      Abuse reports: <a href="mailto:abuse@skyreader.app">abuse@skyreader.app</a>
    </p>
  </section>
</div>

<style>
  .privacy-page {
    max-width: 700px;
    margin: 0 auto;
    padding: 2rem 1rem;
  }

  h1 {
    font-size: var(--text-4xl);
    margin-bottom: 0.5rem;
    color: var(--color-text);
  }

  .last-updated {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    margin-bottom: 2rem;
  }

  .lede {
    font-size: var(--text-lg);
    color: var(--color-text-secondary);
    line-height: 1.6;
  }

  section {
    margin-bottom: 2rem;
  }

  h2 {
    font-size: var(--text-xl);
    margin-bottom: 0.75rem;
    color: var(--color-text);
    border-bottom: 1px solid var(--color-border);
    padding-bottom: 0.5rem;
  }

  p {
    margin-bottom: 0.75rem;
    line-height: 1.6;
    color: var(--color-text);
  }

  ul {
    margin: 0.5rem 0 1rem;
    padding-left: 1.5rem;
  }

  li {
    margin-bottom: 0.5rem;
    line-height: var(--leading-normal);
    color: var(--color-text);
  }

  a {
    color: var(--color-primary);
    text-decoration: none;
  }

  a:hover {
    text-decoration: underline;
  }

  .contact {
    background: var(--color-bg-secondary);
    padding: 1rem 1.5rem;
    border-radius: 8px;
  }

  .contact h2 {
    border-bottom: none;
    padding-bottom: 0;
  }

  .contact p {
    margin-bottom: 0.5rem;
  }

  .contact p:last-child {
    margin-bottom: 0;
  }
</style>
