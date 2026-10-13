import Foundation

/// AT Protocol TID record keys. Port of `frontend/src/lib/utils/tid.ts` —
/// keep the two in sync.
///
/// 13 base32-sortable characters encoding a 64-bit integer: a 0 top bit, 53
/// bits of microseconds since the UNIX epoch, then a 10-bit clock id. It must
/// be a real TID, not a lookalike: lexicons declare `"key": "tid"` and
/// consumers act on it.
public enum TID {
  private static let alphabet = Array("234567abcdefghijklmnopqrstuvwxyz")
  private static let state = Mutex()

  /// A new TID, strictly greater than any this process generated before.
  public static func generate(now: Date = Date()) -> String {
    let micros = state.nextMicros(UInt64(now.timeIntervalSince1970 * 1_000_000))
    return encode(micros: micros, clockID: state.clockID)
  }

  static func encode(micros: UInt64, clockID: UInt64) -> String {
    let value = (micros << 10) | (clockID & 0x3FF)
    var tid = ""
    for shift in stride(from: 60, through: 0, by: -5) {
      tid.append(alphabet[Int((value >> UInt64(shift)) & 31)])
    }
    return tid
  }

  /// The creation time a TID encodes, or nil for an rkey that isn't one.
  public static func date(of rkey: String) -> Date? {
    guard rkey.count == 13 else { return nil }
    var value: UInt64 = 0
    for char in rkey {
      guard let digit = alphabet.firstIndex(of: char) else { return nil }
      value = value &* 32 &+ UInt64(digit)
    }
    guard value >> 63 == 0 else { return nil }
    let micros = value >> 10
    return micros > 0 ? Date(timeIntervalSince1970: Double(micros) / 1_000_000) : nil
  }

  /// Keeps TIDs monotonic within the process: several calls can land in the
  /// same microsecond, so bump past the last one.
  private final class Mutex: @unchecked Sendable {
    let clockID = UInt64.random(in: 0..<1024)
    private var lastMicros: UInt64 = 0
    private let lock = NSLock()

    func nextMicros(_ candidate: UInt64) -> UInt64 {
      lock.lock()
      defer { lock.unlock() }
      lastMicros = max(candidate, lastMicros + 1)
      return lastMicros
    }
  }
}
