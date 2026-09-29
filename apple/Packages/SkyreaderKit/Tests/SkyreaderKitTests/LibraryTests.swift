import Foundation
import XCTest

@testable import SkyreaderKit

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// Plays the backend: answers by path and records every request.
final class FakeBackend: HTTPTransport, @unchecked Sendable {
  typealias Handler = (URLRequest, [String: String], Any?) -> (Int, Any)
  private let lock = NSLock()
  private var handlers: [String: Handler] = [:]
  private(set) var requests: [URLRequest] = []

  func on(_ path: String, _ handler: @escaping Handler) {
    lock.withLock { handlers[path] = handler }
  }

  func requests(to path: String) -> [URLRequest] {
    lock.withLock { requests.filter { $0.url?.path == path } }
  }

  static func json(_ request: URLRequest) -> Any? {
    request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) }
  }

  static func query(_ request: URLRequest) -> [String: String] {
    let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
    return Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { $1 })
  }

  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let path = request.url!.path
    let handler: Handler? = lock.withLock {
      requests.append(request)
      return handlers[path] ?? handlers.first { path.hasPrefix($0.key + "/") }?.value
    }
    let (status, body) =
      handler?(request, Self.query(request), Self.json(request)) ?? (404, ["error": "Not found"])
    let data = try JSONSerialization.data(withJSONObject: body)
    let response = HTTPURLResponse(
      url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
    return (data, response)
  }
}

func item(_ guid: String, feed: String = "https://a.example/feed", day: Int, seq: Int, read: Bool = false)
  -> [String: Any]
{
  [
    "guid": guid, "url": "https://a.example/\(guid)", "title": "Post \(guid)",
    "publishedAt": String(format: "2026-09-%02dT10:00:00.000Z", day), "seq": seq, "feedUrl": feed,
    "read": read, "content": "<p>\(guid)</p>",
  ]
}

func timelinePage(
  _ items: [[String: Any]], cursor: Int, generation: String = "g1", coldStart: Bool,
  hasMore: Bool = false, nextColdOffset: Int? = nil
) -> [String: Any] {
  var page: [String: Any] = [
    "items": items, "cursor": cursor, "generation": generation, "ingestActive": true,
    "hasMore": hasMore, "coldStart": coldStart, "readCursor": 1_790_000_000, "healthRev": "r",
  ]
  if let nextColdOffset { page["nextColdOffset"] = nextColdOffset }
  return page
}

func subscriptionsBody() -> [String: Any] {
  [
  "records": [
    [
      "uri": "at://did:plc:me/app.skyreader.feed.subscription/3kaaaaaaaaaa2", "cid": "",
      "value": ["feedUrl": "https://a.example/feed", "title": "A", "category": "Tech"],
    ],
    [
      "uri": "at://did:plc:me/app.skyreader.feed.subscription/3kaaaaaaaaaa3", "cid": "",
      "value": ["feedUrl": "https://b.example/feed", "title": NSNull()],
    ],
  ]
  ]
}

@MainActor
final class LibraryTests: XCTestCase {
  var backend: FakeBackend!

  override func setUp() async throws {
    backend = FakeBackend()
    backend.on("/api/auth/me") { _, _, _ in (200, ["did": "did:plc:me", "handle": "me.test"]) }
    backend.on("/api/records/list") { _, _, _ in (200, subscriptionsBody()) }
    backend.on("/api/reading/positions") { _, _, _ in
      (200, ["positions": [], "cursor": 0, "nextSince": "c1", "hasMore": false])
    }
    backend.on("/api/saved") { _, _, _ in (200, ["articles": [], "cursor": NSNull(), "full": false]) }
    backend.on("/api/reading/mark-read-bulk") { _, _, _ in (200, ["success": true]) }
    backend.on("/api/reading/mark-unread") { _, _, _ in (200, ["success": true]) }
  }

  func makeLibrary(storeURL: URL? = nil) -> Library {
    Library(
      client: SkyreaderClient(sessionID: "s", transport: backend, backoff: { _ in }),
      storeURL: storeURL)
  }

