// Workbench for macOS: a native window around the Workbench board.
//
// The app bundles Node (with npm) and Workbench. It asks which git repository to work on (or reopens a recent one),
// starts `node workbench/bin/workbench.mjs --repo <folder> --app`, and shows the board in its own window. Its pipe to
// Workbench's standard input is a lifeline: when the app quits, or crashes, the pipe closes and Workbench stops its
// agents, as on Ctrl-C. Nothing here talks to the agents: the page does that, exactly as in a browser.
//
// Testing without clicks: `Workbench --repo <folder>` or `Workbench --demo` opens it at once; `--self-test` loads
// the board, writes what it found to the log and to standard output, and quits.

import AppKit
import WebKit

let ACTIVE_STATES: Set<String> = ["starting", "working", "waiting_helpers", "needs_ok", "question", "maybe_stuck"]

// ------------------------------------------------------------------ the log

final class Log {
  static let shared = Log()
  let url: URL
  private let handle: FileHandle?
  private init() {
    let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Workbench", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    url = dir.appendingPathComponent("workbench.log")
    // keep it small: one older copy
    if let size = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber, size.intValue > 5_000_000 {
      let old = dir.appendingPathComponent("workbench.1.log")
      try? FileManager.default.removeItem(at: old)
      try? FileManager.default.moveItem(at: url, to: old)
    }
    if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
    handle = try? FileHandle(forWritingTo: url)
    _ = try? handle?.seekToEnd()
  }
  func write(_ line: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    if let data = "\(stamp) \(line)\n".data(using: .utf8) { try? handle?.write(contentsOf: data) }
  }
}

// ------------------------------------------------------------------ recent folders

enum Recents {
  static let key = "recentFolders"
  static func list() -> [URL] {
    (UserDefaults.standard.stringArray(forKey: key) ?? []).map { URL(fileURLWithPath: $0) }
  }
  static func add(_ url: URL) {
    var paths = list().map { $0.path }.filter { $0 != url.path }
    paths.insert(url.path, at: 0)
    UserDefaults.standard.set(Array(paths.prefix(10)), forKey: key)
  }
  static func clear() { UserDefaults.standard.removeObject(forKey: key) }
}

/// The Claude Code program the person chose, when Workbench could not find one (given with --claude while it is there).
enum ChosenClaude {
  static let key = "claudePath"
  static var path: String? {
    guard let p = UserDefaults.standard.string(forKey: key), FileManager.default.isExecutableFile(atPath: p) else { return nil }
    return p
  }
  static func set(_ p: String) { UserDefaults.standard.set(p, forKey: key) }
}

// ------------------------------------------------------------------ the environment Workbench and its agents get

