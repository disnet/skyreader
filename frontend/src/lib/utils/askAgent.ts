// "Ask an agent": open an AI chat about the article on screen, with a prompt
// that names it. Each agent here takes the prompt in its new-chat link; one
// with the Skyreader connector can then read the article and the reader's
// highlights itself, by the identifiers the prompt carries. Agents without a
// prompt link (Gemini, at the time of writing) are served by Copy prompt.

export type AskAgentId =
  'claude' | 'claude-desktop' | 'chatgpt' | 'perplexity' | 'grok' | 'le-chat' | 'custom';

export interface AskAgent {
  id: AskAgentId;
  name: string;
  /** The new-chat link, with `{prompt}` where the encoded prompt goes. */
  template: string;
}

export const ASK_AGENTS: AskAgent[] = [
  { id: 'claude', name: 'Claude', template: 'https://claude.ai/new?q={prompt}' },
  // Anthropic's documented deep link into the desktop app.
  {
    id: 'claude-desktop',
    name: 'Claude (desktop app)',
    template: 'claude://claude.ai/new?q={prompt}',
  },
  { id: 'chatgpt', name: 'ChatGPT', template: 'https://chatgpt.com/?q={prompt}' },
  { id: 'perplexity', name: 'Perplexity', template: 'https://www.perplexity.ai/search?q={prompt}' },
  { id: 'grok', name: 'Grok', template: 'https://grok.com/?q={prompt}' },
  { id: 'le-chat', name: 'Le Chat', template: 'https://chat.mistral.ai/chat?q={prompt}' },
];

export const DEFAULT_ASK_AGENT: AskAgentId = 'claude';
export const CUSTOM_AGENT_NAME = 'Your agent';

/** The favorite as stored: an agent, or 'off' to leave Ask out of the menu. */
export type AskAgentChoice = AskAgentId | 'off';

const CHOICES = new Set<string>([...ASK_AGENTS.map((a) => a.id), 'custom', 'off']);

/** A stored choice, or the default for anything an older build (or a hand) wrote. */
export function coerceAskAgentChoice(value: unknown): AskAgentChoice {
  return typeof value === 'string' && CHOICES.has(value)
    ? (value as AskAgentChoice)
    : DEFAULT_ASK_AGENT;
}

/**
 * A reader's own link: https, with `{prompt}` somewhere in it. Anything else
 * (a `javascript:` URL, no placeholder) is refused rather than opened.
 */
export function isValidCustomTemplate(template: string): boolean {
  const t = template.trim();
  if (!t.includes('{prompt}')) return false;
  try {
    return new URL(t.replaceAll('{prompt}', 'x')).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The agent a favorite names, if it can be opened: a custom one needs a valid link. */
export function resolveAskAgent(id: AskAgentId, customTemplate: string): AskAgent | null {
  if (id === 'custom') {
    return isValidCustomTemplate(customTemplate)
      ? { id: 'custom', name: CUSTOM_AGENT_NAME, template: customTemplate.trim() }
      : null;
  }
  return ASK_AGENTS.find((a) => a.id === id) ?? null;
}

/** What the prompt can say about the article. */
export interface AskSubject {
  title?: string;
  /** Its web address; absent for an upload or a newsletter with no web copy. */
  url?: string;
  /** The save's rkey, when it's saved (get_saved_article). */
  rkey?: string;
  /** A feed item's feed and guid, when it came from a feed (get_feed_item). */
  feedUrl?: string;
  guid?: string;
}

const isWebUrl = (url: string | undefined): url is string =>
  Boolean(url && /^https?:\/\//i.test(url));

/**
 * The prompt: the article first, plainly, so any agent can start from the
 * link; then, for one with the Skyreader connector, how to read it there.
 */
export function askPrompt(subject: AskSubject): string {
  const title = subject.title?.trim();
  const url = isWebUrl(subject.url) ? subject.url : undefined;
  const lines = [
    title
      ? `I'm reading “${title}” in Skyreader and want to talk it through with you.`
      : `I'm reading this in Skyreader and want to talk it through with you.`,
  ];
  if (url) lines.push('', url);

  const reads: string[] = [];
  if (subject.rkey) {
    reads.push(`get_saved_article with rkey "${subject.rkey}" reads it`);
  } else if (subject.feedUrl && subject.guid) {
    reads.push(
      `get_feed_item with feedUrl "${subject.feedUrl}" and guid "${subject.guid}" reads it`
    );
  }
  if (subject.rkey) {
    reads.push(`list_highlights with that rkey has my highlights and notes`);
  } else if (url) {
    reads.push(`list_highlights with that url has my highlights and notes`);
  }
  if (reads.length > 0) {
    lines.push('', `If you have the Skyreader connector: ${reads.join(', and ')}.`);
  }
  return lines.join('\n');
}

/** The agent's new-chat link carrying the prompt. */
export function askUrl(agent: AskAgent, prompt: string): string {
  return agent.template.replaceAll('{prompt}', encodeURIComponent(prompt));
}

/**
 * Open the chat. A web link opens in a new tab (where the agent's app may
 * take it over); an app's own scheme is handed to the system in place, since a
 * new tab would stay behind empty.
 */
export function openAskUrl(url: string): void {
  if (/^https:\/\//i.test(url)) window.open(url, '_blank', 'noopener');
  else window.location.href = url;
}
