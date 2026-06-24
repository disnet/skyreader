<script lang="ts">
  import { getSourceDisplay } from '$lib/utils/sourceDisplay';
  import Icon, { type IconName } from '$lib/components/Icon.svelte';
  import type { CrossTypeDuplicate } from '$lib/services/subscriptionDedup';

  interface Props {
    pair: CrossTypeDuplicate;
    /** Drop the standard.site stream, keep the RSS feed. */
    onKeepRss: () => void;
    /** Drop the RSS feed, keep the standard.site stream. */
    onKeepStandard: () => void;
    /** Keep both; persist a per-host dismissal so the notice stops nagging. */
    onKeepBoth: () => void;
  }

  let { pair, onKeepRss, onKeepStandard, onKeepBoth }: Props = $props();

  let stdDisplay = $derived(getSourceDisplay('atproto.documents', pair.standard.feedUrl));
</script>

<!-- The same publication followed twice: once by RSS, once on standard.site.
     Show both so the user can open each and compare the content, then keep
     one or both. -->
<div class="unify-notice">
  <div class="unify-head">
    <Icon name="layers" size={18} />
    <div class="unify-body">
      <p class="unify-title">You follow {pair.host} twice</p>
      <p class="unify-desc">Open each to compare the content, then keep one or both.</p>
    </div>
  </div>

  <div class="unify-options">
    <a class="unify-option" href="/feeds?feed={pair.rss.id}">
      <Icon name="rss" size={15} />
      <span class="unify-option-label">{pair.rss.customTitle || pair.rss.title}</span>
      <span class="unify-option-kind">RSS</span>
    </a>
    <a class="unify-option" href="/feeds?feed={pair.standard.id}">
      <Icon name={stdDisplay.iconName as IconName} size={15} />
      <span class="unify-option-label">{pair.standard.customTitle || pair.standard.title}</span>
      <span class="unify-option-kind">standard.site</span>
    </a>
  </div>

  <div class="unify-actions">
    <button class="unify-keep" onclick={onKeepRss}>Keep RSS</button>
    <button class="unify-keep" onclick={onKeepStandard}>Keep standard.site</button>
    <button class="unify-dismiss" onclick={onKeepBoth}>Keep both</button>
  </div>
</div>

<style>
  .unify-notice {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding: 0.875rem;
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: 8px;
  }

  .unify-head {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    color: var(--color-primary);
  }

  .unify-body {
    flex: 1;
    min-width: 0;
  }

  .unify-title {
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
    margin: 0 0 0.125rem;
    word-break: break-word;
  }

  .unify-desc {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    line-height: var(--leading-normal);
    margin: 0;
  }

  .unify-options {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .unify-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.625rem;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    color: var(--color-text);
    text-decoration: none;
    transition: border-color 0.15s;
  }

  .unify-option:hover {
    border-color: var(--color-primary);
  }

  .unify-option-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  .unify-option-kind {
    flex-shrink: 0;
    font-size: var(--text-2xs);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .unify-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .unify-keep {
    padding: 0.3rem 0.7rem;
    border: none;
    border-radius: 6px;
    background: var(--color-primary);
    color: white;
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    cursor: pointer;
    white-space: nowrap;
    transition: opacity 0.15s;
  }

  .unify-keep:hover {
    opacity: 0.85;
  }

  .unify-dismiss {
    padding: 0.3rem 0.6rem;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    cursor: pointer;
    white-space: nowrap;
  }

  .unify-dismiss:hover {
    color: var(--color-text);
  }
</style>
