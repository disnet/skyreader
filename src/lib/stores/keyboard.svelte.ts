import { browser } from '$app/environment';

export interface Shortcut {
	key: string;
	shift?: boolean;
	description: string;
	category: string;
	action: () => void;
	condition?: () => boolean;
}

interface KeyboardState {
	isHelpOpen: boolean;
	shortcuts: Map<string, Shortcut>;
}

function createKeyboardStore() {
	let state = $state<KeyboardState>({
		isHelpOpen: false,
		shortcuts: new Map(),
	});

	function getShortcutKey(key: string, shift?: boolean): string {
		return shift ? `Shift+${key}` : key;
	}

	function register(shortcut: Shortcut) {
		const key = getShortcutKey(shortcut.key, shortcut.shift);
		state.shortcuts.set(key, shortcut);
	}

	function unregister(key: string, shift?: boolean) {
		const shortcutKey = getShortcutKey(key, shift);
		state.shortcuts.delete(shortcutKey);
	}

	function isInputFocused(): boolean {
		if (!browser) return false;
		const activeElement = document.activeElement;
		return (
			activeElement instanceof HTMLInputElement ||
			activeElement instanceof HTMLTextAreaElement ||
			activeElement?.getAttribute('contenteditable') === 'true'
		);
	}

	function handleKeydown(e: KeyboardEvent) {
		// Always allow Escape
		if (e.key === 'Escape') {
			if (state.isHelpOpen) {
				state.isHelpOpen = false;
				e.preventDefault();
				return;
			}
			// Let escape propagate to close other modals
			return;
		}

		// Ignore if typing in an input (except for help toggle)
		if (isInputFocused()) return;

		// Toggle help modal with ?
		if (e.key === '?' || (e.shiftKey && e.key === '/')) {
			state.isHelpOpen = !state.isHelpOpen;
			e.preventDefault();
			return;
		}

		// Don't process shortcuts when help modal is open
		if (state.isHelpOpen) return;

		// Find matching shortcut
		const shortcutKey = getShortcutKey(e.key, e.shiftKey);
		const shortcut = state.shortcuts.get(shortcutKey);

		// Also try without shift if not found (for keys that are naturally shifted like ?)
		const fallbackShortcut = e.shiftKey ? state.shortcuts.get(e.key) : undefined;
		const matchedShortcut = shortcut || fallbackShortcut;

		if (matchedShortcut) {
			// Check condition if present
			if (matchedShortcut.condition && !matchedShortcut.condition()) {
				return;
			}
			e.preventDefault();
			matchedShortcut.action();
		}
	}

	function toggleHelp() {
		state.isHelpOpen = !state.isHelpOpen;
	}

	function closeHelp() {
		state.isHelpOpen = false;
	}

	function getShortcutsByCategory(): Map<string, Shortcut[]> {
		const categories = new Map<string, Shortcut[]>();

		for (const shortcut of state.shortcuts.values()) {
			const list = categories.get(shortcut.category) || [];
			list.push(shortcut);
			categories.set(shortcut.category, list);
		}

		return categories;
	}

	function getAllShortcuts(): Shortcut[] {
		return Array.from(state.shortcuts.values());
	}

	return {
		get isHelpOpen() {
			return state.isHelpOpen;
		},
		register,
		unregister,
		handleKeydown,
		toggleHelp,
		closeHelp,
		getShortcutsByCategory,
		getAllShortcuts,
	};
}

export const keyboardStore = createKeyboardStore();
