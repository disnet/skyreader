import Foundation
import Observation
import SkyreaderKit

/// App-wide state: the session and the loaded timeline.
@MainActor
@Observable
final class AppModel {
  private(set) var sessionID: String?
  private(set) var items: [TimelineItem] = []
  private(set) var feeds: [String: FeedMetadata] = [:]
  private(set) var isLoading = false
  var errorMessage: String?

  var showsError: Bool {
    get { errorMessage != nil }
    set { if !newValue { errorMessage = nil } }
  }

  // A cold start is paged by the server; stop well past any real reader's
  // subscription count rather than loop forever on a bad cursor.
  private static let maxColdStartPages = 40

  init() {
    sessionID = Keychain.sessionID
  }

  func signIn(sessionID: String) {
    Keychain.sessionID = sessionID
    self.sessionID = sessionID
  }

  func signOut() {
    Keychain.sessionID = nil
    sessionID = nil
    items = []
    feeds = [:]
  }

  /// Reloads the whole timeline with a cold start. Incremental polling
  /// (`since_seq` + `generation`) comes with local persistence.
  func refresh() async {
    guard let sessionID, !isLoading else { return }
    isLoading = true
    defer { isLoading = false }

    let client = SkyreaderClient(sessionID: sessionID)
    do {
      var collected: [TimelineItem] = []
      var feeds: [String: FeedMetadata] = [:]
      var cursor = TimelineCursor.coldStart()
      for _ in 0..<Self.maxColdStartPages {
        let page = try await client.timeline(from: cursor)
        collected += page.items
        feeds.merge(page.feeds ?? [:]) { _, new in new }
        guard page.hasMore, let next = page.nextColdOffset else { break }
        cursor = .coldStart(offset: next)
      }
      items = collected.sorted {
        ($0.publishedDate ?? .distantPast) > ($1.publishedDate ?? .distantPast)
      }
      self.feeds = feeds
    } catch SkyreaderError.unauthorized {
      signOut()
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}
