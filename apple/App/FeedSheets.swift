import SkyreaderKit
import SwiftUI

/// Add a site or feed: discover its feeds, pick one if there are several.
struct AddFeedView: View {
  @Environment(Library.self) private var library
  @Environment(\.dismiss) private var dismiss
  @State private var address = ""
  @State private var folder = ""
  @State private var candidates: [String] = []
  @State private var isWorking = false
  @State private var errorMessage: String?

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Website or feed address", text: $address)
            .autocorrectionDisabled()
            #if os(iOS)
              .textInputAutocapitalization(.never)
              .keyboardType(.URL)
            #endif
            .onSubmit(find)
          FolderField(folder: $folder)
        } footer: {
          Text("Paste a site's address and Skyreader finds its feed.")
        }

        if candidates.count > 1 {
          Section("This site has several feeds") {
            ForEach(candidates, id: \.self) { feed in
              Button(feed) { subscribe(to: feed) }
                .disabled(isWorking)
            }
          }
        }

        if let errorMessage {
          Section { Text(errorMessage).foregroundStyle(.red) }
        }
      }
      .formStyle(.grouped)
      .navigationTitle("Add Feed")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          if isWorking {
            ProgressView().controlSize(.small)
          } else {
            Button("Add", action: find)
              .disabled(address.trimmingCharacters(in: .whitespaces).isEmpty)
          }
        }
      }
    }
    #if os(macOS)
      .frame(minWidth: 420, minHeight: 260)
    #endif
  }

  private func find() {
    guard !isWorking, !address.trimmingCharacters(in: .whitespaces).isEmpty else { return }
    isWorking = true
    errorMessage = nil
    Task {
      defer { isWorking = false }
      do {
        let feeds = try await library.discoverFeeds(at: address)
        switch feeds.count {
        case 0: errorMessage = "No feed found at that address."
        case 1: await subscribeNow(to: feeds[0])
        default: candidates = feeds
        }
      } catch {
        errorMessage = message(for: error)
      }
    }
  }

  private func subscribe(to feed: String) {
    isWorking = true
    Task {
      defer { isWorking = false }
      await subscribeNow(to: feed)
    }
  }

  private func subscribeNow(to feed: String) async {
    do {
      try await library.subscribe(feedUrl: feed, category: folder)
      dismiss()
    } catch {
      errorMessage = message(for: error)
    }
  }
}

/// Save any page by its address.
struct SaveLinkView: View {
  @Environment(Library.self) private var library
  @Environment(\.dismiss) private var dismiss
  @State private var address = ""
  @State private var isWorking = false

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Page address", text: $address)
            .autocorrectionDisabled()
            #if os(iOS)
              .textInputAutocapitalization(.never)
              .keyboardType(.URL)
            #endif
            .onSubmit(save)
        } footer: {
          Text("Skyreader keeps a readable copy in Saved.")
        }
      }
      .formStyle(.grouped)
      .navigationTitle("Save a Link")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          if isWorking {
            ProgressView().controlSize(.small)
          } else {
            Button("Save", action: save)
              .disabled(address.trimmingCharacters(in: .whitespaces).isEmpty)
          }
        }
      }
    }
    #if os(macOS)
      .frame(minWidth: 420, minHeight: 180)
    #endif
  }

  private func save() {
    guard !isWorking else { return }
    isWorking = true
    Task {
      defer { isWorking = false }
      if await library.save(url: address) { dismiss() }
    }
  }
}

struct RenameFeedView: View {
  @Environment(Library.self) private var library
  @Environment(\.dismiss) private var dismiss
  let subscription: Subscription
  @State private var title: String

  init(subscription: Subscription) {
    self.subscription = subscription
    _title = State(initialValue: subscription.customTitle ?? subscription.displayTitle)
  }

  var body: some View {
    NavigationStack {
      Form {
        TextField("Name", text: $title)
          .onSubmit(save)
        if subscription.customTitle != nil {
          Button("Use the Feed's Own Name") {
            title = ""
            save()
          }
        }
      }
      .formStyle(.grouped)
      .navigationTitle("Rename Feed")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save", action: save)
        }
      }
    }
    #if os(macOS)
      .frame(minWidth: 360, minHeight: 160)
    #endif
  }

  private func save() {
    let name = title.trimmingCharacters(in: .whitespaces)
    Task { await library.rename(subscription, to: name) }
    dismiss()
  }
}

struct MoveFeedView: View {
  @Environment(Library.self) private var library
  @Environment(\.dismiss) private var dismiss
  let subscription: Subscription
  @State private var folder: String

  init(subscription: Subscription) {
    self.subscription = subscription
    _folder = State(initialValue: subscription.category ?? "")
  }

  var body: some View {
    NavigationStack {
      Form {
        FolderField(folder: $folder)
      }
      .formStyle(.grouped)
      .navigationTitle("Move \(subscription.displayTitle)")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Move") {
            let name = folder.trimmingCharacters(in: .whitespaces)
            Task { await library.move(subscription, toFolder: name) }
            dismiss()
          }
        }
      }
    }
    #if os(macOS)
      .frame(minWidth: 360, minHeight: 180)
    #endif
  }
}

/// A folder name: type a new one or pick an existing one.
struct FolderField: View {
  @Environment(Library.self) private var library
  @Binding var folder: String

  var body: some View {
    HStack {
      TextField("Folder (optional)", text: $folder)
      if !library.folders.isEmpty {
        Menu {
          Button("No Folder") { folder = "" }
          ForEach(library.folders, id: \.self) { name in
            Button(name) { folder = name }
          }
        } label: {
          Image(systemName: "folder")
        }
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel("Choose a folder")
      }
    }
  }
}

func message(for error: any Error) -> String {
  (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
}
