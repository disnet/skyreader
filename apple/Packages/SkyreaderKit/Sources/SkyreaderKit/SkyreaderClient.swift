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

public enum SkyreaderError: Error, Equatable, Sendable {
  /// 401: the session is gone or expired. The app should sign the user out.
  case unauthorized
  case http(status: Int)
  case invalidResponse
}

/// Client for the Skyreader backend (`backend/`).
///
/// Authenticates with `Authorization: Bearer <session_id>`, which the backend
/// accepts alongside the web app's `session_id` cookie
/// (`getSessionFromRequest` in `backend/src/services/oauth.ts`).
public struct SkyreaderClient: Sendable {
  public static let production = URL(string: "https://api.skyreader.app")!

  public var baseURL: URL
  public var sessionID: String
  private let transport: any HTTPTransport

  public init(
    baseURL: URL = SkyreaderClient.production,
    sessionID: String,
    transport: any HTTPTransport = URLSession.shared
  ) {
    self.baseURL = baseURL
    self.sessionID = sessionID
    self.transport = transport
  }

  /// `GET /api/v2/timeline`. See `backend/src/routes/timeline.ts`.
  public func timeline(from cursor: TimelineCursor, limit: Int? = nil) async throws
    -> TimelineResponse
  {
    var query: [URLQueryItem] = []
    switch cursor {
    case .coldStart(let offset):
      if offset > 0 { query.append(URLQueryItem(name: "cold_offset", value: String(offset))) }
    case .incremental(let sinceSeq, let generation):
      query.append(URLQueryItem(name: "since_seq", value: String(sinceSeq)))
      query.append(URLQueryItem(name: "generation", value: generation))
    }
    if let limit { query.append(URLQueryItem(name: "limit", value: String(limit))) }
    return try await get("/api/v2/timeline", query: query)
  }

  func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
    var components = URLComponents(
      url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
    if !query.isEmpty { components.queryItems = query }
    var request = URLRequest(url: components.url!)
    request.setValue("Bearer \(sessionID)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")

    let (data, response) = try await transport.send(request)
    switch response.statusCode {
    case 200..<300: return try JSONDecoder().decode(T.self, from: data)
    case 401: throw SkyreaderError.unauthorized
    default: throw SkyreaderError.http(status: response.statusCode)
    }
  }
}
