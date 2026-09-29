import SwiftUI

@main
struct SkyreaderApp: App {
  @State private var model = AppModel()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        // One Blue (DESIGN.md): the only interaction color.
        .tint(Color(red: 0, green: 0x66 / 255, blue: 0xCC / 255))
    }
  }
}

struct RootView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    if model.sessionID == nil {
      SignInView()
    } else {
      TimelineView()
    }
  }
}
