/**
 * The Cache API cache holding the pictures Home's lanes paint (covers, or a
 * favicon where there's no cover). The page fills and prunes it
 * (services/cardImages.ts); the service worker answers image requests from it,
 * so a cold start draws them without waiting on the network or revalidating.
 * Shared by both, so it lives in a module with no imports.
 */
export const CARD_IMAGE_CACHE = 'skyreader-card-images-v1';
