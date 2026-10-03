import SkyreaderKit
import SwiftUI

struct SidebarView: View {
  @Environment(Library.self) private var library
  @Environment(Session.self) private var session
  @Binding var scope: LibraryScope?
  @State private var showsAddFeed = false
  @State private var showsSaveURL = false
  @State private var showsSettings = false
  @State private var renaming: Subscription?
  @State private var moving: Subscription?
  @State private var unsubscribing: Subscription?
  @State private var confirmsUnsubscribe = false

  var body: some View {
    let counts = library.unreadCountsByFeed()

    List(selection: $scope) {
      Section {
        Label("All Articles", systemImage: "tray.full")
          .badge(counts.values.reduce(0, +))
          .tag(LibraryScope.all)
        Label("Saved", systemImage: "bookmark")
          .badge(library.saved.count)
          .tag(LibraryScope.saved)
      }

      ForEach(library.folders, id: \.self) { folder in
        Section(folder) {
          let feeds = library.subscriptions(inFolder: folder)
          Label("All in \(folder)", systemImage: "folder")
            .badge(feeds.reduce(0) { $0 + (counts[$1.feedUrl] ?? 0) })
            .tag(LibraryScope.folder(folder))
          ForEach(feeds) { feedRow($0, unread: counts[$0.feedUrl] ?? 0) }
        }
      }

      let loose = library.subscriptions(inFolder: nil)
      if !loose.isEmpty {
        Section(library.folders.isEmpty ? "Feeds" : "Other Feeds") {
          ForEach(loose) { feedRow($0, unread: counts[$0.feedUrl] ?? 0) }
        }
      }
    }
    .navigationTitle("Skyreader")
    #if os(macOS)
      .listStyle(.sidebar)
    #endif
    #if DEBUG
      // A different server is a different database: say so, or its feeds
      // look like missing data.
      .safeAreaInset(edge: .bottom) {
        if session.server != .production {
          Label("\(session.server.label) server", systemImage: "server.rack")
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
      }
    #endif
    .overlay {
      if library.subscriptions.isEmpty, !library.isSyncing, library.lastSynced != nil {
        ContentUnavailableView {
          Label("No feeds yet", systemImage: "dot.radiowaves.up.forward")
        } description: {
          Text("Add a site or feed to start reading.")
        } actions: {
          Button("Add Feed") { showsAddFeed = true }
        }
      }
    }
    .toolbar {
      ToolbarItem {
        Menu {
          Button("Add Feed…", systemImage: "plus") { showsAddFeed = true }
          Button("Save a Link…", systemImage: "bookmark") { showsSaveURL = true }
        } label: {
          Label("Add", systemImage: "plus")
        }
      }
      #if os(iOS)
        ToolbarItem(placement: .topBarLeading) {
          Button("Settings", systemImage: "gearshape") { showsSettings = true }
        }
      #endif
    }
    .sheet(isPresented: $showsAddFeed) { AddFeedView() }
    .sheet(isPresented: $showsSaveURL) { SaveLinkView() }
    #if os(iOS)
      .sheet(isPresented: $showsSettings) {
        NavigationStack { SettingsView() }
      }
    #endif
    .sheet(item: $renaming) { RenameFeedView(subscription: $0) }
    .sheet(item: $moving) { MoveFeedView(subscription: $0) }
    .confirmationDialog(
      "Unsubscribe from \(unsubscribing?.displayTitle ?? "this feed")?",
      isPresented: $confirmsUnsubscribe,
      titleVisibility: .visible
    ) {
      Button("Unsubscribe", role: .destructive) {
        if let subscription = unsubscribing {
          if scope == .feed(subscription.feedUrl) { scope = .all }
          Task { await library.unsubscribe(subscription) }
        }
      }
    }
  }

  private func feedRow(_ subscription: Subscription, unread: Int) -> some View {
    HStack(spacing: 8) {
      FeedIcon(subscription: subscription)
      Text(subscription.displayTitle)
        .lineLimit(1)
        .foregroundStyle(subscription.isInTimeline ? HierarchicalShapeStyle.primary : .secondary)
      if !subscription.isInTimeline {
        Image(systemName: "globe")
          .foregroundStyle(.secondary)
          .imageScale(.small)
          .help("Posts from Atmosphere publications aren't in the app yet. Read them on the web.")
          .accessibilityLabel("Not in the app yet")
      }
      if library.feedHealth[subscription.feedUrl] != nil {
        Image(systemName: "exclamationmark.triangle")
          .foregroundStyle(.secondary)
          .help(library.feedHealth[subscription.feedUrl]?.error ?? "This feed isn't updating.")
      }
    }
    .badge(unread)
    .tag(LibraryScope.feed(subscription.feedUrl))
    .contextMenu {
      Button("Mark All as Read", systemImage: "checkmark.circle") {
        library.setRead(library.articles(in: .feed(subscription.feedUrl), unreadOnly: true), true)
      }
      Button("Rename…", systemImage: "pencil") { renaming = subscription }
      Button("Move to Folder…", systemImage: "folder") { moving = subscription }
      if let site = (subscription.siteUrl ?? library.feedMeta[subscription.feedUrl]?.siteUrl)
        .flatMap({ URL(string: $0) })
      {
        Button("Open Website", systemImage: "safari") { openExternally(site) }
      }
      Divider()
      Button("Unsubscribe", systemImage: "trash", role: .destructive) {
        unsubscribing = subscription
        confirmsUnsubscribe = true
      }
    }
  }
}

/// The feed's icon, or a quiet placeholder.
struct FeedIcon: View {
  @Environment(Library.self) private var library
  let subscription: Subscription

  var body: some View {
    let icon = subscription.customIconUrl ?? library.feedMeta[subscription.feedUrl]?.imageUrl
    AsyncImage(url: icon.flatMap { URL(string: $0) }) { image in
      image.resizable().scaledToFill()
    } placeholder: {
      Image(systemName: subscription.sourceType == "email.newsletter" ? "envelope" : "dot.radiowaves.up.forward")
        .foregroundStyle(.secondary)
        .imageScale(.small)
    }
    .frame(width: 16, height: 16)
    .clipShape(RoundedRectangle(cornerRadius: 3))
  }
}
