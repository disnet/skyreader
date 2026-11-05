/**
 * Content labels: the writer's own self-labels on a standard.site document
 * (`labels` on `site.standard.document`, `com.atproto.label.defs#selfLabels`).
 * pckt writes `ai-generated` for its "Made with AI" mark, and `sexual` for NSFW;
 * the other names are Bluesky's standard self-label values.
 *
 * Values are free strings, so every label is shown, but only the known ones get
 * a reader setting (Show / Warn / Hide). Anything else can still be filtered on
 * per channel (ChannelLabelFilter).
 */

export type ContentLabelPreference = 'show' | 'warn' | 'hide';

export interface KnownContentLabel {
  value: string;
  name: string;
  description: string;
  defaultPreference: ContentLabelPreference;
  /** Shares a setting with another value (a legacy alias), so it gets no row of its own. */
  aliasOf?: string;
}

export const KNOWN_CONTENT_LABELS: KnownContentLabel[] = [
  {
    value: 'ai-generated',
    name: 'Made with AI',
    description: 'Mostly written by AI, or with AI-generated images',
    defaultPreference: 'show',
  },
  {
    value: 'porn',
    name: 'Adult content',
    description: 'Explicit sexual content',
    defaultPreference: 'warn',
  },
  {
    value: 'sexual',
    name: 'Sexually suggestive',
    description: 'Sexual content that isn’t explicit',
    defaultPreference: 'warn',
  },
  {
    value: 'nudity',
    name: 'Nudity',
    description: 'Non-sexual nudity, such as art',
    defaultPreference: 'warn',
  },
  {
    value: 'graphic-media',
    name: 'Graphic media',
    description: 'Violence, gore or injury',
    defaultPreference: 'warn',
  },
  {
    value: 'gore',
    name: 'Graphic media',
    description: 'Violence, gore or injury',
    defaultPreference: 'warn',
    aliasOf: 'graphic-media',
  },
];

/** The labels that get a row in Settings. */
export const CONFIGURABLE_CONTENT_LABELS = KNOWN_CONTENT_LABELS.filter((l) => !l.aliasOf);

const BY_VALUE = new Map(KNOWN_CONTENT_LABELS.map((l) => [l.value, l]));

export type ContentLabelPreferences = Record<string, ContentLabelPreference>;

const PREFERENCES: ContentLabelPreference[] = ['show', 'warn', 'hide'];

/** The setting a label falls under (an alias reads its parent's). */
function settingKey(value: string): string {
  return BY_VALUE.get(value)?.aliasOf ?? value;
}

/** A label's display name: its known name, else the raw value. */
export function contentLabelName(value: string): string {
  return BY_VALUE.get(value)?.name ?? value;
}

export function isKnownContentLabel(value: string): boolean {
  return BY_VALUE.has(value);
}

/** The reader's setting for a known label; unknown labels are always shown. */
export function contentLabelPreference(
  value: string,
  prefs: ContentLabelPreferences
): ContentLabelPreference {
  const known = BY_VALUE.get(value);
  if (!known) return 'show';
  return prefs[settingKey(value)] ?? BY_VALUE.get(settingKey(value))?.defaultPreference ?? 'show';
}

/** Keep only well-formed entries for configurable labels (localStorage is user-editable). */
export function coerceContentLabelPreferences(raw: unknown): ContentLabelPreferences {
  const out: ContentLabelPreferences = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const { value } of CONFIGURABLE_CONTENT_LABELS) {
    const pref = (raw as Record<string, unknown>)[value];
    if (typeof pref === 'string' && (PREFERENCES as string[]).includes(pref)) {
      out[value] = pref as ContentLabelPreference;
    }
  }
  return out;
}

export interface ContentLabelVerdict {
  /** A label the reader hides: leave the item out of lists. */
  hidden: boolean;
  /** The first label the reader wants a warning for, or null. */
  warn: string | null;
}

const NONE: ContentLabelVerdict = { hidden: false, warn: null };

export function contentLabelVerdict(
  labels: readonly string[] | undefined,
  prefs: ContentLabelPreferences
): ContentLabelVerdict {
  if (!labels || labels.length === 0) return NONE;
  let warn: string | null = null;
  for (const label of labels) {
    const pref = contentLabelPreference(label, prefs);
    if (pref === 'hide') return { hidden: true, warn: null };
    if (pref === 'warn' && warn === null) warn = label;
  }
  return warn === null ? NONE : { hidden: false, warn };
}

/**
 * A channel's label rule: leave out items carrying any of `labels`, or keep
 * only items carrying at least one. Applies on top of the reader's settings, so
 * a label hidden in Settings stays hidden even in an "only" channel.
 */
export interface ChannelLabelFilter {
  mode: 'exclude' | 'include';
  labels: string[];
}

/** A well-formed filter with at least one label, else undefined. */
export function coerceChannelLabelFilter(raw: unknown): ChannelLabelFilter | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { mode, labels } = raw as { mode?: unknown; labels?: unknown };
  if (mode !== 'exclude' && mode !== 'include') return undefined;
  if (!Array.isArray(labels)) return undefined;
  const clean = [
    ...new Set(
      labels
        .filter((l): l is string => typeof l === 'string' && l.trim() !== '')
        .map((l) => l.trim())
    ),
  ];
  return clean.length > 0 ? { mode, labels: clean } : undefined;
}

/**
 * Whether an item passes a channel's label rule. An item with no labels (every
 * RSS article, most documents) passes an exclude rule and fails an include one.
 */
export function matchesChannelLabelFilter(
  labels: readonly string[] | undefined,
  filter: ChannelLabelFilter | undefined
): boolean {
  if (!filter || filter.labels.length === 0) return true;
  const has = (labels ?? []).some(
    (l) => filter.labels.includes(settingKey(l)) || filter.labels.includes(l)
  );
  return filter.mode === 'include' ? has : !has;
}

/**
 * The labels a channel editor offers: every configurable known label, then any
 * other label seen on the reader's documents, alphabetically.
 */
export function channelLabelOptions(
  seen: Iterable<readonly string[] | undefined>
): { value: string; name: string }[] {
  const options = CONFIGURABLE_CONTENT_LABELS.map((l) => ({ value: l.value, name: l.name }));
  const extra = new Set<string>();
  for (const labels of seen) {
    for (const l of labels ?? []) {
      if (!isKnownContentLabel(l)) extra.add(l);
    }
  }
  for (const value of [...extra].sort()) options.push({ value, name: value });
  return options;
}

/**
 * Whether a labeled item belongs in a list: none of its labels is hidden in the
 * reader's settings, and it passes the channel's rule. A channel that keeps only
 * a label is the reader asking for it by name, so that label shows there even
 * when Settings hides it everywhere else.
 */
export function shownByContentLabels(
  labels: readonly string[] | undefined,
  prefs: ContentLabelPreferences,
  filter?: ChannelLabelFilter
): boolean {
  if (labels && labels.length > 0) {
    const asked = filter?.mode === 'include' ? filter.labels : [];
    for (const label of labels) {
      if (asked.includes(label) || asked.includes(settingKey(label))) continue;
      if (contentLabelPreference(label, prefs) === 'hide') return false;
    }
  }
  return matchesChannelLabelFilter(labels, filter);
}
