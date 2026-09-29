import SkyreaderKit
import SwiftUI

struct TimelineView: View {
  @Environment(AppModel.self) private var model
  @State private var selection: TimelineItem.ID?

  var body: some View {
    @Bindable var model = model

    NavigationSplitView {
      List(model.items, selection: $selection) { item in
        ArticleRow(item: item, feedTitle: model.feeds[item.feedUrl]?.title)
      }
      .navigationTitle("Skyreader")
      .overlay {
        if model.items.isEmpty {
          if model.isLoading {
            ProgressView()
          } else {
            ContentUnavailableView("Nothing to read yet", systemImage: "tray")
          }
        }
      }
      .refreshable { await model.refresh() }
      .toolbar {
        ToolbarItem {
          Button("Refresh", systemImage: "arrow.clockwise") {
            Task { await model.refresh() }
          }
          .disabled(model.isLoading)
        }
        ToolbarItem {
          Button("Sign Out", systemImage: "rectangle.portrait.and.arrow.right") {
            model.signOut()
          }
        }
      }
    } detail: {
      if let item = model.items.first(where: { $0.id == selection }) {
        ArticleView(item: item, feedTitle: model.feeds[item.feedUrl]?.title)
      } else {
        ContentUnavailableView("Select an article", systemImage: "doc.text")
      }
    }
    .task {
      if model.items.isEmpty { await model.refresh() }
    }
    .alert("Couldn't refresh", isPresented: $model.showsError) {
      Button("OK") {}
    } message: {
      Text(model.errorMessage ?? "")
    }
  }
}

struct ArticleRow: View {
  let item: TimelineItem
  let feedTitle: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(item.title)
        .font(.headline)
        .fontWeight(item.read ? .regular : .semibold)
        .foregroundStyle(item.read ? HierarchicalShapeStyle.secondary : .primary)
        .lineLimit(3)
      Text(byline(feedTitle: feedTitle, date: item.publishedDate))
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    .padding(.vertical, 4)
  }
}

private func byline(feedTitle: String?, date: Date?) -> String {
  [feedTitle, date?.formatted(date: .abbreviated, time: .omitted)]
    .compactMap { $0 }
    .joined(separator: " · ")
}