  func testColdStartPagesThenPollsIncrementally() async {
    backend.on("/api/v2/timeline") { _, query, _ in
      if query["since_seq"] == "50" {
        return (200, timelinePage([item("new", day: 20, seq: 51)], cursor: 51, coldStart: false))
      }
      if query["cold_offset"] == "25" {
        return (
          200,
          timelinePage(
            [item("b1", feed: "https://b.example/feed", day: 2, seq: 3)], cursor: 49, coldStart: true))
      }
      return (
        200,
        timelinePage(
          [item("a1", day: 1, seq: 1), item("a2", day: 3, seq: 2, read: true)], cursor: 50,
          coldStart: true, hasMore: true, nextColdOffset: 25))
    }
    let library = makeLibrary()
    await library.refresh()

    XCTAssertEqual(library.articles(in: .all).map(\.guid), ["a2", "b1", "a1"])
    XCTAssertEqual(library.articles(in: .all, unreadOnly: true).map(\.guid), ["b1", "a1"])
    XCTAssertEqual(library.articles(in: .folder("Tech")).map(\.guid), ["a2", "a1"])
    XCTAssertEqual(library.unreadCount(in: .feed("https://b.example/feed")), 1)
    XCTAssertEqual(library.folders, ["Tech"])
    XCTAssertEqual(library.account?.handle, "me.test")

    await library.refresh()
    // The committed cursor is the FIRST cold page's, per the web client.
    let last = backend.requests(to: "/api/v2/timeline").last!
    XCTAssertEqual(FakeBackend.query(last)["since_seq"], "50")
    XCTAssertEqual(FakeBackend.query(last)["generation"], "g1")
    XCTAssertEqual(library.articles(in: .all).first?.guid, "new")
  }

  func testReadDeltaAppliesButLocalPendingWins() async {
    backend.on("/api/v2/timeline") { _, _, _ in
      (
        200,
        timelinePage(
          [item("x", day: 1, seq: 1, read: true), item("y", day: 2, seq: 2), item("z", day: 3, seq: 3)],
          cursor: 3, coldStart: true))
    }
    let library = makeLibrary()
    await library.refresh()
    XCTAssertTrue(library.readGuids.contains("x"))

    // Server says: x un-read elsewhere, y read elsewhere, z read elsewhere.
    backend.on("/api/reading/positions") { _, _, _ in
      (
        200,
        [
          "positions": [
            ["item_guid": "x", "item_type": "article", "deleted": true],
            ["item_guid": "y", "item_type": "article", "deleted": false],
            ["item_guid": "z", "item_type": "article", "deleted": false],
          ],
          "nextSince": "c2", "hasMore": false,
        ])
    }
    // ...but z was un-read locally and hasn't reached the server yet.
    backend.on("/api/reading/mark-unread") { _, _, _ in (500, ["error": "down"]) }
    let z = library.articles(in: .all).first { $0.guid == "z" }!
    library.setRead(z, true)
    library.setRead(z, false)
    await library.flushOutbox()
    XCTAssertEqual(library.pendingWrites, 1)

    await library.refresh()
    XCTAssertFalse(library.readGuids.contains("x"))
    XCTAssertTrue(library.readGuids.contains("y"))
    XCTAssertFalse(library.readGuids.contains("z"))
  }

  func testOutboxBatchesReadsWithActionTime() async throws {
    backend.on("/api/v2/timeline") { _, _, _ in
      (200, timelinePage([item("a", day: 1, seq: 1), item("b", day: 2, seq: 2)], cursor: 2, coldStart: true))
    }
    let library = makeLibrary()
    await library.refresh()
    library.setRead(library.articles(in: .all), true)
    await library.flushOutbox()

    let bulk = try XCTUnwrap(backend.requests(to: "/api/reading/mark-read-bulk").last)
    let body = try XCTUnwrap(FakeBackend.json(bulk) as? [String: Any])
    let items = try XCTUnwrap(body["items"] as? [[String: Any]])
    XCTAssertEqual(Set(items.compactMap { $0["itemGuid"] as? String }), ["a", "b"])
    XCTAssertTrue(items.allSatisfy { ($0["updatedAt"] as? Int64 ?? 0) > 1_700_000_000_000 })
    XCTAssertEqual(library.pendingWrites, 0)
  }

