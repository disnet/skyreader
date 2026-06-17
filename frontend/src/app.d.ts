/// <reference types="vite-plugin-pwa/svelte" />

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    interface PageState {
      readerOpen?: boolean;
      // Reader-stack depth for the main feed (FeedListView): each open pushes a
      // history entry; Back regresses the depth, popping the stack to match.
      readerDepth?: number;
    }
    // interface Platform {}
  }
}

export {};
