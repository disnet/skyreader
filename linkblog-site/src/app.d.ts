// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}

    // Cloudflare Pages runtime bindings/vars (also surfaced via $env/dynamic/private).
    interface Platform {
      env?: {
        API_URL?: string;
        APP_URL?: string;
      };
    }
  }
}

export {};