/// An app opened from the Finder or the Dock gets launchd's bare environment: PATH is /usr/bin:/bin:/usr/sbin:/sbin,
/// and there is no LANG. Workbench, its agents and the repository's checks get what a terminal would give them, as near
/// as an app can tell without running a shell. The folders installers put programs in (Claude Code's installer,
/// Homebrew, /usr/local) go ahead of a PATH of system folders only; a PATH with folders of the person's own keeps its
/// order, and they go after it. Then /etc/paths and /etc/paths.d, which path_helper adds for a login shell. A UTF-8
/// locale is added when none is set; Workbench's own git calls set their locale themselves.
enum Environment {
  static let barePath: Set<String> = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]

  static func forWorkbench() -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    let fm = FileManager.default
    let home = fm.homeDirectoryForCurrentUser.path
    func isFolder(_ p: String) -> Bool { var d: ObjCBool = false; return fm.fileExists(atPath: p, isDirectory: &d) && d.boolValue }
    let given = (env["PATH"] ?? "").split(separator: ":").map(String.init).filter { !$0.isEmpty }
    let installers = ["\(home)/.local/bin", "\(home)/.claude/local", "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"].filter(isFolder)
    var system: [String] = []
    var files = ["/etc/paths"]
    if let more = try? fm.contentsOfDirectory(atPath: "/etc/paths.d") { files += more.sorted().map { "/etc/paths.d/\($0)" } }
    for f in files {
      for line in ((try? String(contentsOfFile: f, encoding: .utf8)) ?? "").split(whereSeparator: \.isNewline) {
        let d = line.trimmingCharacters(in: .whitespaces)
        if d.hasPrefix("/") { system.append(d) }
      }
    }
    let bare = Set(given).isSubset(of: barePath.union(system))   // launchd's PATH, or path_helper's alone
    var dirs: [String] = []
    for d in (bare ? installers + given : given + installers) + system where !dirs.contains(d) { dirs.append(d) }
    env["PATH"] = dirs.joined(separator: ":")
    let user = NSUserName()
    if (env["USER"] ?? "").isEmpty { env["USER"] = user }       // Claude Code finds its login by it
    if (env["LOGNAME"] ?? "").isEmpty { env["LOGNAME"] = user }
    if (env["SHELL"] ?? "").isEmpty, let pw = getpwuid(getuid()), let sh = pw.pointee.pw_shell { env["SHELL"] = String(cString: sh) }
    if ["LANG", "LC_ALL", "LC_CTYPE"].allSatisfy({ (env[$0] ?? "").isEmpty }) { env["LANG"] = utf8Locale() }
    return env
  }

  /// The person's language and region as a UTF-8 locale macOS has (en_GB.UTF-8, say), or en_US.UTF-8.
  static func utf8Locale() -> String {
    let l = Locale.current
    if let lang = l.language.languageCode?.identifier, let region = l.region?.identifier {
      let name = "\(lang)_\(region).UTF-8"
      if FileManager.default.fileExists(atPath: "/usr/share/locale/\(name)") { return name }
    }
    return "en_US.UTF-8"
  }
}

// ------------------------------------------------------------------ the Workbench process

final class Engine {
  let folder: URL?          // nil for the demo
  let port: Int             // 0: a free one
  let process = Process()
  private let input = Pipe()
  private let output = Pipe()
  private var buffer = Data()
  private var activity: NSObjectProtocol?
  private(set) var tail: [String] = []
  private(set) var ready: (url: URL, name: String)?
  var onReady: ((URL, String) -> Void)?
  var onExit: ((Int32) -> Void)?

  init(folder: URL?, port: Int, claude: String?) {
    self.folder = folder
    self.port = port
    let res = Bundle.main.resourceURL!
    process.executableURL = res.appendingPathComponent("node/bin/node")
    var args = [res.appendingPathComponent("workbench/bin/workbench.mjs").path]
    if let folder = folder {
      args += ["--repo", folder.path]
      if let claude = claude { args += ["--claude", claude] }
    } else {
      args += ["--demo"]
    }
    args += ["--app", "--port", String(port)]
    process.arguments = args
    process.environment = Environment.forWorkbench()
    process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
    process.standardInput = input
    process.standardOutput = output
    process.standardError = output
  }

