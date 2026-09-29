import SwiftUI
import WebKit

/// Renders reader HTML. JavaScript is off and every link opens in the
/// reader's browser, so untrusted feed markup can only style itself.
struct ArticleWebView {
  let html: String
  let baseURL: URL?

  func makeCoordinator() -> Coordinator { Coordinator() }

  private func makeWebView(coordinator: Coordinator) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = false
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = coordinator
    #if os(macOS)
      webView.setValue(false, forKey: "drawsBackground")
    #else
      webView.isOpaque = false
      webView.backgroundColor = .clear
    #endif
    return webView
  }

  private func update(_ webView: WKWebView, coordinator: Coordinator) {
    guard coordinator.loadedHTML != html else { return }
    coordinator.loadedHTML = html
    coordinator.baseURL = baseURL
    webView.loadHTMLString(html, baseURL: baseURL)
  }

  @MainActor
  final class Coordinator: NSObject, WKNavigationDelegate {
    var loadedHTML: String?
    var baseURL: URL?

    func webView(
      _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
      guard let url = navigationAction.request.url else { return .cancel }
      // In-page anchors (footnotes) scroll in place.
      if url.fragment != nil, url.withoutFragment == baseURL?.withoutFragment { return .allow }
      // Clicked links leave for the browser.
      if navigationAction.navigationType == .linkActivated {
        openExternally(url)
        return .cancel
      }
      // Embeds (iframes) load in place, JavaScript still off.
      if navigationAction.targetFrame?.isMainFrame == false { return .allow }
      // The main frame only ever shows our own page: loadHTMLString arrives as
      // the base URL (or about:blank). Anything else — a meta refresh in the
      // feed's markup, say — is refused.
      if url == baseURL || url.absoluteString == "about:blank" { return .allow }
      return .cancel
    }
  }
}

#if os(macOS)
  extension ArticleWebView: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView { makeWebView(coordinator: context.coordinator) }
    func updateNSView(_ webView: WKWebView, context: Context) {
      update(webView, coordinator: context.coordinator)
    }
  }
#else
  extension ArticleWebView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView { makeWebView(coordinator: context.coordinator) }
    func updateUIView(_ webView: WKWebView, context: Context) {
      update(webView, coordinator: context.coordinator)
    }
  }
#endif

extension URL {
  fileprivate var withoutFragment: URL? {
    var components = URLComponents(url: self, resolvingAgainstBaseURL: false)
    components?.fragment = nil
    return components?.url
  }
}
