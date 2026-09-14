# Skyreader for Safari

This macOS container app packages the Safari Web Extension. Open
`Skyreader.xcodeproj`, assign a signing team to both targets, and build the
shared `Skyreader` scheme.

The extension target's `Package Safari Web Extension` build phase runs the
repository's `npm run package:safari`, checks that Xcode's Marketing Version
matches `manifest.json`, and copies `dist/safari/` into the extension bundle.
Run `npm install` in `extension/` before building.
