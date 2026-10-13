import Foundation
import Observation

/// What the article list is showing.
public enum LibraryScope: Hashable, Sendable {
  case all
  case folder(String)
  case feed(String)  // feedUrl
  case saved
}

/// The reader's library: timeline, read state, subscriptions and saves, kept in
/// sync with the server and cached on disk so the app opens instantly and
/// reads offline.
///
/// Mirrors the web client's model (`frontend/src/lib/services/feedFetcher.ts`,
/// `stores/itemLabels.svelte.ts`): one global timeline cursor, read state as a
/// set of guids, optimistic writes with a persisted outbox, and a forward
/// read-state delta so reads made on other devices arrive here.
@MainActor
@Observable
public final class Library {
  // MARK: State the UI reads

  public private(set) var subscriptions: [Subscription] = []
  public private(set) var saved: [SavedArticle] = []
  public private(set) var feedMeta: [String: FeedMetadata] = [:]
  public private(set) var feedHealth: [String: FeedHealth] = [:]
  public private(set) var readGuids: Set<String> = []
  public private(set) var account: Account?
  public private(set) var isSyncing = false
  public private(set) var lastSynced: Date?
  /// A sync or action failed; the UI shows it and clears it.
  public var lastError: String?

  /// For an alert's `isPresented`: dismissing clears the error.
  public var showsError: Bool {
    get { lastError != nil }
    set { if !newValue { lastError = nil } }
  }

  /// Called when the server says the session is gone.
  @ObservationIgnored public var onUnauthorized: (@MainActor () -> Void)?

  // MARK: Internal state

  private var articles: [String: TimelineItem] = [:]
  /// Article ids newest first. Rebuilt after merges, not per render.
  private var orderedIDs: [String] = []
  private var timelineCursor: TimelineCursor?
  private var timelineHead: Int?
  private var readSince: String?
  private var outbox: [PendingRead] = []
  /// Feeds already given their one-off backfill (see `backfillEmptyFeeds`).
  private var backfilled: Set<String> = []
  /// Where the next backfill round starts, so a failing feed can't hog the budget.
  private var backfillCursor: String?
  @ObservationIgnored private var bodyCache: [String: String] = [:]
  @ObservationIgnored private var flushTask: Task<Void, Never>?
  @ObservationIgnored private var persistTask: Task<Void, Never>?

  @ObservationIgnored public let client: SkyreaderClient
  @ObservationIgnored private let storeURL: URL?

  /// Items kept per feed. Must match the backend's `ARTICLE_WINDOW_PER_FEED`
  /// (and the web client's `MAX_ARTICLES_PER_FEED`).
  public static let articlesPerFeed = 100

  /// Per-sync cap on one-off feed backfills (web: `MAX_BACKFILLS_PER_SYNC`).
  static let backfillsPerSync = 10

  public init(client: SkyreaderClient, storeURL: URL?) {
    self.client = client
    self.storeURL = storeURL
    loadSnapshot()
  }

  // MARK: Queries

  public var hasContent: Bool { !articles.isEmpty || !subscriptions.isEmpty || !saved.isEmpty }

  /// Folder names, sorted. A folder exists only because a subscription names it.
  public var folders: [String] {
    Set(subscriptions.compactMap { $0.category?.nilIfEmpty }).sorted {
      $0.localizedCaseInsensitiveCompare($1) == .orderedAscending
    }
  }

  public func subscriptions(inFolder folder: String?) -> [Subscription] {
    subscriptions
      .filter { ($0.category?.nilIfEmpty) == folder }
      .sorted { $0.displayTitle.localizedCaseInsensitiveCompare($1.displayTitle) == .orderedAscending }
  }

  public func subscription(feedUrl: String) -> Subscription? {
    subscriptions.first { $0.feedUrl == feedUrl }
  }

  public func feedTitle(_ feedUrl: String) -> String {
    subscription(feedUrl: feedUrl)?.displayTitle ?? feedMeta[feedUrl]?.title?.nilIfEmpty
      ?? URL(string: feedUrl)?.host ?? feedUrl
  }

