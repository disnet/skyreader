import SwiftUI

#if os(macOS)
  import AppKit
#else
  import UIKit
#endif

/// Opens a URL in the reader's default browser.
@MainActor
func openExternally(_ url: URL) {
  guard url.scheme == "https" || url.scheme == "http" || url.scheme == "mailto" else { return }
  #if os(macOS)
    NSWorkspace.shared.open(url)
  #else
    UIApplication.shared.open(url)
  #endif
}
