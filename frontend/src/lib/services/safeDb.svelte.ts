import { type Table, type UpdateSpec } from 'dexie';

/**
 * Safe Dexie write wrappers that automatically call $state.snapshot()
 * before passing values to IndexedDB. This prevents Svelte 5 reactive
 * proxies from being serialized by Dexie, which causes silent data
 * corruption or write failures.
 *
 * Use these instead of direct db.<table>.put/add/bulkPut/bulkAdd/update calls.
 */

export function safePut<T, TKey>(table: Table<T, TKey>, value: T): Promise<TKey> {
  return table.put($state.snapshot(value) as T);
}

export function safeAdd<T, TKey>(table: Table<T, TKey>, value: T): Promise<TKey> {
  return table.add($state.snapshot(value) as T);
}

export function safeBulkPut<T, TKey>(table: Table<T, TKey>, values: T[]): Promise<TKey> {
  return table.bulkPut($state.snapshot(values) as T[]);
}

export function safeBulkAdd<T, TKey>(table: Table<T, TKey>, values: T[]): Promise<TKey> {
  return table.bulkAdd($state.snapshot(values) as T[]);
}

export function safeUpdate<T, TKey>(
  table: Table<T, TKey>,
  key: TKey,
  changes: UpdateSpec<T>
): Promise<number> {
  return table.update(key, $state.snapshot(changes) as UpdateSpec<T>);
}