  public func article(id: String) -> TimelineItem? { articles[id] }

  public func articles(in scope: LibraryScope, unreadOnly: Bool = false) -> [TimelineItem] {
    let feeds = feedURLs(in: scope)
    return orderedIDs.compactMap { id -> TimelineItem? in
      guard let item = articles[id] else { return nil }
      if let feeds, !feeds.contains(item.feedUrl) { return nil }
      if unreadOnly, readGuids.contains(item.guid) { return nil }
      return item
    }
  }

  public func unreadCount(in scope: LibraryScope) -> Int {
    guard scope != .saved else { return 0 }
    let feeds = feedURLs(in: scope)
    var count = 0
    for item in articles.values where !readGuids.contains(item.guid) {
      if let feeds, !feeds.contains(item.feedUrl) { continue }
      count += 1
    }
    return count
  }

  public func isRead(_ item: TimelineItem) -> Bool { readGuids.contains(item.guid) }

  /// Unread items per feed URL, in one pass — for the sidebar, which would
  /// otherwise rescan every item once per row.
  public func unreadCountsByFeed() -> [String: Int] {
    var counts: [String: Int] = [:]
    for item in articles.values where !readGuids.contains(item.guid) {
      counts[item.feedUrl, default: 0] += 1
    }
    return counts
  }

  public func savedArticle(for item: TimelineItem) -> SavedArticle? {
    saved.first { $0.itemGuid == item.guid || $0.url == item.url }
  }

  /// nil = no feed filter.
  private func feedURLs(in scope: LibraryScope) -> Set<String>? {
    switch scope {
    case .all, .saved: nil
    case .feed(let url): [url]
    case .folder(let name): Set(subscriptions(inFolder: name).map(\.feedUrl))
    }
  }

  // MARK: Sync

  /// Pulls everything: flushes pending reads, drains the timeline, applies the
  /// read-state delta, and reloads subscriptions and saves.
  public func refresh() async {
    guard !isSyncing else { return }
    isSyncing = true
    defer { isSyncing = false }
    do {
      await flushOutbox()
      if account == nil { account = try? await client.me() }
      try await syncSubscriptions()
      try await syncTimeline()
      try await backfillEmptyFeeds()
      try await syncReadPositions()
      saved = try await client.allSaved()
      trim()
      lastSynced = Date()
      schedulePersist()
    } catch {
      handle(error)
    }
  }

  private func syncSubscriptions() async throws {
    subscriptions = try await client.subscriptions()
  }

  private func syncTimeline() async throws {
    var request = timelineCursor ?? .coldStart()
    // A cold start is paged; its cursor is committed only once the last page is
    // in, so an interrupted cold start restarts cleanly (as the web client does).
    var coldCommit: TimelineCursor?
    for round in 0..<30 {
      let page = try await client.timeline(from: request, limit: 200, includeCounts: round == 0)
      guard page.ingestActive else { return }
      if let head = page.head { timelineHead = head }
      if readSince == nil, let readCursor = page.readCursor { readSince = String(readCursor) }
      merge(page.items)
      if let feeds = page.feeds { feedMeta.merge(feeds) { _, new in new } }
      if let health = page.feedHealth { feedHealth = health }

      if page.coldStart {
        if coldCommit == nil { coldCommit = .incremental(sinceSeq: page.cursor, generation: page.generation) }
        guard page.hasMore, let next = page.nextColdOffset else {
          timelineCursor = coldCommit
          return
        }
        request = .coldStart(offset: next)
      } else {
        request = .incremental(sinceSeq: page.cursor, generation: page.generation)
        timelineCursor = request
        guard page.hasMore, round < 5 else { return }
      }
    }
  }

