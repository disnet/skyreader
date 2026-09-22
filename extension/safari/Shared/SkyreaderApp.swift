import SafariServices
import SwiftUI

@main
struct SkyreaderApp: App {
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 18) {
                Image(nsImage: NSApplication.shared.applicationIconImage)
                    .resizable()
                    .frame(width: 96, height: 96)
                Text("Skyreader for Safari")
                    .font(.title2)
                Text("Enable Skyreader in Safari Extensions, then allow access to api.skyreader.app.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                Button("Open Safari Extensions") {
                    SFSafariApplication.showPreferencesForExtension(
                        withIdentifier: "app.skyreader.extension.Extension"
                    )
                }
                .buttonStyle(.borderedProminent)
                .tint(Color(red: 0, green: 0.4, blue: 0.8))
            }
            .padding(32)
            .frame(width: 440)
        }
        .windowResizability(.contentSize)
    }
}
