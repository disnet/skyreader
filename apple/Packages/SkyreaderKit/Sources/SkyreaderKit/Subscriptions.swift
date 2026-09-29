import Foundation

/// A followed source, from `GET /api/records/list?collection=app.skyreader.feed.subscription`.
public struct Subscription: Codable, Hashable, Sendable, Identifiable {
  public var rkey: String
  public var feedUrl: String
  public var title: String?
  public var siteUrl: String?
  /// nil / "rss" for feeds; "email.newsletter"; "atproto.documents" /
  /// "atproto.collection" for standard.site sources.
  public var sourceType: String?
  public var customTitle: String?
  public var customIconUrl: String?
  /// The folder. Folders exist only as this string; there's no folder record.
  public var category: String?

  public var id: String { rkey }

  public var displayTitle: String {
    if let customTitle, !customTitle.isEmpty { return customTitle }
    if let title, !title.isEmpty { return title }
    return URL(string: siteUrl ?? feedUrl)?.host ?? feedUrl
  }

  /// Items reach the timeline only for RSS-shaped sources (feeds and
  /// newsletters); standard.site publications are served elsewhere.
  public var isInTimeline: Bool { !(sourceType?.hasPrefix("atproto.") ?? false) }

  public init(
    rkey: String, feedUrl: String, title: String? = nil, siteUrl: String? = nil,
    sourceType: String? = nil, customTitle: String? = nil, customIconUrl: String? = nil,
    category: String? = nil
  ) {
    self.rkey = rkey
    self.feedUrl = feedUrl
    self.title = title
    self.siteUrl = siteUrl
    self.sourceType = sourceType
    self.customTitle = customTitle
    self.customIconUrl = customIconUrl
    self.category = category
  }
}

/// `GET /api/v2/feeds/discover`.
public struct FeedDiscovery: Codable, Sendable {
  public var feeds: [String]
}

/// The outcome of subscribing; the server may hand back an existing rkey.
public struct CreatedSubscription: Codable, Sendable {
  public var rkey: String
  public var alreadySubscribed: Bool?
  public var reactivated: Bool?
}

extension SkyreaderClient {
  public func subscriptions() async throws -> [Subscription] {
    struct Record: Decodable {
      var uri: String
      var value: Value
    }
    struct Value: Decodable {
      // Null for some source types; such a record has nothing to read here.
      var feedUrl: String?
      var title: String?
      var siteUrl: String?
      var sourceType: String?
      var customTitle: String?
      var customIconUrl: String?
      var category: String?
    }
    // One odd record must not cost the reader every other subscription.
    struct Response: Decodable { var records: [Lossy<Record>] }
    let response: Response = try await send(
      .get, "/api/records/list",
      query: [URLQueryItem(name: "collection", value: "app.skyreader.feed.subscription")])
    return response.records.compactMap { entry in
      // at://<did>/app.skyreader.feed.subscription/<rkey>
      guard let record = entry.value, let feedUrl = record.value.feedUrl, !feedUrl.isEmpty,
        let rkey = record.uri.split(separator: "/").last.map(String.init)
      else { return nil }
      let v = record.value
      return Subscription(
        rkey: rkey, feedUrl: feedUrl, title: v.title, siteUrl: v.siteUrl,
        sourceType: v.sourceType, customTitle: v.customTitle, customIconUrl: v.customIconUrl,
        category: v.category)
    }
  }

  public func discoverFeeds(siteURL: String) async throws -> [String] {
    let response: FeedDiscovery = try await send(
      .get, "/api/v2/feeds/discover", query: [URLQueryItem(name: "url", value: siteURL)])
    return response.feeds
  }

  /// `POST /api/subscriptions`. Crawls the feed before answering, so it can
  /// take a few seconds. Use the returned rkey, not the one sent.
  public func subscribe(
    rkey: String, feedUrl: String, title: String?, siteUrl: String?, category: String?
  ) async throws -> CreatedSubscription {
    struct Body: Encodable {
      var rkey: String
      var feedUrl: String
      var title: String?
      var siteUrl: String?
      var category: String?
    }
    return try await send(
      .post, "/api/subscriptions",
      body: Body(rkey: rkey, feedUrl: feedUrl, title: title, siteUrl: siteUrl, category: category))
  }

  /// `PATCH /api/subscriptions/:rkey`. A nil argument leaves the field alone;
  /// an empty string clears it.
  public func updateSubscription(rkey: String, customTitle: String?, category: String?) async throws {
    struct Body: Encodable {
      var customTitle: String??
      var category: String??

      func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        // Omitted = unchanged; explicit null = clear (backend subscriptions.ts).
        if let customTitle { try c.encode(customTitle, forKey: .customTitle) }
        if let category { try c.encode(category, forKey: .category) }
      }
      enum CodingKeys: String, CodingKey { case customTitle, category }
    }
    func clearable(_ value: String?) -> String?? {
      guard let value else { return .none }
      return .some(value.isEmpty ? nil : value)
    }
    try await sendRaw(
      .patch, "/api/subscriptions/\(rkey)",
      body: Body(customTitle: clearable(customTitle), category: clearable(category)))
  }

  public func unsubscribe(rkey: String) async throws {
    try await sendRaw(.delete, "/api/subscriptions/\(rkey)")
  }
}

extension SkyreaderClient {
  /// `GET /api/v2/feeds/fetch`: one feed's newest items. Used to fill a feed
  /// that was just subscribed — the incremental timeline only carries items
  /// ingested after the cursor, not a new feed's back catalogue.
  public func fetchFeed(url feedUrl: String, limit: Int = 100) async throws -> [TimelineItem] {
    struct Item: Decodable {
      var guid: String
      var url: String
      var title: String
      var author: String?
      var content: String?
      var summary: String?
      var imageUrl: String?
      var publishedAt: String
      var seq: Int?
      var read: Bool?
      var contentTruncated: Bool?
      var bodyStored: Bool?
      var contentLead: String?
    }
    struct Response: Decodable { var items: [Item] }
    let response: Response = try await send(
      .get, "/api/v2/feeds/fetch",
      query: [URLQueryItem(name: "url", value: feedUrl), URLQueryItem(name: "limit", value: String(limit))])
    return response.items.map {
      TimelineItem(
        guid: $0.guid, url: $0.url, title: $0.title, author: $0.author, content: $0.content,
        summary: $0.summary, imageUrl: $0.imageUrl, publishedAt: $0.publishedAt, seq: $0.seq ?? 0,
        feedUrl: feedUrl, read: $0.read ?? false, contentTruncated: $0.contentTruncated,
        bodyStored: $0.bodyStored, contentLead: $0.contentLead)
    }
  }
}

/// Decodes an element, or nil if it doesn't fit, instead of failing its array.
struct Lossy<T: Decodable>: Decodable {
  var value: T?

  init(from decoder: any Decoder) throws {
    value = try? T(from: decoder)
  }
}
