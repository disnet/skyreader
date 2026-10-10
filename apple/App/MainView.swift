import SkyreaderKit
import SwiftUI

/// What the reader pane shows.
enum ReaderSelection: Hashable {
  case article(String)  // TimelineItem.id
  case saved(String)  // SavedArticle.rkey
}

/// Selection shared with the menu bar commands (focused value).
struct ReaderContext {
  var library: Library
  var item: TimelineItem?
  var save: SavedArticle?
  var refresh: () -> Void
}

struct MainView: View {
  @Environment(Library.self) private var library
  @Environment(\.scenePhase) private var scenePhase
  @State private var scope: LibraryScope? = .all
  @State private var selection: ReaderSelection?
  @State private var unreadOnly = true
  @State private var columnVisibility = NavigationSplitViewVisibility.all

  var body: some View {
    @Bindable var library = library

    NavigationSplitView(columnVisibility: $columnVisibility) {
      SidebarView(scope: $scope)
        #if os(macOS)
          .navigationSplitViewColumnWidth(min: 200, ideal: 240)
        #endif
    } content: {
      ArticleListView(scope: scope ?? .all, unreadOnly: $unreadOnly, selection: $selection)
        #if os(macOS)
          .navigationSplitViewColumnWidth(min: 280, ideal: 360)
        #endif
    } detail: {
      ReaderView(selection: selection)
    }
    .onChange(of: scope) { selection = nil }
    .focusedSceneValue(\.readerContext, context)
    .task {
      // Refresh on launch, then every five minutes while the window is up.
      while !Task.isCancelled {
        await library.refresh()
        try? await Task.sleep(nanoseconds: 5 * 60 * 1_000_000_000)
      }
    }
    .onChange(of: scenePhase) { _, phase in
      guard phase == .active else { return }
      if (library.lastSynced ?? .distantPast) < Date().addingTimeInterval(-60) {
        Task { await library.refresh() }
      }
    }
    .alert("Something went wrong", isPresented: $library.showsError) {
      Button("OK") {}
    } message: {
      Text(library.lastError ?? "")
    }
  }

  private var context: ReaderContext {
    var item: TimelineItem?
    var save: SavedArticle?
    switch selection {
    case .article(let id): item = library.article(id: id)
    case .saved(let rkey): save = library.saved.first { $0.rkey == rkey }
    case nil: break
    }
    return ReaderContext(library: library, item: item, save: save) {
      Task { await library.refresh() }
    }
  }
}

struct ReaderContextKey: FocusedValueKey {
  typealias Value = ReaderContext
}

extension FocusedValues {
  var readerContext: ReaderContext? {
    get { self[ReaderContextKey.self] }
    set { self[ReaderContextKey.self] = newValue }
  }
}

/// Menu bar commands (macOS) and hardware-keyboard shortcuts (iPad).
struct ReaderCommands: Commands {
  @FocusedValue(\.readerContext) private var context

  var body: some Commands {
    CommandMenu("Article") {
      Button(isRead ? "Mark as Unread" : "Mark as Read") {
        if let context, let item = context.item { context.library.toggleRead(item) }
      }
      .keyboardShortcut("u", modifiers: [.command, .shift])
      .disabled(context?.item == nil)

      Button(isSaved ? "Remove from Saved" : "Save") {
        guard let context else { return }
        if let item = context.item {
          Task { await context.library.toggleSaved(item) }
        } else if let save = context.save {
          Task { await context.library.unsave(save) }
        }
      }
      .keyboardShortcut("d", modifiers: .command)
      .disabled(context?.item == nil && context?.save == nil)

      Button("Open in Browser") {
        if let url = articleURL { openExternally(url) }
      }
      .keyboardShortcut(.return, modifiers: .command)
      .disabled(articleURL == nil)

      Divider()

      Button("Refresh") { context?.refresh() }
        .keyboardShortcut("r", modifiers: .command)
        .disabled(context == nil)
    }
  }

  private var isRead: Bool {
    guard let context, let item = context.item else { return false }
    return context.library.isRead(item)
  }

  private var isSaved: Bool {
    guard let context else { return false }
    if context.save != nil { return true }
    guard let item = context.item else { return false }
    return context.library.savedArticle(for: item) != nil
  }

  private var articleURL: URL? {
    (context?.item?.url ?? context?.save?.url).flatMap { URL(string: $0) }
  }
}
