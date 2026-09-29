import SkyreaderKit
import SwiftUI

/// The reading surface. The text is the product (PRODUCT.md): one column, a
/// readable measure, a serif body, nothing competing with it.
struct ReaderView: View {
  @Environment(Library.self) private var library
  let selection: ReaderSelection?

  var body: some View {
    switch selection {
    case .article(let id):
      if let item = library.article(id: id) {
        ArticleReader(item: item).id(id)
      } else {
        placeholder
      }
    case .saved(let rkey):
      if let save = library.saved.first(where: { $0.rkey == rkey }) {
        SavedReader(save: save).id(rkey)
      } else {
        placeholder
      }
    case nil:
      placeholder
    }
  }

  private var placeholder: some View {
    ContentUnavailableView("Pick something to read", systemImage: "text.book.closed")
  }
}

struct ArticleReader: View {
  @Environment(Library.self) private var library
  let item: TimelineItem
  @State private var body_: String?
  @State private var isLoading = true

  var body: some View {
    ArticleWebView(
      html: ReaderHTML.page(
        title: item.title,
        byline: [library.feedTitle(item.feedUrl), item.author].compactMap { $0 }.joined(separator: " · "),
        date: item.publishedDate, url: item.url, body: body_, isLoading: isLoading),
      baseURL: URL(string: item.url))
      .ignoresSafeArea(edges: .bottom)
      .task {
        library.setRead(item, true)
        body_ = await library.body(for: item)
        isLoading = false
      }
      .toolbar {
        ToolbarItemGroup(placement: .primaryAction) {
          Button {
            library.toggleRead(item)
          } label: {
            library.isRead(item)
              ? Label("Mark as Unread", systemImage: "circle")
              : Label("Mark as Read", systemImage: "checkmark.circle")
          }
          .help(library.isRead(item) ? "Mark as unread" : "Mark as read")

          Button {
            Task { await library.toggleSaved(item) }
          } label: {
            library.savedArticle(for: item) == nil
              ? Label("Save", systemImage: "bookmark")
              : Label("Remove from Saved", systemImage: "bookmark.fill")
          }
          .help(library.savedArticle(for: item) == nil ? "Save for later" : "Remove from saved")

          if let url = URL(string: item.url) {
            ShareLink(item: url)
            Button("Open in Browser", systemImage: "safari") { openExternally(url) }
          }
        }
      }
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
  }
}

struct SavedReader: View {
  @Environment(Library.self) private var library
  let save: SavedArticle
  @State private var body_: String?
  @State private var isLoading = true

  var body: some View {
    ArticleWebView(
      html: ReaderHTML.page(
        title: save.displayTitle,
        byline: [save.domain, save.author].compactMap { $0 }.joined(separator: " · "),
        date: save.publishedDate, url: save.url,
        body: body_, isLoading: isLoading),
      baseURL: URL(string: save.url))
      .ignoresSafeArea(edges: .bottom)
      .task {
        body_ = await library.body(for: save)
        isLoading = false
      }
      .toolbar {
        ToolbarItemGroup(placement: .primaryAction) {
          Button("Remove from Saved", systemImage: "bookmark.fill") {
            Task { await library.unsave(save) }
          }
          .help("Remove from saved")
          if let url = URL(string: save.url) {
            ShareLink(item: url)
            Button("Open in Browser", systemImage: "safari") { openExternally(url) }
          }
        }
      }
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
  }
}

/// Builds the reader page. Feed HTML is untrusted: the web view runs with
/// JavaScript off, so the page can style itself but never execute anything.
enum ReaderHTML {
  static func page(
    title: String, byline: String, date: Date?, url: String, body: String?, isLoading: Bool
  ) -> String {
    let dateText = date.map { $0.formatted(date: .long, time: .omitted) } ?? ""
    let meta = [byline, dateText].filter { !$0.isEmpty }.joined(separator: " · ")
    let content: String
    if let body {
      content = body
    } else if isLoading {
      content = "<p class=\"quiet\">Loading…</p>"
    } else {
      content =
        "<p class=\"quiet\">This article has no text here. <a href=\"\(escape(url))\">Read it on the web</a>.</p>"
    }
    return """
      <!doctype html>
      <html>
      <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta name="color-scheme" content="light dark">
      <style>\(css)</style>
      </head>
      <body>
      <article>
      <header>
      <h1><a href="\(escape(url))">\(escape(title))</a></h1>
      <p class="meta">\(escape(meta))</p>
      </header>
      \(content)
      </article>
      </body>
      </html>
      """
  }

  static func escape(_ text: String) -> String {
    text.replacingOccurrences(of: "&", with: "&amp;")
      .replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;")
      .replacingOccurrences(of: "\"", with: "&quot;")
  }

  // Tokens from DESIGN.md: article serif at 1.125rem / 1.8, true-white body,
  // One Blue links (#0066cc; #4da6ff at night).
  static let css = """
    :root { color-scheme: light dark; --text: #333333; --secondary: #666666; --bg: #ffffff;
      --link: #0066cc; --rule: #e0e0e0; }
    @media (prefers-color-scheme: dark) {
      :root { --text: #e0e0e0; --secondary: #999999; --bg: #1a1a1a; --link: #4da6ff; --rule: #404040; }
    }
    html { -webkit-text-size-adjust: 100%; }
    body { margin: 0; background: var(--bg); color: var(--text);
      font: 1.125rem/1.8 Charter, 'Iowan Old Style', Georgia, serif; }
    article { max-width: 42rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; overflow-wrap: break-word; }
    header { margin-bottom: 2rem; }
    h1 { font: 600 1.75rem/1.25 -apple-system, system-ui, sans-serif; margin: 0 0 0.5rem; }
    h1 a { color: inherit; text-decoration: none; }
    h2, h3, h4 { font-family: -apple-system, system-ui, sans-serif; line-height: 1.3; }
    .meta, .quiet { font: 0.875rem/1.5 -apple-system, system-ui, sans-serif; color: var(--secondary); margin: 0; }
    a { color: var(--link); }
    img, video, iframe, figure { max-width: 100%; height: auto; }
    figure { margin: 1.5rem 0; }
    figcaption { font: 0.8125rem/1.5 -apple-system, system-ui, sans-serif; color: var(--secondary); }
    blockquote { margin: 1.5rem 0; padding-left: 1rem; border-left: 3px solid var(--rule); color: var(--secondary); }
    pre, code { font: 0.875rem/1.5 ui-monospace, Menlo, monospace; }
    pre { overflow-x: auto; padding: 1rem; border: 1px solid var(--rule); border-radius: 6px; }
    hr { border: 0; border-top: 1px solid var(--rule); }
    table { border-collapse: collapse; display: block; overflow-x: auto; }
    td, th { border: 1px solid var(--rule); padding: 0.25rem 0.5rem; }
    """
}
