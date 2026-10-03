import SkyreaderKit
import SwiftUI

struct SettingsView: View {
  @Environment(Session.self) private var session
  @Environment(\.dismiss) private var dismiss
  @State private var confirmsSignOut = false

  var body: some View {
    Form {
      if let library = session.library {
        Section("Account") {
          if let account = library.account {
            LabeledContent("Signed in as", value: "@\(account.handle)")
            if let name = account.displayName, !name.isEmpty {
              LabeledContent("Name", value: name)
            }
            if let tier = account.tier {
              LabeledContent("Plan", value: tier.capitalized)
            }
          }
          #if DEBUG
            LabeledContent("Server", value: session.server.label)
          #endif
          Button("Sign Out", role: .destructive) { confirmsSignOut = true }
        }

        Section("Sync") {
          if let synced = library.lastSynced {
            LabeledContent("Last synced") {
              Text(synced, format: .relative(presentation: .named))
            }
          }
          if library.pendingWrites > 0 {
            LabeledContent("Waiting to sync", value: "\(library.pendingWrites) changes")
          }
          Button("Sync Now") { Task { await library.refresh() } }
            .disabled(library.isSyncing)
        }

        Section {
          Link("Open Skyreader on the web", destination: URL(string: "https://skyreader.app")!)
          Link("Help", destination: URL(string: "https://docs.skyreader.app")!)
        }
      } else {
        Text("Not signed in.")
      }
    }
    .formStyle(.grouped)
    .navigationTitle("Settings")
    #if os(macOS)
      .frame(width: 420)
      .padding(.vertical)
    #else
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    #endif
    .confirmationDialog("Sign out of Skyreader?", isPresented: $confirmsSignOut) {
      Button("Sign Out", role: .destructive) {
        Task {
          await session.signOut()
          dismiss()
        }
      }
    } message: {
      Text("Your feeds and saves stay in your account. This device forgets them until you sign in again.")
    }
  }
}
