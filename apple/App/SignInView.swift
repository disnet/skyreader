import SwiftUI

struct SignInView: View {
  @Environment(AppModel.self) private var model
  @State private var sessionID = ""

  var body: some View {
    VStack(spacing: 16) {
      Text("Skyreader")
        .font(.largeTitle.bold())
      Text("Everything you follow, in one calm place.")
        .foregroundStyle(.secondary)

      #if DEBUG
        // Stand-in until native OAuth lands: paste the session ID that
        // `skyreader login` (cli/) writes to ~/.config/skyreader/config.json.
        TextField("Session ID", text: $sessionID)
          .textFieldStyle(.roundedBorder)
          .autocorrectionDisabled()
          #if os(iOS)
            .textInputAutocapitalization(.never)
          #endif
        Button("Sign In") {
          model.signIn(sessionID: sessionID.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        .buttonStyle(.borderedProminent)
        .disabled(sessionID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        Text("Development build: paste a session ID from the Skyreader CLI.")
          .font(.footnote)
          .foregroundStyle(.secondary)
      #else
        Text("Sign-in is coming soon.")
          .foregroundStyle(.secondary)
      #endif
    }
    .padding()
    .frame(maxWidth: 420)
  }
}
