import XCTest

@testable import SkyreaderKit

final class TIDTests: XCTestCase {
  func testShapeMatchesBackendValidation() {
    // Backend rkey check: /^[a-z0-9]{13,}$/, and a real TID is exactly 13.
    let tid = TID.generate()
    XCTAssertEqual(tid.count, 13)
    XCTAssertNotNil(tid.range(of: "^[2-7a-z]{13}$", options: .regularExpression))
  }

  func testMonotonicWithinProcess() {
    let now = Date()
    let a = TID.generate(now: now)
    let b = TID.generate(now: now)
    XCTAssertLessThan(a, b)
  }

  func testRoundTripsTimestamp() throws {
    let when = Date(timeIntervalSince1970: 1_790_000_000.123456)
    let date = try XCTUnwrap(TID.date(of: TID.encode(micros: 1_790_000_000_123_456, clockID: 7)))
    XCTAssertEqual(date.timeIntervalSince1970, when.timeIntervalSince1970, accuracy: 0.000001)
  }

  func testKnownEncoding() {
    // Same inputs through frontend/src/lib/utils/tid.ts give this string.
    XCTAssertEqual(TID.encode(micros: 0, clockID: 0), "2222222222222")
    XCTAssertEqual(TID.encode(micros: 1, clockID: 1), "2222222222323")
  }

  func testRejectsNonTIDs() {
    XCTAssertNil(TID.date(of: "short"))
    XCTAssertNil(TID.date(of: "ABCDEFGHIJKLM"))
    XCTAssertNil(TID.date(of: "zzzzzzzzzzzzz"))  // top bit set
  }
}
