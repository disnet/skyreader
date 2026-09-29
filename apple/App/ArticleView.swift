import SkyreaderKit
import SwiftUI

/// Plain-text reader. The text is the product (PRODUCT.md): one column, a
/// readable measure, nothing else competing with it.
struct ArticleView: View {
  let item: TimelineItem
  let feedTitle: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        if let feedTitle {
          Text(feedTitle)
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        Text(item.title)
          .font(.title.bold())
        if let author = item.author {
          Text(author)
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        if let text = item.previewText {
          Text(text)
            .font(.body)
            .lineSpacing(4)
            .textSelection(.enabled)
        }
        if let url = URL(string: item.url) {
          Link("Open original", destination: url)
        }
      }
      .frame(maxWidth: 680, alignment: .leading)
      .padding()
      .frame(maxWidth: .infinity)
    }
  }
}
