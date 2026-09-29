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

  public var publishedDate: Date? {
    ISO8601DateFormatter.withFractionalSeconds.date(from: publishedAt)
      ?? ISO8601DateFormatter.plain.date(from: publishedAt)
  }
}

/// Per-feed display metadata, keyed by feed URL in `TimelineResponse.feeds`.
public struct FeedMetadata: Codable, Hashable, Sendable {
  public var title: String?
  public var siteUrl: String?
  public var imageUrl: String?
}

/// The `GET /api/v2/timeline` response. Only the fields the app reads so far;
/// the rest (feed health, unread counts) decode away silently.
public struct TimelineResponse: Codable, Sendable {
  public var items: [TimelineItem]
  /// Pass back as `since_seq` on the next incremental poll.
  public var cursor: Int
  /// Pass back as `generation`; a change means the server reset and the client
  /// must cold-start again.
  public var generation: String
  /// False while ingest is off or the crawler is stale — the page is empty and
  /// says nothing about the user's feeds.
  public var ingestActive: Bool
  public var hasMore: Bool
  /// Set on a paged cold start; pass back as `cold_offset` for the next page.
  public var nextColdOffset: Int?
  public var coldStart: Bool
  public var feeds: [String: FeedMetadata]?
}

/// Where a timeline request starts from.
public enum TimelineCursor: Sendable, Equatable {
  /// No local state: the server returns each feed's newest window, paged.
  case coldStart(offset: Int = 0)
  /// Items after `sinceSeq` in the given server generation.
  case incremental(sinceSeq: Int, generation: String)
}

extension ISO8601DateFormatter {
  // ISO8601DateFormatter is documented thread-safe once configured.
  nonisolated(unsafe) static let withFractionalSeconds: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()
  nonisolated(unsafe) static let plain = ISO8601DateFormatter()
}
