// Generate a TID (Timestamp Identifier) for AT Protocol records
export function generateTid(): string {
	const now = Date.now();
	const random = Math.random().toString(36).substring(2, 8);
	return `${now.toString(36)}${random}`;
}
