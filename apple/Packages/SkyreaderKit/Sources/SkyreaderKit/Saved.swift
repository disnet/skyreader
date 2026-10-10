import Foundation

/// A saved article, from `GET /api/saved` (metadata only; the body comes from
/// `savedBodies`).
public struct SavedArticle: Codable, Hashable, Sendable, Identifiable {
  public var rkey: String
  public var url: String
  public var title: String?
  public var author: String?
  public var description: String?
  public var domain: String?
  public var image: String?
  public var wordCount: Int?
  public var publishedAt: String?
  public var savedAt: String
  /// "url" | "feed" | "share" | "document".
  public var source: String?
  /// The timeline item's guid for a save made from the feed.
  public var itemGuid: String?

  public var id: String { rkey }
  public var savedDate: Date? { ISO8601.parse(savedAt) }
  public var publishedDate: Date? { publishedAt.flatMap(ISO8601.parse) }

  public var displayTitle: String {
    if let title, !title.isEmpty { return title }
    return domain ?? url
  }

  public init(
    rkey: String, url: String, title: String? = nil, author: String? = nil,
    description: String? = nil, domain: String? = nil, image: String? = nil,
    wordCount: Int? = nil, publishedAt: String? = nil, savedAt: String, source: String? = nil,
    itemGuid: String? = nil
  ) {
    self.rkey = rkey
    self.url = url
    self.title = title
    self.author = author
    self.description = description
    self.domain = domain
    self.image = image
    self.wordCount = wordCount
    self.publishedAt = publishedAt
    self.savedAt = savedAt
    self.source = source
    self.itemGuid = itemGuid
  }
}

public struct SavedPage: Codable, Sendable {
  public var articles: [SavedArticle]
  public var cursor: String?
  /// True for Semble/Margin-backed saves: the page is the whole list.
  public var full: Bool?
}

/// The fields `POST /api/saved` accepts.
public struct NewSave: Encodable, Sendable {
  public var rkey: String
  public var url: String
  public var fromFeed: Bool?
  public var itemGuid: String?
  public var title: String?
  public var author: String?
  public var description: String?
  public var content: String?
  public var image: String?
  public var publishedAt: String?
  public var domain: String?
  public var wordCount: Int?

  public init(
    rkey: String, url: String, fromFeed: Bool? = nil, itemGuid: String? = nil,
    title: String? = nil, author: String? = nil, description: String? = nil,
    content: String? = nil, image: String? = nil, publishedAt: String? = nil,
    domain: String? = nil, wordCount: Int? = nil
  ) {
    self.rkey = rkey
    self.url = url
    self.fromFeed = fromFeed
    self.itemGuid = itemGuid
    self.title = title
    self.author = author
    self.description = description
    self.content = content
    self.image = image
    self.publishedAt = publishedAt
    self.domain = domain
    self.wordCount = wordCount
  }
}

extension SkyreaderClient {
  public func saved(cursor: String? = nil, limit: Int = 200) async throws -> SavedPage {
    var query = [URLQueryItem(name: "limit", value: String(limit))]
    if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
    return try await send(.get, "/api/saved", query: query)
  }

  /// Every save, newest first, following the cursor.
  public func allSaved(maxPages: Int = 50) async throws -> [SavedArticle] {
    var all: [SavedArticle] = []
    var cursor: String?
    for _ in 0..<maxPages {
      let page = try await saved(cursor: cursor)
      all += page.articles
      guard page.full != true, let next = page.cursor, !page.articles.isEmpty else { break }
      cursor = next
    }
    return all
  }

  /// `POST /api/saved/bodies`: stored HTML for up to 200 saves.
  public func savedBodies(rkeys: [String]) async throws -> [String: String] {
    struct Body: Encodable { var rkeys: [String] }
    struct Response: Decodable { var bodies: [String: String?] }
    let response: Response = try await send(
      .post, "/api/saved/bodies", body: Body(rkeys: Array(rkeys.prefix(200))))
    return response.bodies.compactMapValues { $0 }
  }

  /// `POST /api/saved`. 409 (already saved) surfaces as `.http(409, …)`.
  public func save(_ save: NewSave) async throws {
    try await sendRaw(.post, "/api/saved", body: save)
  }

  public func deleteSaved(rkey: String) async throws {
    try await sendRaw(.delete, "/api/saved/\(rkey)")
  }
}
