// The Share menu's "Ask an agent" entries, for any reader host: the favorite
// agent one tap away, the rest (and Copy the prompt) behind Ask another agent.
import type { ShareMenuItem } from '$lib/components/feed/ShareMenu.svelte';
import { preferences } from '$lib/stores/preferences.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import {
  ASK_AGENTS,
  DEFAULT_ASK_AGENT,
  askPrompt,
  askUrl,
  openAskUrl,
  resolveAskAgent,
  type AskAgent,
  type AskSubject,
} from '$lib/utils/askAgent';

async function copyPrompt(prompt: string) {
  const toastId = toastStore.add('Copying prompt…');
  try {
    await navigator.clipboard.writeText(prompt);
    toastStore.update(toastId, 'success', 'Prompt copied');
  } catch {
    toastStore.update(toastId, 'error', 'Could not copy the prompt');
  }
}

export function askAgentMenuItems(subject: AskSubject): ShareMenuItem[] {
  const choice = preferences.askAgent;
  if (choice === 'off') return [];
  const customUrl = preferences.askAgentCustomUrl;
  // A custom favorite with no usable link falls back to the default.
  const favorite = resolveAskAgent(choice, customUrl) ?? resolveAskAgent(DEFAULT_ASK_AGENT, '')!;
  const custom = resolveAskAgent('custom', customUrl);
  const open = (agent: AskAgent) => () => openAskUrl(askUrl(agent, askPrompt(subject)));
  // A phone has no desktop app to hand the chat to (and claude.ai opens the app there).
  const touch =
    typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;
  const others = [...ASK_AGENTS, ...(custom ? [custom] : [])].filter(
    (a) => a.id !== favorite.id && !(touch && a.id === 'claude-desktop')
  );

  return [
    {
      label: `Ask ${favorite.name}`,
      hint: 'A new chat about this article',
      icon: 'message-square-text',
      onclick: open(favorite),
    },
    {
      label: 'Ask another agent',
      icon: 'more-horizontal',
      submenu: [
        ...others.map((agent): ShareMenuItem => ({
          label: agent.name,
          icon: 'message-square-text',
          onclick: open(agent),
        })),
        {
          label: 'Copy the prompt',
          hint: 'For an agent with no link, like Gemini',
          icon: 'copy',
          onclick: () => void copyPrompt(askPrompt(subject)),
        },
      ],
    },
  ];
}