  /// Fetches recent items for followed feeds that hold none locally.
  ///
  /// The timeline cursor only delivers items ingested after it, so a feed
  /// followed on another device (already below the cursor), or one the server
  /// hadn't crawled yet, would otherwise stay empty forever. `feeds/fetch` also
  /// pulls an uncrawled feed through the crawler. Port of the web client's
  /// `backfillMissingSubscriptions` (frontend/src/lib/services/feedFetcher.ts):
  /// a success — even an empty one — is remembered; failures stay eligible.
  private func backfillEmptyFeeds() async throws {
    let feeds = subscriptions.filter(\.isInTimeline).map(\.feedUrl)
    backfilled.formIntersection(feeds)
    guard !feeds.isEmpty else { return }
    let withArticles = Set(articles.values.map(\.feedUrl))

    let start = backfillCursor.flatMap { feeds.firstIndex(of: $0) }.map { ($0 + 1) % feeds.count } ?? 0
    var targets: [String] = []
    for offset in 0..<feeds.count where targets.count < Self.backfillsPerSync {
      let feed = feeds[(start + offset) % feeds.count]
      if !backfilled.contains(feed), !withArticles.contains(feed) { targets.append(feed) }
    }
    guard let last = targets.last else { return }

    for feed in targets {
      do {
        merge(try await client.fetchFeed(url: feed))
        backfilled.insert(feed)
      } catch SkyreaderError.unauthorized {
        throw SkyreaderError.unauthorized
      } catch {
        // Broken or unreachable feed: try again on a later sync.
      }
    }
    backfillCursor = last
  }

  private func syncReadPositions() async throws {
    for _ in 0..<10 {
      let page = try await client.readPositions(since: readSince)
      let pending = Dictionary(outbox.map { ($0.mark.itemGuid, $0) }, uniquingKeysWith: { $1 })
      for position in page.positions where position.itemType == "article" {
        // A local change still in flight wins over the server's older view.
        if pending[position.itemGuid] != nil { continue }
        if position.deleted {
          readGuids.remove(position.itemGuid)
        } else {
          readGuids.insert(position.itemGuid)
        }
      }
      if let next = page.nextSince { readSince = next }
      if !page.hasMore { return }
    }
  }

  private func merge(_ items: [TimelineItem]) {
    guard !items.isEmpty else { return }
    let pendingUnread = Set(outbox.filter { !$0.read }.map(\.mark.itemGuid))
    for var item in items {
      // Keep a body fetched earlier; incoming rows only carry the lead.
      if let existing = articles[item.id], item.content == nil, existing.content != nil {
        item.content = existing.content
        item.contentTruncated = existing.contentTruncated
      }
      articles[item.id] = item
      if item.read, !pendingUnread.contains(item.guid) { readGuids.insert(item.guid) }
    }
    rebuildOrder()
  }

  /// Keeps each followed feed's newest `articlesPerFeed`, except saved ones.
  /// Items from feeds no longer followed (unsubscribed on another device, say)
  /// go entirely. Runs after the merge, so a page can't bring them back.
  private func trim() {
    let savedGuids = Set(saved.compactMap(\.itemGuid))
    let followed = Set(subscriptions.map(\.feedUrl))
    var perFeed: [String: Int] = [:]
    var removed = false
    for id in orderedIDs {
      guard let item = articles[id] else { continue }
      if !followed.contains(item.feedUrl) {
        articles[id] = nil
        removed = true
        continue
      }
      perFeed[item.feedUrl, default: 0] += 1
      if perFeed[item.feedUrl]! > Self.articlesPerFeed, !savedGuids.contains(item.guid) {
        articles[id] = nil
        removed = true
      }
    }
    if removed { rebuildOrder() }
  }

  private func rebuildOrder() {
    orderedIDs = articles.values
      .sorted { a, b in
        let da = a.publishedDate ?? .distantPast
        let db = b.publishedDate ?? .distantPast
        return da != db ? da > db : a.seq > b.seq
      }
      .map(\.id)
  }

  // MARK: Read state

  public func setRead(_ item: TimelineItem, _ read: Bool) {
    setRead([item], read)
  }

  public func toggleRead(_ item: TimelineItem) {
    setRead(item, !isRead(item))
  }

