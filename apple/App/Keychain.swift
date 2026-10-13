import Foundation
import Security

/// The session ID, kept in the keychain rather than UserDefaults.
enum Keychain {
  private static let service = "app.skyreader.session"
  private static let account = "session_id"

  private static var baseQuery: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }

  static var sessionID: String? {
    get {
      var query = baseQuery
      query[kSecReturnData as String] = true
      query[kSecMatchLimit as String] = kSecMatchLimitOne
      var result: AnyObject?
      guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
        let data = result as? Data
      else { return nil }
      return String(data: data, encoding: .utf8)
    }
    set {
      _ = SecItemDelete(baseQuery as CFDictionary)
      guard let newValue else { return }
      var query = baseQuery
      query[kSecValueData as String] = Data(newValue.utf8)
      query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
      _ = SecItemAdd(query as CFDictionary, nil)
    }
  }
}