  func start() throws {
    output.fileHandleForReading.readabilityHandler = { [weak self] h in
      let data = h.availableData
      DispatchQueue.main.async { self?.take(data) }
    }
    process.terminationHandler = { [weak self] p in
      DispatchQueue.main.async {
        guard let self = self else { return }
        self.output.fileHandleForReading.readabilityHandler = nil
        if let a = self.activity { ProcessInfo.processInfo.endActivity(a); self.activity = nil }
        self.onExit?(p.terminationStatus)
      }
    }
    Log.shared.write("start: \(process.arguments?.joined(separator: " ") ?? "")")
    Log.shared.write("PATH: \(process.environment?["PATH"] ?? "")")
    try process.run()
    // While Workbench runs, macOS must not slow the app, and the agents it started, when its window is hidden.
    activity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep, reason: "Workbench is running agents.")
  }

  private func take(_ data: Data) {
    guard !data.isEmpty else { return }
    buffer.append(data)
    while let nl = buffer.firstIndex(of: 0x0a) {
      let lineData = buffer[buffer.startIndex..<nl]
      buffer.removeSubrange(buffer.startIndex...nl)
      let line = String(decoding: lineData, as: UTF8.self)
      Log.shared.write(line.replacingOccurrences(of: #"t=[0-9a-f]{64}"#, with: "t=<key>", options: .regularExpression))
      if line.hasPrefix("WORKBENCH_APP "), ready == nil,
         let json = line.dropFirst("WORKBENCH_APP ".count).data(using: .utf8),
         let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
         let s = obj["url"] as? String, let url = URL(string: s) {
        let name = (obj["repo"] as? String) ?? ((obj["demo"] as? Bool) == true ? "Demo" : "Workbench")
        ready = (url, name)
        onReady?(url, name)
        continue
      }
      if !line.hasPrefix("WORKBENCH_APP ") {
        tail.append(line)
        if tail.count > 60 { tail.removeFirst(tail.count - 60) }
      }
    }
  }

  /** Stop as on Ctrl-C: close the lifeline. Workbench stops its agents and exits; past `grace`, it is made to. */
  func stop(grace: TimeInterval = 20) {
    guard process.isRunning else { return }
    try? input.fileHandleForWriting.close()
    let pid = process.processIdentifier
    DispatchQueue.main.asyncAfter(deadline: .now() + grace) { [weak self] in
      guard let self = self, self.process.isRunning, self.process.processIdentifier == pid else { return }
      Log.shared.write("Workbench did not stop in \(Int(grace)) s: sending SIGTERM")
      self.process.terminate()
      DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
        if self.process.isRunning { kill(pid, SIGKILL) }
      }
    }
  }

  /** The root agents still at work, from the page's own API (nil when it cannot be read). */
  func activeAgents(_ done: @escaping (Int?) -> Void) {
    guard let ready = ready, var parts = URLComponents(url: ready.url, resolvingAgainstBaseURL: false),
          let token = parts.queryItems?.first(where: { $0.name == "t" })?.value else { done(nil); return }
    parts.path = "/api/state"; parts.query = nil
    guard let stateURL = parts.url else { done(nil); return }
    var req = URLRequest(url: stateURL, timeoutInterval: 3)
    req.setValue(token, forHTTPHeaderField: "X-Workbench-Token")
    URLSession.shared.dataTask(with: req) { data, _, _ in
      var n: Int? = nil
      if let data = data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
         let agents = obj["agents"] as? [[String: Any]] {
        n = agents.filter { a in
          (a["parentId"] is NSNull || a["parentId"] == nil) && (a["earlier"] as? Bool) != true
            && ACTIVE_STATES.contains((a["state"] as? String) ?? "")
        }.count
      }
      DispatchQueue.main.async { done(n) }
    }.resume()
  }
}

