import SkyreaderKit
import SwiftUI

struct ArticleListView: View {
  @Environment(Library.self) private var library
  let scope: LibraryScope
  @Binding var unreadOnly: Bool
  @Binding var selection: ReaderSelection?
  /// Items read while this list is up stay visible until the scope or filter
  /// changes — otherwise "unread only" would yank each article out from under
  /// the reader the moment it opens.
  @State private var keepVisible: Set<String> = []

  var body: some View {
    Group {
      if scope == .saved {
        savedList
      } else {
        timelineList
      }
    }
    .navigationTitle(title)
    #if os(macOS)
      .navigationSubtitle(subtitle)
    #endif
    .onChange(of: scope) { keepVisible = [] }
    .onChange(of: unreadOnly) { keepVisible = [] }
    .onChange(of: selection) { _, new in
      if case .article(let id) = new { keepVisible.insert(id) }
    }
  }

  // MARK: Timeline

  private var items: [TimelineItem] {
    let all = library.articles(in: scope)
    guard unreadOnly else { return all }
    return all.filter { !library.isRead($0) || keepVisible.contains($0.id) }
  }

  private var timelineList: some View {
    let items = self.items
    return List(selection: $selection) {
      ForEach(items) { item in
        ArticleRow(item: item, showsFeed: !isSingleFeed)
          .tag(ReaderSelection.article(item.id))
          .swipeActions(edge: .leading) {
            Button {
              library.toggleRead(item)
            } label: {
              library.isRead(item)
                ? Label("Unread", systemImage: "circle.fill") : Label("Read", systemImage: "checkmark.circle")
            }
            .tint(.skyBlue)
          }
          .swipeActions(edge: .trailing) {
            Button {
              Task { await library.toggleSaved(item) }
            } label: {
              library.savedArticle(for: item) == nil
                ? Label("Save", systemImage: "bookmark") : Label("Unsave", systemImage: "bookmark.slash")
            }
            .tint(.orange)
          }
          .contextMenu { articleMenu(item) }
      }
    }
    .overlay {
      if items.isEmpty {
        if library.isSyncing && !library.hasContent {
          ProgressView("Loading your feeds…")
        } else if unreadOnly {
          ContentUnavailableView {
            Label("All caught up", systemImage: "checkmark.circle")
          } actions: {
            Button("Show Read Articles") { unreadOnly = false }
          }
        } else {
          ContentUnavailableView("Nothing here yet", systemImage: "tray")
        }
      }
    }
    .refreshable { await library.refresh() }
    .toolbar {
      ToolbarItemGroup {
        Toggle(isOn: $unreadOnly) {
          Label("Unread Only", systemImage: "line.3.horizontal.decrease.circle")
        }
        .help("Show only unread articles")

        Button("Mark All as Read", systemImage: "checkmark.circle") {
          library.setRead(library.articles(in: scope, unreadOnly: true), true)
        }
        .help("Mark everything in this list as read")
        .disabled(library.unreadCount(in: scope) == 0)

        #if os(macOS)
          Button("Refresh", systemImage: "arrow.clockwise") {
            Task { await library.refresh() }
          }
          .disabled(library.isSyncing)
        #endif
      }
    }
  }

  @ViewBuilder
  private func articleMenu(_ item: TimelineItem) -> some View {
    Button(library.isRead(item) ? "Mark as Unread" : "Mark as Read") { library.toggleRead(item) }
    Button(library.savedArticle(for: item) == nil ? "Save" : "Remove from Saved") {
      Task { await library.toggleSaved(item) }
    }
    if let url = URL(string: item.url) {
      Button("Open in Browser") { openExternally(url) }
      ShareLink(item: url)
    }
    Divider()
    Button("Mark Older as Read") {
      let older = items.drop { $0.id != item.id }.dropFirst()
      library.setRead(Array(older), true)
    }
  }

  // MARK: Saved

  private var savedList: some View {
    List(selection: $selection) {
      ForEach(library.saved) { save in
        SavedRow(save: save)
          .tag(ReaderSelection.saved(save.rkey))
          .swipeActions(edge: .trailing) {
            Button("Remove", systemImage: "bookmark.slash", role: .destructive) {
              Task { await library.unsave(save) }
            }
          }
          .contextMenu {
            if let url = URL(string: save.url) {
              Button("Open in Browser") { openExternally(url) }
              ShareLink(item: url)
            }
            Button("Remove from Saved", role: .destructive) {
              Task { await library.unsave(save) }
            }
          }
      }
    }
    .overlay {
      if library.saved.isEmpty {
        ContentUnavailableView(
          "Nothing saved yet", systemImage: "bookmark",
          description: Text("Save articles to keep them here and read them later."))
      }
    }
    .refreshable { await library.refresh() }
  }

  // MARK: Titles

  private var isSingleFeed: Bool {
    if case .feed = scope { return true }
    return false
  }

  private var title: String {
    switch scope {
    case .all: "All Articles"
    case .saved: "Saved"
    case .folder(let name): name
    case .feed(let url): library.feedTitle(url)
    }
  }

  private var subtitle: String {
    if scope == .saved { return "\(library.saved.count) saved" }
    let unread = library.unreadCount(in: scope)
    return unread == 0 ? "All read" : "\(unread) unread"
  }
}

struct ArticleRow: View {
  @Environment(Library.self) private var library
  let item: TimelineItem
  let showsFeed: Bool

  var body: some View {
    let read = library.isRead(item)
    HStack(alignment: .top, spacing: 10) {
      Circle()
        .fill(read ? Color.clear : Color.skyBlue)
        .frame(width: 8, height: 8)
        .padding(.top, 6)
        .accessibilityHidden(true)

      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 6) {
          if showsFeed {
            Text(library.feedTitle(item.feedUrl))
              .lineLimit(1)
          }
          Spacer(minLength: 4)
          if library.savedArticle(for: item) != nil {
            Image(systemName: "bookmark.fill")
              .imageScale(.small)
              .accessibilityLabel("Saved")
          }
          if let date = item.publishedDate {
            Text(date, format: .relative(presentation: .named, unitsStyle: .abbreviated))
          }
        }
        .font(.caption)
        .foregroundStyle(.secondary)

        Text(item.title)
          .font(.headline)
          .fontWeight(read ? .regular : .semibold)
          .foregroundStyle(read ? HierarchicalShapeStyle.secondary : .primary)
          .lineLimit(3)

        if let snippet {
          Text(snippet)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
      }
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
    .accessibilityValue(read ? "" : "Unread")
  }

  private var snippet: String? {
    guard let html = item.summary ?? item.contentLead ?? item.content else { return nil }
    let text = String(PlainText.from(html: String(html.prefix(2000))).prefix(240))
    return text.isEmpty ? nil : text
  }
}

struct SavedRow: View {
  let save: SavedArticle

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Text(save.domain ?? URL(string: save.url)?.host ?? "")
          .lineLimit(1)
        Spacer()
        if let date = save.savedDate {
          Text(date, format: .relative(presentation: .named, unitsStyle: .abbreviated))
        }
      }
      .font(.caption)
      .foregroundStyle(.secondary)

      Text(save.displayTitle)
        .font(.headline)
        .lineLimit(3)

      if let description = save.description, !description.isEmpty {
        Text(description)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(2)
      }
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
  }
}
