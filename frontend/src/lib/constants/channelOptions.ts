import type {
  SubscriptionSourceType,
  SavedSourceType,
  DateAddedPreset,
  ReadingLengthFilter,
  SortOrder,
  ChannelAutoRule,
} from '$lib/types';

// --- Content type options ---

export const TYPE_OPTIONS: { value: SubscriptionSourceType; label: string }[] = [
  { value: 'rss', label: 'RSS Feeds' },
  { value: 'atproto.shares', label: 'Skyreader Shares' },
  { value: 'atproto.documents', label: 'Standard.site Documents' },
];

export const SAVED_SOURCE_OPTIONS: { value: SavedSourceType; label: string }[] = [
  { value: 'url', label: 'URL Saves' },
  { value: 'feed', label: 'Feed Articles' },
  { value: 'share', label: 'Shared Articles' },
  { value: 'document', label: 'Documents' },
];

// --- Smart rule options ---

export type AutoRuleOption =
  | 'frequency:high'
  | 'frequency:low'
  | 'longReads'
  | 'recent'
  | 'category'
  | 'subscriptionTag'
  | 'domain'
  | 'people';

export const AUTO_RULE_OPTIONS: { value: AutoRuleOption; label: string; description: string }[] = [
  {
    value: 'frequency:high',
    label: 'Daily Digest',
    description: 'High-volume feeds that publish 2+ times per day',
  },
  {
    value: 'frequency:low',
    label: "Don't Miss",
    description: 'Infrequent feeds where every post counts',
  },
  {
    value: 'longReads',
    label: 'Long Reads',
    description: 'Feeds with in-depth, long-form articles',
  },
  {
    value: 'recent',
    label: 'Recently Added',
    description: 'Sources you added recently',
  },
  {
    value: 'category',
    label: 'Category',
    description: 'All sources in a specific folder',
  },
  {
    value: 'subscriptionTag',
    label: 'Tag',
    description: 'All sources with a specific tag',
  },
  {
    value: 'domain',
    label: 'Domain',
    description: 'Sources matching URL patterns',
  },
  {
    value: 'people',
    label: 'People',
    description: 'Everyone you follow on AT Protocol',
  },
];

export const AUTO_RULE_DEFAULT_NAMES: Record<AutoRuleOption, string> = {
  'frequency:high': 'Daily Digest',
  'frequency:low': "Don't Miss",
  longReads: 'Long Reads',
  recent: 'New Sources',
  category: '',
  subscriptionTag: '',
  domain: '',
  people: 'People I Follow',
};

/** Map a stored ChannelAutoRule back to an AutoRuleOption string. */
export function autoRuleToOption(rule: ChannelAutoRule): AutoRuleOption {
  switch (rule.type) {
    case 'frequency':
      return rule.threshold === 'high' ? 'frequency:high' : 'frequency:low';
    case 'longReads':
      return 'longReads';
    case 'recent':
      return 'recent';
    case 'category':
      return 'category';
    case 'subscriptionTag':
      return 'subscriptionTag';
    case 'domain':
      return 'domain';
    case 'people':
      return 'people';
  }
}

// --- Date & reading length options ---
// Desktop and mobile use different labels for space reasons.

export const DATE_PRESET_OPTIONS: { value: DateAddedPreset | ''; label: string }[] = [
  { value: '', label: 'Any time' },
  { value: 'last-week', label: 'Last week' },
  { value: 'last-month', label: 'Last month' },
  { value: 'last-3-months', label: 'Last 3 months' },
  { value: 'last-year', label: 'Last year' },
];

export const DATE_PRESET_OPTIONS_SHORT: { value: DateAddedPreset | ''; label: string }[] = [
  { value: '', label: 'Any time' },
  { value: 'last-week', label: 'Week' },
  { value: 'last-month', label: 'Month' },
  { value: 'last-3-months', label: '3 months' },
  { value: 'last-year', label: 'Year' },
];

export const READING_LENGTH_OPTIONS: { value: ReadingLengthFilter; label: string }[] = [
  { value: 'quick', label: 'Quick (< 5 min)' },
  { value: 'medium', label: 'Medium (5–15 min)' },
  { value: 'long', label: 'Long (15+ min)' },
];

export const READING_LENGTH_OPTIONS_SHORT: { value: ReadingLengthFilter; label: string }[] = [
  { value: 'quick', label: 'Quick' },
  { value: 'medium', label: 'Medium' },
  { value: 'long', label: 'Long' },
];

// --- Sort options ---

export const SAVED_SORT_OPTIONS: { value: SortOrder; label: string }[] = [
  { value: 'newest', label: 'Saved (newest)' },
  { value: 'oldest', label: 'Saved (oldest)' },
  { value: 'published-newest', label: 'Published (newest)' },
  { value: 'published-oldest', label: 'Published (oldest)' },
  { value: 'shortest', label: 'Reading time (short)' },
  { value: 'longest', label: 'Reading time (long)' },
  { value: 'domain-asc', label: 'Domain (A–Z)' },
  { value: 'domain-desc', label: 'Domain (Z–A)' },
];

export const SAVED_SORT_OPTIONS_SHORT: { value: SortOrder; label: string }[] = [
  { value: 'newest', label: 'Saved ↓' },
  { value: 'oldest', label: 'Saved ↑' },
  { value: 'published-newest', label: 'Published ↓' },
  { value: 'published-oldest', label: 'Published ↑' },
  { value: 'shortest', label: 'Short' },
  { value: 'longest', label: 'Long' },
  { value: 'domain-asc', label: 'Domain A–Z' },
  { value: 'domain-desc', label: 'Domain Z–A' },
];
