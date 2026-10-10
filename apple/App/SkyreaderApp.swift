import SwiftUI

@main
struct SkyreaderApp: App {
  @State private var session = Session()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(session)
        .tint(.skyBlue)
    }
    .commands { ReaderCommands() }

    #if os(macOS)
      Settings {
        SettingsView()
          .environment(session)
          .tint(.skyBlue)
      }
    #endif
  }
}

struct RootView: View {
  @Environment(Session.self) private var session

  var body: some View {
    if let library = session.library {
      MainView()
        .environment(library)
        // A fresh view tree per account, so no state leaks across sign-ins.
        .id(ObjectIdentifier(library))
    } else {
      SignInView()
    }
  }
}

extension Color {
  /// One Blue (DESIGN.md): the only interaction color.
  static let skyBlue = Color(red: 0, green: 0x66 / 255, blue: 0xCC / 255)
}
