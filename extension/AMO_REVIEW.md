# Building Skyreader for Firefox from source

This is the build documentation required by
[AMO's source code submission policy](https://extensionworkshop.com/documentation/publish/source-code-submission/).
It is copied into the source package as `README.md` by
`scripts/source-package.mjs`.

Every file in the add-on ships exactly as written here except one: the content
script `content/extract.js`, which bundles the [Defuddle](https://github.com/kepano/defuddle)
article extractor with esbuild.

## Environment

- Ubuntu 24.04 (the standard reviewer image) or any OS with a current Node.
- Node 24.x or later, npm 11.x or later. Verified on Node 26.7.0 / npm 11.19.0.
- Network access for `npm ci`.

No global tools are needed. Both build tools are open source and run locally:
esbuild 0.28.2 and Node's own standard library.

## Build

```bash
npm ci
node scripts/package.mjs firefox
```

This produces:

- `dist/firefox/` — the unpacked add-on, byte-identical to the uploaded package.
  `diff -r` it against the unpacked upload; every file matches.
- `skyreader-extension-firefox.zip` — a ZIP of that directory. Its checksum will
  **not** match the uploaded ZIP, because ZIP archives record file timestamps.
  Compare the unpacked contents instead.

## What the build does

`scripts/package.mjs` performs exactly three steps, all readable in that file:

1. Copies the runtime files (`background.js`, `popup.html`, `popup.js`,
   `icons/`, `LICENSE`) into `dist/firefox/` unchanged.
2. Bundles `src/extract-entry.js` into `dist/firefox/content/extract.js` with
   `esbuild --bundle --format=iife --tsconfig-raw={}`. **Not minified**,
   deliberately, so the shipped file stays readable. `src/extract-entry.js` is
   39 lines; everything else in the bundle is Defuddle and its dependencies from
   `node_modules`. (`--tsconfig-raw={}` is there for reproducibility: this
   add-on is developed inside a monorepo, and without it esbuild would walk up
   and apply the repository root's `tsconfig.json`, which is not part of this
   package.)
3. Writes `dist/firefox/manifest.json` from the checked-in `manifest.json` via
   `scripts/manifest.mjs`. That transform drops the Chrome-only
   `background.service_worker` key, and drops the development-only options page,
   `storage` permission, and `http://127.0.0.1/*` optional host permission. The
   checked-in manifest keeps them so the repository can be loaded unpacked in
   both browsers during development.

## Third-party code

| Package    | Version | License | Where                             |
| ---------- | ------- | ------- | --------------------------------- |
| `defuddle` | 0.19.3  | MIT     | bundled into `content/extract.js` |
| `esbuild`  | 0.28.2  | MIT     | build-time only, not shipped      |

Exact versions and integrity hashes are pinned in `package-lock.json`; `npm ci`
installs from it and will fail rather than resolve anything newer.

## Tests

```bash
npm test
```

Runs the Node test runner over `test/`: the background script's account and
host-permission handling, and the per-target manifest transforms above.
