// A one-field reactive box for component tests that need to change a prop after
// mount. `$state` only exists in `.svelte`/`.svelte.ts` modules, so a plain
// `.component.test.ts` can't declare one — it imports a box from here and passes
// `get value()` through as the prop.
export function reactiveBox<T>(initial: T) {
  const box = $state({ value: initial });
  return box;
}
