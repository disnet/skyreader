import XCTest

@testable import SkyreaderKit

final class PlainTextTests: XCTestCase {
  func testStripsTagsAndKeepsParagraphs() {
    XCTAssertEqual(
      PlainText.from(html: "<p>One <b>bold</b>  word.</p>\n<p>Two&nbsp;&amp; three</p>"),
      "One bold word.\n\nTwo & three")
  }

  func testAmpersandDecodedLast() {
    XCTAssertEqual(PlainText.from(html: "&amp;lt;tag&amp;gt;"), "&lt;tag&gt;")
  }

  func testPreviewPrefersContentThenLeadThenSummary() throws {
    let data = Data(coldStartPage.utf8)
    var item = try JSONDecoder().decode(TimelineResponse.self, from: data).items[0]
    XCTAssertEqual(item.previewText, "Opening")
    item.contentLead = "<p> </p>"
    XCTAssertEqual(item.previewText, "A post")
    item.content = "<div>Full body</div>"
    XCTAssertEqual(item.previewText, "Full body")
  }
}
