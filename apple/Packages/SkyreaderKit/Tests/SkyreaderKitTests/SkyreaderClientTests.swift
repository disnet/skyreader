import Foundation
import XCTest

@testable import SkyreaderKit

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// Records the request and answers with a canned response.
final class StubTransport: HTTPTransport, @unchecked Sendable {
  var lastRequest: URLRequest?
  let status: Int
  let body: Data

  init(status: Int = 200, body: String) {
    self.status = status
    self.body = Data(body.utf8)
  }

  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    lastRequest = request
    let response = HTTPURLResponse(
      url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
    return (body, response)
  }
}

// Shaped like a real cold-start page, including fields the models don't read
// (readCursor, healthRev, feedHealth) to prove unknown keys decode away.
let coldStartPage = """
  {
    "items": [{
      "guid": "https://example.com/p/1",
      "url": "https://example.com/p/1",
      "title": "Hello",
      "summary": "A post",
      "publishedAt": "2026-09-01T12:00:00.000Z",
      "seq": 42,
      "feedUrl": "https://example.com/feed.xml",
      "read": false,
      "contentTruncated": true,
      "contentLead": "<p>Opening</p>"
    }],
    "cursor": 42,
    "generation": "g1",
    "ingestActive": true,
    "hasMore": true,
    "nextColdOffset": 25,
    "readCursor": 1790000000,
    "coldStart": true,
    "feeds": {"https://example.com/feed.xml": {"title": "Example"}},
    "healthRev": "r1",
    "feedHealth": {}
  }
  """

final class SkyreaderClientTests: XCTestCase {
  func testColdStartDecodesAndSendsBearerSession() async throws {
    let stub = StubTransport(body: coldStartPage)
    let client = SkyreaderClient(sessionID: "sess-123", transport: stub)

    let page = try await client.timeline(from: .coldStart())

    XCTAssertEqual(stub.lastRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer sess-123")
    XCTAssertEqual(stub.lastRequest?.url?.path, "/api/v2/timeline")
    XCTAssertNil(stub.lastRequest?.url?.query)
    XCTAssertEqual(page.items.count, 1)
    XCTAssertEqual(page.items[0].seq, 42)
    XCTAssertEqual(page.items[0].contentTruncated, true)
    XCTAssertNotNil(page.items[0].publishedDate)
    XCTAssertEqual(page.nextColdOffset, 25)
    XCTAssertEqual(page.feeds?["https://example.com/feed.xml"]?.title, "Example")
  }

  func testIncrementalAndColdOffsetQueries() async throws {
    let stub = StubTransport(body: coldStartPage)
    let client = SkyreaderClient(sessionID: "s", transport: stub)

    _ = try await client.timeline(from: .incremental(sinceSeq: 42, generation: "g1"), limit: 50)
    let incremental = URLComponents(url: stub.lastRequest!.url!, resolvingAgainstBaseURL: false)!
    XCTAssertEqual(
      incremental.queryItems,
      [
        URLQueryItem(name: "since_seq", value: "42"),
        URLQueryItem(name: "generation", value: "g1"),
        URLQueryItem(name: "limit", value: "50"),
      ])

    _ = try await client.timeline(from: .coldStart(offset: 25))
    XCTAssertEqual(stub.lastRequest?.url?.query, "cold_offset=25")
  }

  func testUnauthorizedMapsToError() async {
    let client = SkyreaderClient(
      sessionID: "s", transport: StubTransport(status: 401, body: "{}"))
    do {
      _ = try await client.timeline(from: .coldStart())
      XCTFail("expected unauthorized")
    } catch {
      XCTAssertEqual(error as? SkyreaderError, .unauthorized)
    }
  }
}
