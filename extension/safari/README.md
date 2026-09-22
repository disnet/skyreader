# Skyreader for Safari

This macOS container app packages the Safari Web Extension. Run `npm install`
in `extension/`, open `Skyreader.xcodeproj`, and build the shared `Skyreader`
scheme. Both targets sign with the Skyreader team; change it on both targets
if you're building under a different Apple account.

The extension target's `Package Safari Web Extension` build phase runs the
repository's `npm run package:safari`, checks that Xcode's Marketing Version
matches `manifest.json`, and copies `dist/safari/` into the extension bundle.

See the Safari sections of `../CLAUDE.md` for the dev loop and distribution.
