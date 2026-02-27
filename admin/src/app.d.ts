declare global {
	namespace App {
		interface Platform {
			env: {
				DB: D1Database;
			};
		}
	}
}

export {};
