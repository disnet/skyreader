// swift-tools-version:6.0
import PackageDescription

// Platform-neutral core for the macOS/iOS app: API client and wire models.
// Foundation only — no SwiftUI, Security or other Apple-only frameworks — so
// `swift test` runs on Linux too (CI runs it there; see apple/CLAUDE.md).
let package = Package(
  name: "SkyreaderKit",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [
    .library(name: "SkyreaderKit", targets: ["SkyreaderKit"])
  ],
  targets: [
    .target(name: "SkyreaderKit"),
    .testTarget(name: "SkyreaderKitTests", dependencies: ["SkyreaderKit"]),
  ]
)
