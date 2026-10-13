import Foundation

/// One article from `GET /api/v2/timeline`.
///
/// Mirrors `TimelineItem` in `backend/src/routes/timeline.ts` (a `FeedItem`
/// plus `seq`, `feedUrl` and `read`). Every field the backend marks optional is
/// optional here, so a new or dropped optional field never fails a decode.
public struct TimelineItem: Codable, Hashable, Sendable, Identifiable {
  public var guid: String
  public var url: String
  public var title: String
  public var author: String?
  public var content: String?
  public var summary: String?
  public var imageUrl: String?
  /// ISO 8601, as the crawler stored it. Parse with `publishedDate`.
  public var publishedAt: String
  public var seq: Int
  public var feedUrl: String
  public var read: Bool
  public var contentTruncated: Bool?
  public var bodyStored: Bool?
  public var contentLead: String?

  public var id: String { "\(feedUrl)\u{0}\(guid)" }

  public var publishedDate: Date? { ISO8601.parse(publishedAt) }

  public init(
    guid: String, url: String, title: String, author: String? = nil, content: String? = nil,
    summary: String? = nil, imageUrl: String? = nil, publishedAt: String, seq: Int,
    feedUrl: String, read: Bool = false, contentTruncated: Bool? = nil, bodyStored: Bool? = nil,
    contentLead: String? = nil
  ) {
    self.guid = guid
    self.url = url
    self.title = title
    self.author = author
    self.content = content
    self.summary = summary
    self.imageUrl = imageUrl
    self.publishedAt = publishedAt
    self.seq = seq
    self.feedUrl = feedUrl
    self.read = read
    self.contentTruncated = contentTruncated
    self.bodyStored = bodyStored
    self.contentLead = contentLead
  }
}

/// Per-feed display metadata, keyed by feed URL in `TimelineResponse.feeds`.
public struct FeedMetadata: Codable, Hashable, Sendable {
  public var title: String?
  public var siteUrl: String?
  public var imageUrl: String?

  public init(title: String? = nil, siteUrl: String? = nil, imageUrl: String? = nil) {
    self.title = title
    self.siteUrl = siteUrl
    self.imageUrl = imageUrl
  }
}

/// A feed the crawler is failing on. Absent from `feedHealth` means healthy.
public struct FeedHealth: Codable, Hashable, Sendable {
  public var errorCount: Int
  public var error: String?
}

/// The `GET /api/v2/timeline` response.
public struct TimelineResponse: Codable, Sendable {
  public var items: [TimelineItem]
  /// Pass back as `since_seq` on the next incremental poll.
  public var cursor: Int
  /// Pass back as `generation`; a change means the server reset and the client
  /// must cold-start again (the server detects the mismatch itself).
  public var generation: String
  /// False while ingest is off or the crawler is stale — the page is empty and
  /// says nothing about the user's feeds.
  public var ingestActive: Bool
  public var hasMore: Bool
  /// Set on a paged cold start; pass back as `cold_offset` for the next page.
  public var nextColdOffset: Int?
  public var coldStart: Bool
  /// Server clock, unix seconds. Seeds the read-positions delta cursor.
  public var readCursor: Int?
  public var feeds: [String: FeedMetadata]?
  public var feedHealth: [String: FeedHealth]?
  /// Only with `include_counts=1`.
  public var unreadCounts: [String: Int]?
  /// Archive max seq; only with `include_counts=1`. Send as `beforeSeq` when
  /// marking a feed read so items that arrived since aren't swept up.
  public var head: Int?
}

/// Where a timeline request starts from.
public enum TimelineCursor: Sendable, Equatable, Codable {
  /// No local state: the server returns each feed's newest window, paged.
  case coldStart(offset: Int = 0)
  /// Items after `sinceSeq` in the given server generation.
  case incremental(sinceSeq: Int, generation: String)
}

extension SkyreaderClient {
  /// `GET /api/v2/timeline`. See `backend/src/routes/timeline.ts`.
  public func timeline(
    from cursor: TimelineCursor, limit: Int? = nil, includeCounts: Bool = false
  ) async throws -> TimelineResponse {
    var query: [URLQueryItem] = []
    switch cursor {
    case .coldStart(let offset):
      if offset > 0 { query.append(URLQueryItem(name: "cold_offset", value: String(offset))) }
    case .incremental(let sinceSeq, let generation):
      query.append(URLQueryItem(name: "since_seq", value: String(sinceSeq)))
      query.append(URLQueryItem(name: "generation", value: generation))
    }
    if let limit { query.append(URLQueryItem(name: "limit", value: String(limit))) }
    if includeCounts { query.append(URLQueryItem(name: "include_counts", value: "1")) }
    return try await send(.get, "/api/v2/timeline", query: query)
  }
}

enum ISO8601 {
  // ISO8601DateFormatter is documented thread-safe once configured.
  nonisolated(unsafe) static let withFractionalSeconds: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()
  nonisolated(unsafe) static let plain = ISO8601DateFormatter()

  static func parse(_ string: String) -> Date? {
    withFractionalSeconds.date(from: string) ?? plain.date(from: string)
  }

  static func format(_ date: Date) -> String {
    withFractionalSeconds.string(from: date)
  }
}
