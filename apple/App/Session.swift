import CryptoKit
import Foundation
import Observation
import SkyreaderKit

/// Which Skyreader backend the app talks to. Release builds always use
/// production; debug builds can pick, to test a branch before it deploys.
enum Server: String, CaseIterable, Identifiable {
  case production, staging, local

  var id: String { rawValue }

  var url: URL {
    switch self {
    case .production: SkyreaderClient.production
    case .staging: URL(string: "https://api-staging.skyreader.app")!
    // `./scripts/dev-local.sh` (the iOS Simulator shares the Mac's loopback).
    case .local: URL(string: "http://127.0.0.1:8787")!
    }
  }

  var label: String {
    switch self {
    case .production: "Production"
    case .staging: "Staging"
    case .local: "Local (127.0.0.1:8787)"
    }
  }
}

/// Who's signed in, and their library.
@MainActor
@Observable
final class Session {
  private(set) var library: Library?

  /// The backend for the next sign-in and everything after it. Stored, so a
  /// debug build stays on the server it signed in to.
  var server: Server {
    didSet { UserDefaults.standard.set(server.rawValue, forKey: Self.serverKey) }
  }
  private static let serverKey = "server"

  /// The secret behind the in-flight sign-in's challenge. Never leaves the
  /// device except in the exchange call (see backend routes/native-auth.ts).
  @ObservationIgnored private var pendingVerifier: String?

  init() {
    #if DEBUG
      server = UserDefaults.standard.string(forKey: Self.serverKey).flatMap(Server.init) ?? .production
    #else
      server = .production
    #endif
    if let sessionID = Keychain.sessionID { start(sessionID: sessionID) }
  }

  private static var storeURL: URL? {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
      .appendingPathComponent("Skyreader", isDirectory: true)
      .appendingPathComponent("library.json")
  }

  private func start(sessionID: String) {
    let library = Library(
      client: SkyreaderClient(baseURL: server.url, sessionID: sessionID), storeURL: Self.storeURL)
    library.onUnauthorized = { [weak self] in self?.endSession() }
    self.library = library
  }

  // MARK: Sign in

  /// Step 1: the auth server URL to open, bound to a fresh challenge.
  func beginSignIn(handle: String) async throws -> URL {
    let verifier = Self.randomVerifier()
    pendingVerifier = verifier
    let client = SkyreaderClient(baseURL: server.url, sessionID: nil)
    return try await client.nativeLoginURL(
      handle: Self.normalizedHandle(handle), challenge: Self.challenge(for: verifier))
  }

  /// Step 2: the `skyreader://auth/callback` URL the web session came back on.
  func completeSignIn(callback: URL) async throws {
    guard let verifier = pendingVerifier else { throw SignInError.noPendingSignIn }
    pendingVerifier = nil
    switch NativeSignIn.parseCallback(callback) {
    case .code(let code):
      let sessionID = try await SkyreaderClient(baseURL: server.url, sessionID: nil)
        .exchangeNativeCode(code, verifier: verifier)
      Keychain.sessionID = sessionID
      start(sessionID: sessionID)
    case .error(let message):
      throw SignInError.server(message)
    case nil:
      throw SignInError.malformedCallback
    }
  }

  #if DEBUG
    /// Development shortcut: a session id from `skyreader login` (cli/).
    func signIn(sessionID: String) {
      Keychain.sessionID = sessionID
      start(sessionID: sessionID)
    }
  #endif

  // MARK: Sign out

  func signOut() async {
    guard let library else { return }
    await library.flushOutbox()
    try? await library.client.logout()
    endSession()
  }

  /// Drops the session locally (the server already considers it gone, or we
  /// just revoked it).
  private func endSession() {
    library?.erase()
    library = nil
    Keychain.sessionID = nil
  }

  // MARK: Helpers

  enum SignInError: LocalizedError {
    case noPendingSignIn
    case malformedCallback
    case server(String)

    var errorDescription: String? {
      switch self {
      case .noPendingSignIn, .malformedCallback: "Sign-in didn't complete. Try again."
      case .server(let message): message
      }
    }
  }

  /// "@alice.bsky.social " -> "alice.bsky.social"; a bare name gets .bsky.social.
  static func normalizedHandle(_ raw: String) -> String {
    var handle = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if handle.hasPrefix("@") { handle.removeFirst() }
    if !handle.contains("."), !handle.hasPrefix("did:") { handle += ".bsky.social" }
    return handle
  }

  static func randomVerifier() -> String {
    var generator = SystemRandomNumberGenerator()
    let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
    return base64URL(Data(bytes))
  }

  static func challenge(for verifier: String) -> String {
    base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
  }

  private static func base64URL(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
