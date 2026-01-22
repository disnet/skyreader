/**
 * Format a date string as a relative time (e.g., "5m ago", "2h ago", "3d ago")
 * Falls back to locale date string for dates older than 7 days
 */
export function formatRelativeDate(dateString: string): string {
	const date = new Date(dateString);
	if (isNaN(date.getTime())) {
		return dateString;
	}

	const now = new Date();
	const diffMs = now.getTime() - date.getTime();

	// Handle future dates or just now
	if (diffMs < 60000) {
		return 'just now';
	}

	const diffMinutes = Math.floor(diffMs / (1000 * 60));
	if (diffMinutes < 60) {
		return `${diffMinutes}m ago`;
	}

	const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
	if (diffHours < 24) {
		return `${diffHours}h ago`;
	}

	const diffDays = Math.floor(diffHours / 24);
	if (diffDays < 7) {
		return `${diffDays}d ago`;
	}

	if (diffDays < 30) {
		const weeks = Math.floor(diffDays / 7);
		return `${weeks}w ago`;
	}

	if (diffDays < 365) {
		const months = Math.floor(diffDays / 30);
		return `${months}mo ago`;
	}

	const years = Math.floor(diffDays / 365);
	return `${years}y ago`;
}