  /// Marks many items at once (e.g. "mark all as read" on the visible list).
  public func setRead(_ items: [TimelineItem], _ read: Bool) {
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    var changed = false
    for item in items where readGuids.contains(item.guid) != read {
      if read { readGuids.insert(item.guid) } else { readGuids.remove(item.guid) }
      outbox.removeAll { $0.mark.itemGuid == item.guid }
      outbox.append(
        PendingRead(
          mark: ReadMark(itemGuid: item.guid, itemUrl: item.url, itemTitle: item.title, updatedAt: now),
          read: read))
      changed = true
    }
    guard changed else { return }
    schedulePersist()
    scheduleFlush()
  }

  /// Sends queued reads after a short pause so a burst (scrolling, j/k through a
  /// list) goes out as one bulk call — the web client debounces 300ms too.
  private func scheduleFlush() {
    flushTask?.cancel()
    flushTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 300_000_000)
      guard !Task.isCancelled else { return }
      await self?.flushOutbox()
    }
  }

  /// Sends the outbox. Failed entries stay queued (and persisted) for the next
  /// attempt; the server's last-write-wins on `updatedAt` makes replays safe.
  public func flushOutbox() async {
    let batch = outbox
    guard !batch.isEmpty else { return }
    var sent: Set<PendingRead> = []
    do {
      let reads = batch.filter(\.read)
      if !reads.isEmpty {
        try await client.markRead(reads.map(\.mark))
        sent.formUnion(reads)
      }
      for unread in batch where !unread.read {
        try await client.markUnread(unread.mark)
        sent.insert(unread)
      }
    } catch SkyreaderError.unauthorized {
      handle(SkyreaderError.unauthorized)
    } catch {
      // Offline or a server hiccup: keep the rest for later.
    }
    outbox.removeAll { sent.contains($0) }
    schedulePersist()
  }

  public var pendingWrites: Int { outbox.count }

  // MARK: Bodies

  /// The article's full HTML: its own content, else the stored body the server
  /// kept for a truncated item, else a reader extraction of the page.
  public func body(for item: TimelineItem) async -> String? {
    if let cached = bodyCache[item.id] { return cached }
    if let content = item.content?.nilIfBlank, item.contentTruncated != true {
      return content
    }
    var body: String?
    if item.contentTruncated == true || item.bodyStored == true {
      body = try? await client.itemBody(feedUrl: item.feedUrl, guid: item.guid)
    }
    if body == nil {
      body = try? await client.extract(url: item.url).content?.nilIfBlank
    }
    let result = body ?? item.content?.nilIfBlank ?? item.contentLead ?? item.summary
    if let body {
      bodyCache[item.id] = body
      // Keep it with the item so it reads offline next time.
      if var stored = articles[item.id] {
        stored.content = body
        stored.contentTruncated = false
        articles[item.id] = stored
        schedulePersist()
      }
    }
    return result
  }

  public func body(for save: SavedArticle) async -> String? {
    let key = "saved:\(save.rkey)"
    if let cached = bodyCache[key] { return cached }
    var body = try? await client.savedBodies(rkeys: [save.rkey])[save.rkey]?.nilIfBlank
    if body == nil { body = try? await client.extract(url: save.url).content?.nilIfBlank }
    if let body { bodyCache[key] = body }
    return body ?? save.description
  }

  // MARK: Saves

  /// Saves a timeline item, with the fullest body available.
  public func save(_ item: TimelineItem) async {
    guard savedArticle(for: item) == nil else { return }
    let rkey = TID.generate()
    let host = URL(string: item.url)?.host
    // Optimistic: it shows as saved straight away.
    saved.insert(
      SavedArticle(
        rkey: rkey, url: item.url, title: item.title, author: item.author,
        description: item.summary.map(PlainText.from(html:)), domain: host, image: item.imageUrl,
        publishedAt: item.publishedAt, savedAt: ISO8601.format(Date()), source: "feed",
        itemGuid: item.guid),
      at: 0)
    let extracted = try? await client.extract(url: item.url)
    var content = extracted?.content?.nilIfBlank
    if content == nil { content = await body(for: item) }
    do {
      try await client.save(
        NewSave(
          rkey: rkey, url: item.url, fromFeed: true, itemGuid: item.guid, title: item.title,
          author: item.author ?? extracted?.author, description: item.summary, content: content,
          image: item.imageUrl ?? extracted?.image, publishedAt: item.publishedAt, domain: host,
          wordCount: extracted?.wordCount))
      schedulePersist()
    } catch SkyreaderError.http(status: 409, _) {
      // Already saved elsewhere; the next refresh brings the real record.
    } catch {
      saved.removeAll { $0.rkey == rkey }
      handle(error)
    }
  }

  /// Saves any web page by URL (extracted server-side first).
  public func save(url rawURL: String) async -> Bool {
    let url = Self.normalizedURL(rawURL)
    guard URL(string: url)?.host != nil else {
      lastError = "That doesn't look like a web address."
      return false
    }
    let rkey = TID.generate()
    let extracted = try? await client.extract(url: url)
    do {
      try await client.save(
        NewSave(
          rkey: rkey, url: url, title: extracted?.title, author: extracted?.author,
          description: extracted?.description, content: extracted?.content, image: extracted?.image,
          publishedAt: extracted?.published, domain: extracted?.domain ?? URL(string: url)?.host,
          wordCount: extracted?.wordCount))
      saved = (try? await client.allSaved()) ?? saved
      schedulePersist()
      return true
    } catch SkyreaderError.http(status: 409, _) {
      lastError = "You've already saved that."
      return false
    } catch {
      handle(error)
      return false
    }
  }

  public func unsave(_ save: SavedArticle) async {
    let index = saved.firstIndex(of: save)
    saved.removeAll { $0.rkey == save.rkey }
    do {
      try await client.deleteSaved(rkey: save.rkey)
      schedulePersist()
    } catch SkyreaderError.notFound {
      schedulePersist()
    } catch {
      if let index { saved.insert(save, at: min(index, saved.count)) }
      handle(error)
    }
  }

  public func toggleSaved(_ item: TimelineItem) async {
    if let existing = savedArticle(for: item) {
      await unsave(existing)
    } else {
      await save(item)
    }
  }

  // MARK: Subscriptions

  /// Feed URLs found at a site (or the feed itself, if given one).
  public func discoverFeeds(at rawURL: String) async throws -> [String] {
    try await client.discoverFeeds(siteURL: Self.normalizedURL(rawURL))
  }

  /// Follows a feed and pulls its recent items straight in.
  public func subscribe(feedUrl: String, category: String? = nil) async throws {
    if subscriptions.contains(where: { $0.feedUrl == feedUrl }) { return }
    let siteHost = URL(string: feedUrl)?.host
    _ = try await client.subscribe(
      rkey: TID.generate(), feedUrl: feedUrl, title: siteHost, siteUrl: nil,
      category: category?.nilIfEmpty)
    try await syncSubscriptions()
    if let items = try? await client.fetchFeed(url: feedUrl) {
      merge(items)
      backfilled.insert(feedUrl)
    }
    trim()
    schedulePersist()
  }

  public func rename(_ subscription: Subscription, to title: String) async {
    await update(subscription, customTitle: title, category: nil) {
      $0.customTitle = title.nilIfEmpty
    }
  }

  public func move(_ subscription: Subscription, toFolder folder: String) async {
    await update(subscription, customTitle: nil, category: folder) {
      $0.category = folder.nilIfEmpty
    }
  }

  private func update(
    _ subscription: Subscription, customTitle: String?, category: String?,
    apply: (inout Subscription) -> Void
  ) async {
    guard let index = subscriptions.firstIndex(where: { $0.rkey == subscription.rkey }) else {
      return
    }
    let original = subscriptions[index]
    apply(&subscriptions[index])
    do {
      try await client.updateSubscription(
        rkey: subscription.rkey, customTitle: customTitle, category: category)
      schedulePersist()
    } catch {
      if let i = subscriptions.firstIndex(where: { $0.rkey == original.rkey }) {
        subscriptions[i] = original
      }
      handle(error)
    }
  }

  public func unsubscribe(_ subscription: Subscription) async {
    let snapshot = subscriptions
    subscriptions.removeAll { $0.rkey == subscription.rkey }
    do {
      try await client.unsubscribe(rkey: subscription.rkey)
      articles = articles.filter { $0.value.feedUrl != subscription.feedUrl }
      rebuildOrder()
      schedulePersist()
    } catch {
      subscriptions = snapshot
      handle(error)
    }
  }

  // MARK: Errors

  private func handle(_ error: any Error) {
    if case SkyreaderError.unauthorized = error {
      onUnauthorized?()
      return
    }
    if error is CancellationError { return }
    if let urlError = error as? URLError, urlError.code == .cancelled { return }
    lastError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
  }

  static func normalizedURL(_ raw: String) -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.lowercased().hasPrefix("http://") || trimmed.lowercased().hasPrefix("https://") {
      return trimmed
    }
    return "https://\(trimmed)"
  }

  // MARK: Persistence

  private struct Snapshot: Codable {
    var version = 1
    var articles: [TimelineItem]
    var subscriptions: [Subscription]
    var saved: [SavedArticle]
    var feedMeta: [String: FeedMetadata]
    var readGuids: [String]
    var timelineCursor: TimelineCursor?
    var timelineHead: Int?
    var readSince: String?
    var outbox: [PendingRead]
    var account: Account?
    var lastSynced: Date?
    var backfilled: [String]?
    var backfillCursor: String?
  }

  private func loadSnapshot() {
    guard let storeURL, let data = try? Data(contentsOf: storeURL),
      let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data),
      snapshot.version == 1
    else { return }
    articles = Dictionary(snapshot.articles.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
    subscriptions = snapshot.subscriptions
    saved = snapshot.saved
    feedMeta = snapshot.feedMeta
    readGuids = Set(snapshot.readGuids)
    timelineCursor = snapshot.timelineCursor
    timelineHead = snapshot.timelineHead
    readSince = snapshot.readSince
    outbox = snapshot.outbox
    account = snapshot.account
    lastSynced = snapshot.lastSynced
    backfilled = Set(snapshot.backfilled ?? [])
    backfillCursor = snapshot.backfillCursor
    rebuildOrder()
  }

  /// Coalesces writes: many changes in a burst cost one encode.
  private func schedulePersist() {
    guard storeURL != nil else { return }
    persistTask?.cancel()
    persistTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 500_000_000)
      guard !Task.isCancelled else { return }
      await self?.persistNow()
    }
  }

  /// Writes the snapshot to disk now. Encoding runs off the main actor.
  public func persistNow() async {
    guard let storeURL else { return }
    let snapshot = Snapshot(
      articles: Array(articles.values), subscriptions: subscriptions, saved: saved,
      feedMeta: feedMeta, readGuids: Array(readGuids), timelineCursor: timelineCursor,
      timelineHead: timelineHead, readSince: readSince, outbox: outbox, account: account,
      lastSynced: lastSynced, backfilled: Array(backfilled), backfillCursor: backfillCursor)
    await Task.detached(priority: .utility) {
      guard let data = try? JSONEncoder().encode(snapshot) else { return }
      try? FileManager.default.createDirectory(
        at: storeURL.deletingLastPathComponent(), withIntermediateDirectories: true)
      try? data.write(to: storeURL, options: .atomic)
    }.value
  }

  /// Forgets everything (sign-out).
  public func erase() {
    flushTask?.cancel()
    persistTask?.cancel()
    articles = [:]
    orderedIDs = []
    subscriptions = []
    saved = []
    feedMeta = [:]
    feedHealth = [:]
    readGuids = []
    timelineCursor = nil
    timelineHead = nil
    readSince = nil
    outbox = []
    account = nil
    lastSynced = nil
    backfilled = []
    backfillCursor = nil
    bodyCache = [:]
    if let storeURL { try? FileManager.default.removeItem(at: storeURL) }
  }
}

/// A read or un-read waiting to reach the server.
struct PendingRead: Codable, Hashable, Sendable {
  var mark: ReadMark
  var read: Bool
}

extension String {
  var nilIfEmpty: String? { isEmpty ? nil : self }
  var nilIfBlank: String? {
    trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : self
  }
}
