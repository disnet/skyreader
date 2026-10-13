import Foundation

/// The signed-in reader, from `GET /api/auth/me`.
public struct Account: Codable, Hashable, Sendable {
  public var did: String
  public var handle: String
  public var displayName: String?
  public var avatarUrl: String?
  public var tier: String?
}

/// URL the native sign-in flow comes back on (`backend/src/routes/native-auth.ts`).
public enum NativeSignIn {
  public static let callbackScheme = "skyreader"

  /// What came back on `skyreader://auth/callback`.
  public enum Callback: Equatable, Sendable {
    case code(String)
    case error(String)
  }

  public static func parseCallback(_ url: URL) -> Callback? {
    guard url.scheme == callbackScheme,
      let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
    else { return nil }
    if let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty {
      return .code(code)
    }
    if let error = items.first(where: { $0.name == "error" })?.value {
      return .error(error)
    }
    return nil
  }
}

extension SkyreaderClient {
  /// `GET /api/auth/login` in native mode. Returns the auth server URL to open
  /// in a web authentication session. `challenge` is base64url(SHA-256(verifier));
  /// the verifier stays on the device until `exchangeNativeCode`.
  public func nativeLoginURL(handle: String, challenge: String) async throws -> URL {
    struct Response: Decodable {
      var authUrl: String
      var native: Bool?
    }
    let response: Response = try await send(
      .get, "/api/auth/login",
      query: [
        URLQueryItem(name: "handle", value: handle),
        URLQueryItem(name: "native_challenge", value: challenge),
      ])
    // A server without native sign-in ignores the challenge and would finish
    // the flow in the web app, stranding the reader in the sheet.
    guard response.native == true else { throw SkyreaderError.nativeSignInUnsupported }
    guard let url = URL(string: response.authUrl) else { throw SkyreaderError.invalidResponse }
    return url
  }

  /// `POST /api/auth/native/exchange`: the one-time code plus the verifier for
  /// the session id.
  public func exchangeNativeCode(_ code: String, verifier: String) async throws -> String {
    struct Body: Encodable { var code: String; var verifier: String }
    struct Response: Decodable { var sessionId: String }
    let response: Response = try await send(
      .post, "/api/auth/native/exchange", body: Body(code: code, verifier: verifier))
    return response.sessionId
  }

  public func me() async throws -> Account {
    try await send(.get, "/api/auth/me")
  }

  /// `POST /api/auth/logout`: revokes the tokens and deletes the session.
  public func logout() async throws {
    try await sendRaw(.post, "/api/auth/logout")
  }
}
