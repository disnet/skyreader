import Foundation

/// A read (or un-read) the app still owes the server. `updatedAt` is the
/// user's action time in unix ms — the backend's last-write-wins key.
public struct ReadMark: Codable, Hashable, Sendable {
  public var itemGuid: String
  public var itemUrl: String?
  public var itemTitle: String?
  public var updatedAt: Int64

  public init(itemGuid: String, itemUrl: String? = nil, itemTitle: String? = nil, updatedAt: Int64) {
    self.itemGuid = itemGuid
    self.itemUrl = itemUrl
    self.itemTitle = itemTitle
    self.updatedAt = updatedAt
  }
}

/// One row of the read-state delta (`GET /api/reading/positions`).
public struct ReadPosition: Codable, Hashable, Sendable {
  public var itemGuid: String
  public var itemType: String
  public var deleted: Bool
  public var clientUpdatedAt: Int64?

  enum CodingKeys: String, CodingKey {
    case itemGuid = "item_guid"
    case itemType = "item_type"
    case deleted
    case clientUpdatedAt = "client_updated_at"
  }
}

public struct ReadPositionsPage: Codable, Sendable {
  public var positions: [ReadPosition]
  /// Persist and send back as `since`.
  public var nextSince: String?
  public var hasMore: Bool
}

extension SkyreaderClient {
  /// `POST /api/reading/mark-read-bulk`, at most 500 per call.
  public func markRead(_ marks: [ReadMark]) async throws {
    struct Item: Encodable {
      var itemGuid: String
      var itemType = "article"
      var itemUrl: String?
      var itemTitle: String?
      var updatedAt: Int64
    }
    struct Body: Encodable { var items: [Item] }
    for chunk in stride(from: 0, to: marks.count, by: 500) {
      let items = marks[chunk..<min(chunk + 500, marks.count)].map {
        Item(itemGuid: $0.itemGuid, itemUrl: $0.itemUrl, itemTitle: $0.itemTitle, updatedAt: $0.updatedAt)
      }
      try await sendRaw(.post, "/api/reading/mark-read-bulk", body: Body(items: items))
    }
  }

  /// `POST /api/reading/mark-unread`.
  public func markUnread(_ mark: ReadMark) async throws {
    struct Body: Encodable { var itemGuid: String; var updatedAt: Int64 }
    try await sendRaw(
      .post, "/api/reading/mark-unread",
      body: Body(itemGuid: mark.itemGuid, updatedAt: mark.updatedAt))
  }

  /// `POST /api/reading/mark-feed-read`. Without `feedUrl`, every RSS feed.
  /// `beforeSeq` (the timeline `head`) keeps newer arrivals unread.
  public func markFeedRead(feedUrl: String?, beforeSeq: Int?, updatedAt: Int64) async throws {
    struct Body: Encodable { var feedUrl: String?; var beforeSeq: Int?; var updatedAt: Int64 }
    try await sendRaw(
      .post, "/api/reading/mark-feed-read",
      body: Body(feedUrl: feedUrl, beforeSeq: beforeSeq, updatedAt: updatedAt))
  }

  /// `GET /api/reading/positions`: reads and un-reads since `since`, oldest first.
  public func readPositions(since: String?, limit: Int = 1000) async throws -> ReadPositionsPage {
    var query = [URLQueryItem(name: "limit", value: String(limit))]
    if let since { query.append(URLQueryItem(name: "since", value: since)) }
    return try await send(.get, "/api/reading/positions", query: query)
  }
}
