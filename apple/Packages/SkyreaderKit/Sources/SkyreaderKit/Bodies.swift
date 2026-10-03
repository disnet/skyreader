import Foundation

/// `POST /api/extract`: the article at a URL, run through the server's reader
/// extraction.
public struct ExtractedArticle: Codable, Hashable, Sendable {
  public var title: String?
  public var author: String?
  public var description: String?
  public var content: String?
  public var domain: String?
  public var image: String?
  public var published: String?
  public var wordCount: Int?
}

extension SkyreaderClient {
  /// `GET /api/v2/items/body`: the stored full body of an item whose content
  /// was truncated at ingest. Nil when the server has no copy.
  public func itemBody(feedUrl: String, guid: String) async throws -> String? {
    struct Response: Decodable { var content: String }
    do {
      let response: Response = try await send(
        .get, "/api/v2/items/body",
        query: [
          URLQueryItem(name: "feed_url", value: feedUrl), URLQueryItem(name: "guid", value: guid),
        ])
      return response.content
    } catch SkyreaderError.notFound {
      return nil
    }
  }

  public func extract(url: String) async throws -> ExtractedArticle {
    struct Body: Encodable { var url: String }
    return try await send(.post, "/api/extract", body: Body(url: url))
  }
}
