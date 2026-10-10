import AuthenticationServices
import SwiftUI

struct SignInView: View {
  @Environment(Session.self) private var session
  @Environment(\.webAuthenticationSession) private var webAuthenticationSession
  @State private var handle = ""
  @State private var isSigningIn = false
  @State private var errorMessage: String?
  #if DEBUG
    @State private var showsSessionField = false
    @State private var sessionID = ""
  #endif

  var body: some View {
    #if DEBUG
      @Bindable var session = session
    #endif
    VStack(spacing: 20) {
      VStack(spacing: 8) {
        Text("Skyreader")
          .font(.largeTitle.bold())
        Text("Everything you follow, in one calm place.")
          .foregroundStyle(.secondary)
      }

      VStack(spacing: 12) {
        TextField("Your handle, like alice.bsky.social", text: $handle)
          .textFieldStyle(.roundedBorder)
          .autocorrectionDisabled()
          .textContentType(.username)
          #if os(iOS)
            .textInputAutocapitalization(.never)
            .keyboardType(.emailAddress)
          #endif
          .onSubmit(signIn)

        Button(action: signIn) {
          if isSigningIn {
            ProgressView().controlSize(.small)
          } else {
            Text("Sign In").frame(maxWidth: .infinity)
          }
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(isSigningIn || handle.trimmingCharacters(in: .whitespaces).isEmpty)

        if let errorMessage {
          Text(errorMessage)
            .font(.footnote)
            .foregroundStyle(.red)
            .multilineTextAlignment(.center)
        }

        Text("Sign in with your Bluesky or other Atmosphere account.")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
      }

      #if DEBUG
        Picker("Server", selection: $session.server) {
          ForEach(Server.allCases) { Text($0.label).tag($0) }
        }
        .font(.footnote)

        DisclosureGroup("Developer sign-in", isExpanded: $showsSessionField) {
          TextField("Session ID from `skyreader login`", text: $sessionID)
            .textFieldStyle(.roundedBorder)
            .autocorrectionDisabled()
          Button("Use Session ID") {
            session.signIn(sessionID: sessionID.trimmingCharacters(in: .whitespacesAndNewlines))
          }
          .disabled(sessionID.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .font(.footnote)
      #endif
    }
    .padding(24)
    .frame(maxWidth: 400)
  }

  private func signIn() {
    guard !isSigningIn, !handle.trimmingCharacters(in: .whitespaces).isEmpty else { return }
    isSigningIn = true
    errorMessage = nil
    Task {
      defer { isSigningIn = false }
      do {
        let authURL = try await session.beginSignIn(handle: handle)
        let callback = try await webAuthenticationSession.authenticate(
          using: authURL, callbackURLScheme: "skyreader")
        try await session.completeSignIn(callback: callback)
      } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
        // The reader closed the sheet; nothing to say.
      } catch {
        errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
      }
    }
  }
}
