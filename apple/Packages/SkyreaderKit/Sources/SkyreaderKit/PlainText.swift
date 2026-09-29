import Foundation

extension TimelineItem {
  /// The best body the item carries, as plain text: full content, else the
  /// stored lead of a truncated body, else the feed summary. The scaffold's
  /// reader shows this until there's a real HTML renderer.
  public var previewText: String? {
    for html in [content, contentLead, summary] {
      if let html, case let text = PlainText.from(html: html), !text.isEmpty { return text }
    }
    return nil
  }
}

public enum PlainText {
  private static let entities: [(String, String)] = [
    ("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"),
    ("&apos;", "'"), ("&amp;", "&"),
  ]

  /// Strips tags and decodes the common entities. Block-level closers become
  /// paragraph breaks so the text keeps its shape.
  public static func from(html: String) -> String {
    var text = html.replacingOccurrences(
      of: "(?i)<br\\s*/?>|</(p|div|li|h[1-6]|blockquote)>", with: "\n\n",
      options: .regularExpression)
    text = text.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
    // &amp; last, so "&amp;lt;" becomes "&lt;" rather than "<".
    for (entity, char) in entities { text = text.replacingOccurrences(of: entity, with: char) }
    text = text.replacingOccurrences(of: "[ \\t]+", with: " ", options: .regularExpression)
    text = text.replacingOccurrences(of: "\\s*\\n\\s*\\n\\s*", with: "\n\n", options: .regularExpression)
    return text.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