  func testSnapshotRestoresOfflineState() async throws {
    backend.on("/api/v2/timeline") { _, _, _ in
      (200, timelinePage([item("a", day: 1, seq: 7)], cursor: 7, coldStart: true))
    }
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString).appendingPathComponent("library.json")
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }

    let first = makeLibrary(storeURL: url)
    await first.refresh()
    first.setRead(first.articles(in: .all)[0], true)
    await first.persistNow()

    let second = makeLibrary(storeURL: url)
    XCTAssertEqual(second.articles(in: .all).map(\.guid), ["a"])
    XCTAssertTrue(second.readGuids.contains("a"))
    XCTAssertEqual(second.subscriptions.count, 2)

    // And it resumes from the stored cursor rather than cold-starting.
    await second.refresh()
    XCTAssertEqual(FakeBackend.query(backend.requests(to: "/api/v2/timeline").last!)["since_seq"], "7")

    second.erase()
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
  }

  func testTrimsEachFeedButKeepsSaved() async {
    let many = (0..<105).map { item("i\($0)", day: 1 + $0 % 28, seq: $0) }
    backend.on("/api/v2/timeline") { _, _, _ in (200, timelinePage(many, cursor: 105, coldStart: true)) }
    // i0 is among the oldest, but saved.
    backend.on("/api/saved") { _, _, _ in
      (
        200,
        [
          "articles": [
            [
              "rkey": "3kaaaaaaaaab2", "url": "https://a.example/i0", "savedAt": "2026-09-01T00:00:00Z",
              "itemGuid": "i0",
            ]
          ], "cursor": NSNull(),
        ])
    }
    let library = makeLibrary()
    await library.refresh()
    let guids = Set(library.articles(in: .all).map(\.guid))
    XCTAssertEqual(guids.count, Library.articlesPerFeed + 1)
    XCTAssertTrue(guids.contains("i0"))
  }

  func testUnsubscribedFeedsDropOut() async {
    backend.on("/api/v2/timeline") { _, _, _ in
      (
        200,
        timelinePage(
          [item("a", day: 1, seq: 1), item("gone", feed: "https://gone.example/feed", day: 2, seq: 2)],
          cursor: 2, coldStart: true))
    }
    let library = makeLibrary()
    await library.refresh()
    await library.refresh()
    XCTAssertEqual(library.articles(in: .all).map(\.guid), ["a"])
  }

  func testBackfillsFeedsTheTimelineMissed() async {
    // The timeline only knows feed A; feed B (followed elsewhere, or not yet
    // crawled) must be filled per-feed.
    backend.on("/api/v2/timeline") { _, _, _ in
      (200, timelinePage([item("a1", day: 1, seq: 1)], cursor: 1, coldStart: true))
    }
    var fetches: [String] = []
    backend.on("/api/v2/feeds/fetch") { _, query, _ in
      fetches.append(query["url"] ?? "")
      return (200, ["items": [item("b1", feed: "https://b.example/feed", day: 2, seq: 0)]])
    }
    let library = makeLibrary()
    await library.refresh()
    XCTAssertEqual(fetches, ["https://b.example/feed"])
    XCTAssertEqual(library.articles(in: .feed("https://b.example/feed")).map(\.guid), ["b1"])

    // Done once: B now has articles, and A never needed it.
    await library.refresh()
    XCTAssertEqual(fetches.count, 1)
  }

  func testBackfillRemembersEmptySuccessesButRetriesFailures() async {
    backend.on("/api/v2/timeline") { _, _, _ in
      (200, timelinePage([], cursor: 0, coldStart: true))
    }
    var calls: [String: Int] = [:]
    backend.on("/api/v2/feeds/fetch") { _, query, _ in
      let url = query["url"] ?? ""
      calls[url, default: 0] += 1
      // A is empty but fine; B is broken.
      return url.contains("a.example") ? (200, ["items": []]) : (502, ["error": "upstream"])
    }
    let library = makeLibrary()
    await library.refresh()
    await library.refresh()
    XCTAssertEqual(calls["https://a.example/feed"], 1)
    XCTAssertEqual(calls["https://b.example/feed"], 2)
    XCTAssertNil(library.lastError)
  }

  func testBackfillIsCappedPerSyncAndRotates() async {
    let many: [[String: Any]] = (0..<15).map { i in
      [
        "uri": "at://did:plc:me/app.skyreader.feed.subscription/3kaaaaaaaab\(String(format: "%02d", i))",
        "value": ["feedUrl": "https://f\(i).example/feed"],
      ]
    }
    backend.on("/api/records/list") { _, _, _ in (200, ["records": many]) }
    backend.on("/api/v2/timeline") { _, _, _ in (200, timelinePage([], cursor: 0, coldStart: true)) }
    var fetched: [String] = []
    backend.on("/api/v2/feeds/fetch") { _, query, _ in
      fetched.append(query["url"] ?? "")
      return (502, ["error": "down"])
    }
    let library = makeLibrary()
    await library.refresh()
    XCTAssertEqual(fetched.count, Library.backfillsPerSync)
    await library.refresh()
    // The second round starts where the first stopped, so all 15 get a turn.
    XCTAssertEqual(Set(fetched).count, 15)
  }

  func testUnauthorizedSignsOut() async {
    backend.on("/api/records/list") { _, _, _ in (401, ["error": "Unauthorized"]) }
    let library = makeLibrary()
    var signedOut = false
    library.onUnauthorized = { signedOut = true }
    await library.refresh()
    XCTAssertTrue(signedOut)
    XCTAssertNil(library.lastError)
  }

  func testRetriesSessionRefreshPending() async throws {
    var calls = 0
    backend.on("/api/auth/me") { _, _, _ in
      calls += 1
      if calls < 3 { return (503, ["error": "session_refresh_pending", "retryable": true]) }
      return (200, ["did": "did:plc:me", "handle": "me.test"])
    }
    let client = SkyreaderClient(sessionID: "s", transport: backend, backoff: { _ in })
    let account = try await client.me()
    XCTAssertEqual(account.handle, "me.test")
    XCTAssertEqual(calls, 3)
  }

  func testSubscriptionPatchOmitsUnchangedAndNullsCleared() async throws {
    backend.on("/api/subscriptions") { _, _, _ in (200, ["success": true]) }
    let client = SkyreaderClient(sessionID: "s", transport: backend)
    try await client.updateSubscription(rkey: "3kaaaaaaaaaa2", customTitle: nil, category: "")
    let request = try XCTUnwrap(backend.requests(to: "/api/subscriptions/3kaaaaaaaaaa2").last)
    XCTAssertEqual(request.httpMethod, "PATCH")
    let body = try XCTUnwrap(FakeBackend.json(request) as? [String: Any])
    XCTAssertEqual(body.keys.sorted(), ["category"])
    XCTAssertTrue(body["category"] is NSNull)
  }

  func testNativeLoginRequiresServerSupport() async throws {
    let client = SkyreaderClient(sessionID: nil, transport: backend)
    backend.on("/api/auth/login") { _, query, _ in
      XCTAssertEqual(query["native_challenge"], "c")
      return (200, ["authUrl": "https://bsky.social/oauth/authorize?x=1"])
    }
    do {
      _ = try await client.nativeLoginURL(handle: "me.test", challenge: "c")
      XCTFail("an old server must be refused")
    } catch {
      XCTAssertEqual(error as? SkyreaderError, .nativeSignInUnsupported)
    }

    backend.on("/api/auth/login") { _, _, _ in
      (200, ["authUrl": "https://bsky.social/oauth/authorize?x=1", "native": true])
    }
    let url = try await client.nativeLoginURL(handle: "me.test", challenge: "c")
    XCTAssertEqual(url.host, "bsky.social")
  }

  func testNativeCallbackParsing() {
    XCTAssertEqual(
      NativeSignIn.parseCallback(URL(string: "skyreader://auth/callback?code=abc")!), .code("abc"))
    XCTAssertEqual(
      NativeSignIn.parseCallback(URL(string: "skyreader://auth/callback?error=User%20declined")!),
      .error("User declined"))
    XCTAssertNil(NativeSignIn.parseCallback(URL(string: "https://evil.example/?code=abc")!))
  }
}