// ------------------------------------------------------------------ the app

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
  var engine: Engine?
  var boardWindow: NSWindow?
  var webView: WKWebView?
  var welcome: NSWindow?
  var recentMenu = NSMenu(title: "Open Recent")
  var quitting = false
  var next: (() -> Void)?            // what to do once the current Workbench has stopped
  var launched = false
  var launchFolder: URL?
  var selfTest = false

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMenus()
    NSApp.activate(ignoringOtherApps: true)
    let args = CommandLine.arguments
    selfTest = args.contains("--self-test")
    launched = true
    if let i = args.firstIndex(of: "--repo"), i + 1 < args.count {
      open(folder: URL(fileURLWithPath: args[i + 1]))
    } else if args.contains("--demo") {
      open(folder: nil)
    } else if let url = launchFolder {
      open(folder: url)
    } else {
      showWelcome()
    }
  }

  // A folder dropped on the app's icon, or "Open With". At launch it comes before applicationDidFinishLaunching.
  func application(_ app: NSApplication, open urls: [URL]) {
    guard let url = urls.first(where: { (try? $0.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true }) else { return }
    if launched { open(folder: url) } else { launchFolder = url }
  }

  // MARK: choosing a folder

  @objc func chooseFolder() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.prompt = "Open"
    panel.message = "Choose the git repository your agents will work on. Each agent works in its own copy of it."
    if let last = Recents.list().first { panel.directoryURL = last.deletingLastPathComponent() }
    if panel.runModal() == .OK, let url = panel.url { open(folder: url) }
  }

  @objc func openRecent(_ sender: NSMenuItem) {
    guard let path = sender.representedObject as? String else { return }
    open(folder: URL(fileURLWithPath: path))
  }

  @objc func openDemo() { open(folder: nil) }

  @objc func clearRecents() { Recents.clear(); rebuildRecent(); if let w = welcome, w.isVisible { showWelcome() } }

  /** Open a folder (nil: the demo). If Workbench is running on another one, it is stopped first, after asking. */
  func open(folder: URL?) {
    if let engine = engine, engine.process.isRunning {
      if engine.folder?.standardizedFileURL.path == folder?.standardizedFileURL.path {
        boardWindow?.makeKeyAndOrderFront(nil)   // already open
        return
      }
      confirmStop(verb: "Opening another folder") { [weak self] ok in
        guard ok, let self = self else { return }
        self.next = { self.start(folder: folder) }
        self.engine?.stop()
      }
    } else {
      start(folder: folder)
    }
  }

  func start(folder: URL?, port: Int = 4317) {
    if let folder = folder { Recents.add(folder); rebuildRecent() }
    let e = Engine(folder: folder, port: port, claude: ChosenClaude.path)
    engine = e
    e.onReady = { [weak self] url, name in self?.showBoard(url: url, name: name) }
    e.onExit = { [weak self, weak e] status in
      guard let self = self, let e = e else { return }
      self.exited(e, status: status)
    }
    do { try e.start() } catch {
      alert("Workbench could not start.", info: error.localizedDescription)
      engine = nil
      showWelcome()
    }
  }

  func exited(_ e: Engine, status: Int32) {
    Log.shared.write("Workbench exited (\(status))")
    let wasReady = e.ready != nil
    if engine === e { engine = nil }
    if quitting { if selfTest { exit(0) }; NSApp.reply(toApplicationShouldTerminate: true); return }
    if let next = next { self.next = nil; next(); return }
    // Port 4317 taken (another Workbench): try once more on a free port.
    if !wasReady, e.port != 0, e.tail.contains(where: { $0.contains("is already in use") }) {
      start(folder: e.folder, port: 0)
      return
    }
    let said = e.tail.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.suffix(8).joined(separator: "\n")
    if selfTest { print("SELF-TEST FAILED: Workbench exited (\(status)): \(said)"); fflush(stdout); exit(1) }
    showWelcome()
    closeBoard()
    // No Claude Code (nor Codex) found: the words Workbench prints then name command-line flags, so ask here instead.
    if !wasReady, e.folder != nil, e.tail.contains(where: { $0.contains("could not find Claude Code or Codex") }) {
      if chooseClaude() { start(folder: e.folder) }
      return
    }
    if wasReady {
      alert("Workbench stopped.", info: said.isEmpty ? "It exited with code \(status)." : said)
    } else {
      alert("Workbench could not open \(e.folder?.lastPathComponent ?? "the demo").", info: said.isEmpty ? "It exited with code \(status)." : said)
    }
  }

  /** Say that Claude Code was not found, and let the person show where it is. True when they chose a program. */
  func chooseClaude() -> Bool {
    let a = NSAlert()
    a.messageText = "Workbench could not find Claude Code on this Mac."
    a.informativeText = "It looks where Claude Code's installer and Homebrew put it, and for VS Code's Claude Code extension. If Claude Code is somewhere else, show Workbench where. If it is not installed yet, install it, then open the folder again."
    a.addButton(withTitle: "Choose Claude Code…")
    a.addButton(withTitle: "Cancel")
    guard a.runModal() == .alertFirstButtonReturn else { return false }
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = false
    panel.showsHiddenFiles = true
    panel.prompt = "Use This"
    panel.message = "Choose the Claude Code program: the file named claude."
    panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser
    guard panel.runModal() == .OK, let url = panel.url else { return false }
    ChosenClaude.set(url.path)
    Log.shared.write("Claude Code chosen: \(url.path)")
    return true
  }

  /** Before stopping Workbench: if agents are still working, say so and ask. */
  func confirmStop(verb: String, then done: @escaping (Bool) -> Void) {
    guard let engine = engine, engine.ready != nil, !selfTest else { done(true); return }
    engine.activeAgents { [weak self] n in
      guard let self = self else { return }
      guard let n = n, n > 0 else { done(true); return }
      let a = NSAlert()
      a.messageText = n == 1 ? "An agent is still working." : "\(n) agents are still working."
      a.informativeText = "\(verb) stops \(n == 1 ? "it" : "them"). What they did so far stays in their folders."
      a.addButton(withTitle: n == 1 ? "Stop it" : "Stop them")
      a.addButton(withTitle: "Cancel")
      a.alertStyle = .warning
      if let w = self.boardWindow {
        a.beginSheetModal(for: w) { r in done(r == .alertFirstButtonReturn) }
      } else {
        done(a.runModal() == .alertFirstButtonReturn)
      }
    }
  }

  // MARK: the board window

  func showBoard(url: URL, name: String) {
    welcome?.close()
    welcome = nil
    if boardWindow == nil {
      let config = WKWebViewConfiguration()
      config.preferences.setValue(true, forKey: "developerExtrasEnabled")
      let wv = WKWebView(frame: .zero, configuration: config)
      wv.navigationDelegate = self
      wv.uiDelegate = self
      if #available(macOS 13.3, *) { wv.isInspectable = true }
      let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                       styleMask: [.titled, .closable, .miniaturizable, .resizable],
                       backing: .buffered, defer: false)
      w.contentView = wv
      w.minSize = NSSize(width: 960, height: 640)
      w.appearance = NSAppearance(named: .darkAqua) // a dark title bar above the dark board; the board starts below it
      w.backgroundColor = NSColor(calibratedRed: 0.06, green: 0.14, blue: 0.10, alpha: 1)
      w.isReleasedWhenClosed = false
      w.delegate = self
      w.setFrameAutosaveName("WorkbenchBoard")
      if !w.setFrameUsingName("WorkbenchBoard") { w.center() }
      boardWindow = w
      webView = wv
    }
    boardWindow?.title = "Workbench — \(name)"
    webView?.load(URLRequest(url: url))
    boardWindow?.makeKeyAndOrderFront(nil)
  }

  func closeBoard() {
    boardWindow?.delegate = nil
    boardWindow?.close()
    boardWindow = nil
    webView = nil
  }

  // Closing the board window closes the folder (as in VS Code): Workbench stops, after asking if agents work.
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    guard sender === boardWindow, let engine = engine, engine.process.isRunning else { return true }
    confirmStop(verb: "Closing the window") { [weak self] ok in
      guard ok, let self = self else { return }
      self.next = { [weak self] in self?.showWelcome(); self?.closeBoard() }
      self.engine?.stop()
    }
    return false
  }

  // WebKit's process for the page ended (it crashed, or macOS reclaimed it): load the page again.
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    Log.shared.write("the page's WebKit process ended: loading the page again")
    webView.reload()
  }

  // Only the page's own address opens here; anything else opens in the browser.
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { decisionHandler(.cancel); return }
    let local = url.host == "127.0.0.1" || url.host == "localhost"
    if local || url.scheme == "about" || url.scheme == "data" { decisionHandler(.allow); return }
    NSWorkspace.shared.open(url)
    decisionHandler(.cancel)
  }

  // Links that ask for a new window open in the browser.
  func webView(_ webView: WKWebView, createWebViewWith config: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url { NSWorkspace.shared.open(url) }
    return nil
  }

  // Holding the space bar to talk needs the microphone: only the page itself may ask for it.
  @available(macOS 12.0, *)
  func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    decisionHandler(origin.host == "127.0.0.1" || origin.host == "localhost" ? .grant : .deny)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    Log.shared.write("page loaded")
    guard selfTest else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
      let js = """
        JSON.stringify({ title: document.title, core: !!document.querySelector('#core'), dram: !!document.querySelector('#dram'),
          chips: document.querySelectorAll('#parts button').length, mode: (document.querySelector('#mode') || {}).textContent || '',
          repo: (document.querySelector('#repo') || {}).textContent || '', lid: ((document.querySelector('#pages h1') || {}).textContent || '').slice(0, 80) })
        """
      webView.evaluateJavaScript(js) { result, error in
        let text = (result as? String) ?? "error: \(error?.localizedDescription ?? "nothing")"
        Log.shared.write("self-test: \(text)")
        print("SELF-TEST \(text)")
        fflush(stdout)
        let finish = {
          self?.quitting = true
          if let e = self?.engine, e.process.isRunning { e.stop(grace: 15) } else { exit(0) }
          DispatchQueue.main.asyncAfter(deadline: .now() + 25) { exit(0) }
        }
        // `--self-test-shot <file.png>`: a picture of the page as WebKit draws it (no screen-recording permission needed)
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--self-test-shot"), i + 1 < args.count {
          webView.takeSnapshot(with: nil) { image, _ in
            if let image = image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
               let png = rep.representation(using: .png, properties: [:]) {
              try? png.write(to: URL(fileURLWithPath: args[i + 1]))
              print("SELF-TEST-SHOT \(args[i + 1])"); fflush(stdout)
            }
            finish()
          }
        } else {
          finish()
        }
      }
    }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    Log.shared.write("page failed: \(error.localizedDescription)")
  }

  // MARK: quitting

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard let engine = engine, engine.process.isRunning else { return .terminateNow }
    confirmStop(verb: "Quitting Workbench") { [weak self] ok in
      guard let self = self else { return }
      if !ok { NSApp.reply(toApplicationShouldTerminate: false); return }
      self.quitting = true
      self.engine?.stop()
    }
    return .terminateLater
  }

  // Like other Mac apps, it stays open with no window; its Dock icon brings back the board, or the welcome window.
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if let w = boardWindow { w.makeKeyAndOrderFront(nil); return false }
    if !flag { showWelcome(); return false }
    return true
  }

  // MARK: the welcome window

  func showWelcome() {
    let w = welcome ?? {
      let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 360), styleMask: [.titled, .closable],
                       backing: .buffered, defer: false)
      w.title = "Workbench"
      w.isReleasedWhenClosed = false
      w.center()
      welcome = w
      return w
    }()
    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 10
    stack.edgeInsets = NSEdgeInsets(top: 24, left: 28, bottom: 24, right: 28)
    let title = NSTextField(labelWithString: "Workbench")
    title.font = NSFont.systemFont(ofSize: 22, weight: .semibold)
    let sub = NSTextField(wrappingLabelWithString: "Open a git repository to start agents on it. Each agent works in its own copy, and you merge what you want to keep.")
    sub.textColor = .secondaryLabelColor
    let open = NSButton(title: "Open Folder…", target: self, action: #selector(chooseFolder))
    open.keyEquivalent = "\r"
    let demo = NSButton(title: "Try the Demo", target: self, action: #selector(openDemo))
    let buttons = NSStackView(views: [open, demo])
    buttons.spacing = 8
    stack.addArrangedSubview(title)
    stack.addArrangedSubview(sub)
    stack.addArrangedSubview(buttons)
    let recents = Recents.list().filter { FileManager.default.fileExists(atPath: $0.path) }
    if !recents.isEmpty {
      let label = NSTextField(labelWithString: "Recent")
      label.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
      label.textColor = .secondaryLabelColor
      stack.addArrangedSubview(label)
      for url in recents.prefix(5) {
        let b = NSButton(title: url.lastPathComponent, target: self, action: #selector(openRecentButton(_:)))
        b.isBordered = false
        b.contentTintColor = .linkColor
        b.toolTip = url.path
        b.cell?.representedObject = url.path
        stack.addArrangedSubview(b)
      }
    }
    w.contentView = stack
    w.makeKeyAndOrderFront(nil)
  }

  @objc func openRecentButton(_ sender: NSButton) {
    guard let path = sender.cell?.representedObject as? String else { return }
    open(folder: URL(fileURLWithPath: path))
  }

  // MARK: menus

  @objc func reload() { webView?.reload() }
  @objc func showLog() { NSWorkspace.shared.open(Log.shared.url) }
  @objc func showHelp() {
    let readme = Bundle.main.resourceURL!.appendingPathComponent("workbench/README.md")
    NSWorkspace.shared.open(readme)
  }

  func rebuildRecent() {
    recentMenu.removeAllItems()
    for url in Recents.list() {
      let item = NSMenuItem(title: url.lastPathComponent, action: #selector(openRecent(_:)), keyEquivalent: "")
      item.representedObject = url.path
      item.toolTip = url.path
      item.target = self
      recentMenu.addItem(item)
    }
    if !Recents.list().isEmpty { recentMenu.addItem(.separator()) }
    let clear = NSMenuItem(title: "Clear Menu", action: #selector(clearRecents), keyEquivalent: "")
    clear.target = self
    recentMenu.addItem(clear)
  }

  func buildMenus() {
    let main = NSMenu()
    func add(_ menu: NSMenu, _ title: String, _ action: Selector?, _ key: String = "", mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) {
      let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
      item.keyEquivalentModifierMask = mods
      if let target = target { item.target = target }
      menu.addItem(item)
    }
    let appMenu = NSMenu()
    add(appMenu, "About Workbench", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), "", mods: [])
    appMenu.addItem(.separator())
    add(appMenu, "Hide Workbench", #selector(NSApplication.hide(_:)), "h")
    add(appMenu, "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", mods: [.command, .option])
    add(appMenu, "Show All", #selector(NSApplication.unhideAllApplications(_:)), "", mods: [])
    appMenu.addItem(.separator())
    add(appMenu, "Quit Workbench", #selector(NSApplication.terminate(_:)), "q")
    let fileMenu = NSMenu(title: "File")
    add(fileMenu, "Open Folder…", #selector(chooseFolder), "o", target: self)
    let recentItem = NSMenuItem(title: "Open Recent", action: nil, keyEquivalent: "")
    recentItem.submenu = recentMenu
    fileMenu.addItem(recentItem)
    add(fileMenu, "Try the Demo", #selector(openDemo), "", mods: [], target: self)
    fileMenu.addItem(.separator())
    add(fileMenu, "Close Window", #selector(NSWindow.performClose(_:)), "w")
    let editMenu = NSMenu(title: "Edit")
    add(editMenu, "Undo", Selector(("undo:")), "z")
    add(editMenu, "Redo", Selector(("redo:")), "z", mods: [.command, .shift])
    editMenu.addItem(.separator())
    add(editMenu, "Cut", #selector(NSText.cut(_:)), "x")
    add(editMenu, "Copy", #selector(NSText.copy(_:)), "c")
    add(editMenu, "Paste", #selector(NSText.paste(_:)), "v")
    add(editMenu, "Select All", #selector(NSText.selectAll(_:)), "a")
    let viewMenu = NSMenu(title: "View")
    add(viewMenu, "Reload Page", #selector(reload), "r", target: self)
    add(viewMenu, "Show Log", #selector(showLog), "", mods: [], target: self)
    viewMenu.addItem(.separator())
    add(viewMenu, "Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", mods: [.command, .control])
    let windowMenu = NSMenu(title: "Window")
    add(windowMenu, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
    add(windowMenu, "Zoom", #selector(NSWindow.performZoom(_:)), "", mods: [])
    windowMenu.addItem(.separator())
    add(windowMenu, "Bring All to Front", #selector(NSApplication.arrangeInFront(_:)), "", mods: [])
    let helpMenu = NSMenu(title: "Help")
    add(helpMenu, "Workbench Help", #selector(showHelp), "?", target: self)
    for (title, menu) in [("Workbench", appMenu), ("File", fileMenu), ("Edit", editMenu), ("View", viewMenu), ("Window", windowMenu), ("Help", helpMenu)] {
      let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      item.submenu = menu
      main.addItem(item)
    }
    NSApp.mainMenu = main
    NSApp.windowsMenu = windowMenu
    NSApp.helpMenu = helpMenu
    rebuildRecent()
  }

  func alert(_ message: String, info: String) {
    Log.shared.write("alert: \(message) \(info)")
    guard !selfTest else { return }
    let a = NSAlert()
    a.messageText = message
    a.informativeText = info
    a.runModal()
  }
}

// ------------------------------------------------------------------ start

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
