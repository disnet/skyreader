import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// Sends one HTTP request. `URLSession` in the app; a stub in tests.
public protocol HTTPTransport: Sendable {
  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

extension URLSession: HTTPTransport {
  public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let (data, response) = try await data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw SkyreaderError.invalidResponse
    }
    return (data, http)
  }
}

public enum SkyreaderError: Error, Equatable, Sendable, LocalizedError {
  /// 401: the session is gone or expired. The app should sign the user out.
  case unauthorized
  /// 404 on endpoints where "missing" is an answer, not a failure.
  case notFound
  /// 429, with the server's `Retry-After` when it sent one.
  case rateLimited(retryAfter: TimeInterval?)
  /// Any other non-2xx. `message` is the backend's `{ "error": … }` when present.
  case http(status: Int, message: String?)
  case invalidResponse
  /// The server predates native app sign-in (`routes/native-auth.ts`).
  case nativeSignInUnsupported

  public var errorDescription: String? {
    switch self {
    case .unauthorized: "Your session has ended. Sign in again."
    case .notFound: "Not found."
    case .rateLimited: "Skyreader is busy. Try again in a moment."
    case .http(_, let message?): message
    case .http(let status, nil): "Skyreader returned an error (\(status))."
    case .invalidResponse: "Skyreader sent a response the app couldn't read."
    case .nativeSignInUnsupported: "This Skyreader server doesn't support signing in from the app yet."
    }
  }
}

/// Client for the Skyreader backend (`backend/`).
///
/// Authenticates with `Authorization: Bearer <session_id>`, which the backend
/// accepts alongside the web app's `session_id` cookie
/// (`resolveSessionFromRequest` in `backend/src/services/oauth.ts`). Endpoint
/// methods live in extensions, one file per area.
public struct SkyreaderClient: Sendable {
  public static let production = URL(string: "https://api.skyreader.app")!

  public var baseURL: URL
  public var sessionID: String?
  private let transport: any HTTPTransport
  /// Waits between 503 `session_refresh_pending` retries. Injected so tests
  /// don't sleep.
  private let backoff: @Sendable (Int) async -> Void

  public init(
    baseURL: URL = SkyreaderClient.production,
    sessionID: String?,
    transport: any HTTPTransport = URLSession.shared,
    backoff: @escaping @Sendable (Int) async -> Void = { attempt in
      // 400ms, 800ms, 1.6s, 3.2s — the web client's schedule (frontend api.ts).
      try? await Task.sleep(nanoseconds: 400_000_000 << UInt64(attempt))
    }
  ) {
    self.baseURL = baseURL
    self.sessionID = sessionID
    self.transport = transport
    self.backoff = backoff
  }

  enum Method: String { case get = "GET", post = "POST", patch = "PATCH", delete = "DELETE" }

  static let encoder = JSONEncoder()
  static let decoder = JSONDecoder()

  /// Sends a request and decodes the JSON response.
  func send<T: Decodable>(
    _ method: Method, _ path: String, query: [URLQueryItem] = [], body: (any Encodable)? = nil,
    as type: T.Type = T.self
  ) async throws -> T {
    let data = try await sendRaw(method, path, query: query, body: body)
    do {
      return try Self.decoder.decode(T.self, from: data)
    } catch {
      throw SkyreaderError.invalidResponse
    }
  }

  /// Sends a request and returns the raw body of a 2xx response.
  @discardableResult
  func sendRaw(
    _ method: Method, _ path: String, query: [URLQueryItem] = [], body: (any Encodable)? = nil
  ) async throws -> Data {
    var components = URLComponents(
      url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
    if !query.isEmpty { components.queryItems = query }
    var request = URLRequest(url: components.url!)
    request.httpMethod = method.rawValue
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let sessionID {
      request.setValue("Bearer \(sessionID)", forHTTPHeaderField: "Authorization")
    }
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try Self.encoder.encode(body)
    }

    // 503 `session_refresh_pending` means the server is refreshing the OAuth
    // tokens behind this session — transient, never a sign-out.
    var attempt = 0
    while true {
      let (data, response) = try await transport.send(request)
      switch response.statusCode {
      case 200..<300:
        return data
      case 401:
        throw SkyreaderError.unauthorized
      case 404:
        throw SkyreaderError.notFound
      case 429:
        let retryAfter = response.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init)
        throw SkyreaderError.rateLimited(retryAfter: retryAfter)
      case 503 where attempt < 4:
        await backoff(attempt)
        attempt += 1
      default:
        let message = (try? Self.decoder.decode(ErrorBody.self, from: data))?.message
        throw SkyreaderError.http(status: response.statusCode, message: message)
      }
    }
  }
}

private struct ErrorBody: Decodable {
  var error: String?
  var messageField: String?

  enum CodingKeys: String, CodingKey {
    case error
    case messageField = "message"
  }

  /// The human sentence when the backend sends one, else the error code.
  var message: String? { messageField ?? error }
}

/// `{ "success": true }` and other bodies the caller doesn't read.
struct Ignored: Decodable {}
