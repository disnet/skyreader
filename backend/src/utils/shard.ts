export const NUM_SHARDS = 4;

export function computeShardId(feedUrl: string): number {
  let hash = 0;
  for (let i = 0; i < feedUrl.length; i++) {
    const char = feedUrl.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash) % NUM_SHARDS;
}
