// Workbench for macOS: a native window around the Workbench board.
//
// The app bundles Node (with npm) and Workbench. It asks which git repository to work on (or reopens a recent one, or
// clones one), starts `node workbench/bin/workbench.mjs --repo <folder> --app` (for a clone, `--clone <address> --into
// <folder> --app`, which clones first and then runs on the new folder), and shows the board in its own window. Its pipe
// to Workbench's standard input is a lifeline: when the app quits, or crashes, the pipe closes and Workbench stops its
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
    // appended to, line by line, so two copies of the app never write over each other's lines
    let fd = Darwin.open(url.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
    handle = fd >= 0 ? FileHandle(fileDescriptor: fd, closeOnDealloc: true) : nil
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

/// The Claude Code program the person chose in an earlier version of the app, when Workbench could not find one. It is
/// still given with --claude while that file is there. A missing agent is now set up in the page, in Agents & keys.
enum ChosenClaude {
  static let key = "claudePath"
  static var path: String? {
    guard let p = UserDefaults.standard.string(forKey: key), FileManager.default.isExecutableFile(atPath: p) else { return nil }
    return p
  }
}

/// The folder cloned repositories go in: ~/Developer (made the first time it is used), or the one the person chose last.
enum CloneFolder {
  static let key = "cloneFolder"
  static var standard: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Developer", isDirectory: true) }
  static var url: URL {
    guard let p = UserDefaults.standard.string(forKey: key), p.hasPrefix("/") else { return standard }
    return URL(fileURLWithPath: p, isDirectory: true)
  }
  static func set(_ url: URL) { UserDefaults.standard.set(url.path, forKey: key) }
}

// ------------------------------------------------------------------ words from Workbench, git and GitHub

/// Text from Workbench, git or GitHub as the app shows it: control, bidirectional and zero-width characters become
/// visible symbols (⏎, ⇥, ␛, "⟦U+202E⟧"), as on the page, so no name can hide text or change the order it reads in.
func visible(_ s: String) -> String {
  var out = String.UnicodeScalarView()
  for u in s.unicodeScalars {
    let p = u.properties
    guard p.generalCategory == .control || p.isDefaultIgnorableCodePoint || p.isBidiControl || u.value == 0x2028 || u.value == 0x2029 else {
      out.append(u)
      continue
    }
    let picture: String
    switch u.value {
    case 0x0A: picture = "⏎"
    case 0x09: picture = "⇥"
    case 0x0D: picture = "␍"
    case 0x7F: picture = "␡"
    case 0..<0x20: picture = String(Character(Unicode.Scalar(0x2400 + u.value)!))
    default: picture = "⟦U+\(String(format: "%04X", u.value))⟧"
    }
    out.append(contentsOf: picture.unicodeScalars)
  }
  return String(out)
}

/// The JSON after `NAME ` on a line Workbench printed for the app (`WORKBENCH_APP {…}`, `WORKBENCH_CLONE {…}`,
/// `WORKBENCH_GITHUB {…}`, `WORKBENCH_GITHUB_REPOS […]`), or nil.
func payload(_ line: String, _ name: String) -> Any? {
  let prefix = name + " "
  guard line.hasPrefix(prefix) else { return nil }
  return try? JSONSerialization.jsonObject(with: Data(line.dropFirst(prefix.count).utf8))
}

/// Addresses for the clone sheet. Workbench itself checks every address it is given (`--clone`); the app only keeps out
/// of Workbench's command line, which other programs on the Mac can read, and out of the log, what must never be there:
/// a name and password, or text that is no address at all (a key pasted in the wrong field, say).
enum CloneAddress {
  static let shape = "Workbench clones addresses like https://github.com/owner/repo or git@github.com:owner/repo.git."
  static let credentials = "Leave your name and password out of the address. If the repository is private, connect your GitHub account instead."

  /// Why this address is not even tried, in words, or nil.
  static func problem(_ a: String) -> String? {
    if a.hasPrefix("-") || a.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) }) {
      return shape
    }
    if let r = a.range(of: "://") {
      let scheme = a[..<r.lowerBound].lowercased()
      guard !scheme.isEmpty, scheme.allSatisfy({ $0.isLetter || $0.isNumber || "+.-".contains($0) }) else { return shape }
      let authority = a[r.upperBound...].prefix { $0 != "/" }
      if let at = authority.lastIndex(of: "@") {
        let user = authority[..<at]
        if scheme == "http" || scheme == "https" || user.contains(":") { return credentials }
      }
      return nil
    }
    // like scp: user@host:path
    if let at = a.firstIndex(of: "@"), let colon = a[at...].firstIndex(of: ":") {
      let user = a[..<at]
      let host = a[a.index(after: at)..<colon]
      if user.contains(":") { return credentials }
      if !user.isEmpty, !host.isEmpty, !user.contains("/"), !host.contains("/") { return nil }
    }
    return shape
  }

  /// The folder Workbench makes for an address: its last path part without ".git".
  static func folderName(_ a: String) -> String? {
    var s = Substring(a)
    while s.hasSuffix("/") { s = s.dropLast() }
    var last = s.split(whereSeparator: { $0 == "/" || $0 == ":" }).last.map(String.init) ?? ""
    if last.hasSuffix(".git") { last.removeLast(4) }
    return last.isEmpty || last == "." || last == ".." ? nil : last
  }

  static func folder(_ a: String, in into: URL) -> URL? {
    folderName(a).map { into.appendingPathComponent($0, isDirectory: true) }
  }

  /// How the sheet names the repository: "owner/repo" when the address has both, else the folder's name.
  static func shortName(_ a: String) -> String {
    var s = Substring(a)
    while s.hasSuffix("/") { s = s.dropLast() }
    var path = Substring("")
    if let r = s.range(of: "://") {
      let rest = s[r.upperBound...]
      if let slash = rest.firstIndex(of: "/") { path = rest[rest.index(after: slash)...] }
    } else if let colon = s.firstIndex(of: ":") {
      path = s[s.index(after: colon)...]
    }
    var parts = path.split(separator: "/").map(String.init)
    if let last = parts.last, last.hasSuffix(".git") { parts[parts.count - 1] = String(last.dropLast(4)) }
    parts = parts.filter { !$0.isEmpty }
    if parts.count >= 2 { return parts.suffix(2).joined(separator: "/") }
    return parts.last ?? folderName(a) ?? a
  }

  /// The server an address names ("github.com"), or nil.
  static func host(_ a: String) -> String? {
    if let r = a.range(of: "://") {
      var authority = a[r.upperBound...].prefix { $0 != "/" }
      if let at = authority.lastIndex(of: "@") { authority = authority[authority.index(after: at)...] }
      let h = authority.prefix { $0 != ":" }
      return h.isEmpty ? nil : String(h)
    }
    if let at = a.firstIndex(of: "@"), let colon = a[at...].firstIndex(of: ":") {
      let h = a[a.index(after: at)..<colon]
      return h.isEmpty ? nil : String(h)
    }
    return nil
  }

  /**
   * A github.com address over ssh (`git@github.com:owner/repo.git`, `ssh://git@github.com/owner/repo.git`) in its https
   * form (`https://github.com/owner/repo.git`), which a GitHub token can read; nil for any other address. Connect
   * GitHub… gives git a token for https only, so a clone tried again after it goes over https.
   */
  static func githubHTTPS(_ a: String) -> String? {
    var path: Substring
    if let r = a.range(of: "://") {
      guard a[..<r.lowerBound].lowercased() == "ssh" else { return nil }
      let rest = a[r.upperBound...]
      guard let slash = rest.firstIndex(of: "/") else { return nil }
      var authority = rest[..<slash]
      if let at = authority.lastIndex(of: "@") { authority = authority[authority.index(after: at)...] }
      guard authority.lowercased() == "github.com" || authority.lowercased() == "github.com:22" else { return nil }
      path = rest[rest.index(after: slash)...]
    } else {
      guard let colon = a.firstIndex(of: ":") else { return nil }
      var host = a[..<colon]
      if let at = host.lastIndex(of: "@") { host = host[host.index(after: at)...] }
      guard host.lowercased() == "github.com" else { return nil }
      path = a[a.index(after: colon)...]
    }
    while path.hasPrefix("/") { path = path.dropFirst() }
    return path.isEmpty ? nil : "https://github.com/" + path
  }

  /// What the sheet says when a clone was refused and Workbench's own line gave no sentence.
  static func refusal(_ kind: String, address: String, into: URL) -> String {
    switch kind {
    case "auth": return "GitHub did not let Workbench read this repository. If it is private, connect your GitHub account, then try again."
    case "ssh":
      let h = host(address)
      if h?.lowercased() == "github.com" {
        return "GitHub did not accept this Mac’s SSH key. Use the https:// address instead; for a private repository, connect your GitHub account first."
      }
      return "\(h ?? "The server") did not accept this Mac’s SSH key. Use the https:// address instead; for a private repository, make sure git can sign in to \(h ?? "it") first."
    case "network": return "Workbench could not reach \(host(address) ?? "the repository’s server")."
    case "exists": return "\(into.lastPathComponent) already has a folder named \(folderName(address) ?? shortName(address)), and it is not empty."
    case "url": return shape
    default: return "Git could not clone \(shortName(address))."
    }
  }
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

/// What a Workbench process runs on.
enum Target {
  case demo
  case repo(URL)
  /// Clone this address into this folder, then run on the new repository: one process, which becomes the board.
  case clone(address: String, into: URL)
}

/// A step of a clone, from Workbench's `WORKBENCH_CLONE` lines.
enum CloneStep {
  case progress(phase: String, percent: Double?)
  /// The clone is done (`WORKBENCH_CLONE {"phase":"done",…}`): Workbench is starting on the new folder. Nothing else
  /// means done: a refusal can come after progress, and the sheet must not say "Opening…" for it.
  case opening
}

final class Engine {
  let target: Target
  let port: Int             // 0: a free one
  let process = Process()
  private let input = Pipe()
  private let output = Pipe()
  private var buffer = Data()
  private var activity: NSObjectProtocol?
  private(set) var tail: [String] = []
  private(set) var ready: (url: URL, name: String)?
  /// The repository's folder: the one given, or, for a clone, the one Workbench made (the `root` it reports).
  private(set) var root: URL?
  /// Why a clone was refused, from Workbench's `WORKBENCH_CLONE {"error",…}` line: auth, ssh, network, exists, url or
  /// git.
  private(set) var cloneFailure: (kind: String, sentence: String?)?
  /// Started for the clone sheet: the clone itself, or its new folder opened on a free port.
  var forClone = false
  /// Stopped because the person cancelled the clone: its end needs no words.
  var cancelled = false
  private var exitStatus: Int32?
  private var outputEnded = false
  private var reported = false
  var onReady: ((URL, String) -> Void)?
  var onClone: ((CloneStep) -> Void)?
  var onExit: ((Int32) -> Void)?

  var folder: URL? { root }
  var isDemo: Bool { if case .demo = target { return true }; return false }
  var isClone: Bool { if case .clone = target { return true }; return false }

  init(target: Target, port: Int, claude: String?) {
    self.target = target
    self.port = port
    let res = Bundle.main.resourceURL!
    process.executableURL = res.appendingPathComponent("node/bin/node")
    var args = [res.appendingPathComponent("workbench/bin/workbench.mjs").path]
    switch target {
    case .demo:
      args += ["--demo"]
    case .repo(let folder):
      root = folder
      args += ["--repo", folder.path]
    case .clone(let address, let into):
      args += ["--clone", address, "--into", into.path]
    }
    if !isDemo, let claude = claude { args += ["--claude", claude] }
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
      if data.isEmpty { h.readabilityHandler = nil }   // the end: Workbench closed its output
      DispatchQueue.main.async { self?.take(data) }
    }
    process.terminationHandler = { [weak self] p in
      let status = p.terminationStatus
      DispatchQueue.main.async {
        guard let self = self else { return }
        if let a = self.activity { ProcessInfo.processInfo.endActivity(a); self.activity = nil }
        self.exitStatus = status
        self.reportExit(force: false)
        // What Workbench printed last (why a clone was refused, say) may still be on its way: wait a second for it.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.reportExit(force: true) }
      }
    }
    Log.shared.write("start: \(process.arguments?.joined(separator: " ") ?? "")")
    Log.shared.write("PATH: \(process.environment?["PATH"] ?? "")")
    try process.run()
    // While Workbench runs, macOS must not slow the app, and the agents it started, when its window is hidden.
    activity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep, reason: "Workbench is running agents.")
  }

  /** Once Workbench has exited and all it printed has been read (or a second after it exited). */
  private func reportExit(force: Bool) {
    guard !reported, let status = exitStatus, outputEnded || force else { return }
    reported = true
    output.fileHandleForReading.readabilityHandler = nil
    onExit?(status)
  }

  private func take(_ data: Data) {
    guard !data.isEmpty else {
      if !outputEnded {
        outputEnded = true
        if !buffer.isEmpty { take(line: String(decoding: buffer, as: UTF8.self)); buffer.removeAll() }
      }
      reportExit(force: false)
      return
    }
    buffer.append(data)
    while let nl = buffer.firstIndex(of: 0x0a) {
      let lineData = buffer[buffer.startIndex..<nl]
      buffer.removeSubrange(buffer.startIndex...nl)
      take(line: String(decoding: lineData, as: UTF8.self))
    }
  }

  private func take(line: String) {
    // A clone's progress and its refusal: shown in the clone sheet. Progress is not written to the log. Only phase
    // "done" (or the page's own line, below) says the clone is done: any other line, a refusal's sentence included, can
    // come after the progress.
    if let obj = payload(line, "WORKBENCH_CLONE") as? [String: Any] {
      if let r = obj["root"] as? String, r.hasPrefix("/") { root = URL(fileURLWithPath: r, isDirectory: true) }
      if let kind = obj["error"] as? String {
        cloneFailure = (kind, obj["sentence"] as? String)
        Log.shared.write(line)
      } else if let phase = obj["phase"] as? String {
        onClone?(phase == "done" ? .opening : .progress(phase: phase, percent: (obj["percent"] as? NSNumber)?.doubleValue))
      }
      return
    }
    Log.shared.write(line.replacingOccurrences(of: #"t=[0-9a-f]{64}"#, with: "t=<key>", options: .regularExpression))
    if line.hasPrefix("WORKBENCH_APP ") {
      if ready == nil, let obj = payload(line, "WORKBENCH_APP") as? [String: Any],
         let s = obj["url"] as? String, let url = URL(string: s), Engine.isPage(url) {
        if let r = obj["root"] as? String, r.hasPrefix("/") { root = URL(fileURLWithPath: r, isDirectory: true) }
        let name = (obj["repo"] as? String) ?? ((obj["demo"] as? Bool) == true ? "Demo" : "Workbench")
        ready = (url, name)
        onReady?(url, name)
      }
      return
    }
    tail.append(line)
    if tail.count > 60 { tail.removeFirst(tail.count - 60) }
  }

  /// Whether an address can be Workbench's own page: http on this Mac (127.0.0.1, or localhost), on any port. A
  /// `WORKBENCH_APP` line with any other address is not Workbench's, and is ignored.
  static func isPage(_ url: URL) -> Bool {
    guard url.scheme?.lowercased() == "http", let host = url.host?.lowercased() else { return false }
    return host == "127.0.0.1" || host == "localhost"
  }

  /**
   * Stop as on Ctrl-C: close the lifeline. Workbench stops its agents and exits; past `grace`, it is made to. Before
   * its page is up it has started no agent, and while it clones it does not read the lifeline yet: it is stopped at once.
   */
  func stop(grace: TimeInterval = 20) {
    guard process.isRunning else { return }
    try? input.fileHandleForWriting.close()
    let pid = process.processIdentifier
    let wait = ready == nil ? 0 : grace
    DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
      guard let self = self, self.process.isRunning, self.process.processIdentifier == pid else { return }
      Log.shared.write(wait == 0 ? "Workbench was not ready yet: sending SIGTERM" : "Workbench did not stop in \(Int(grace)) s: sending SIGTERM")
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

// ------------------------------------------------------------------ short runs of Workbench, for the clone sheet

/// How a short run of Workbench ended.
enum HelperResult {
  case done(lines: [String], status: Int32)
  case timedOut
  case failed
}

/// Calls `done` once, on the main thread: when the run ends, or when it took too long, whichever is first.
final class HelperRun {
  private(set) var finished = false
  private let done: (HelperResult) -> Void
  init(_ done: @escaping (HelperResult) -> Void) { self.done = done }
  func finish(_ r: HelperResult) {
    if finished { return }
    finished = true
    done(r)
  }
}

/**
 * Runs the bundled Workbench once, with the environment the board's own process gets: `--github-repos`, or
 * `--connect-github` with the token on its standard input (never in its arguments, which other programs on the Mac can
 * read, nor in its environment). What it prints is read whole and not written to the log, since it names the person's
 * private repositories. Past `limit` seconds it is stopped.
 */
enum Helper {
  static func run(_ args: [String], input: Data? = nil, limit: TimeInterval, done: @escaping (HelperResult) -> Void) {
    let what = args.first ?? "Workbench"
    let res = Bundle.main.resourceURL!
    let p = Process()
    p.executableURL = res.appendingPathComponent("node/bin/node")
    p.arguments = [res.appendingPathComponent("workbench/bin/workbench.mjs").path] + args
    p.environment = Environment.forWorkbench()
    p.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
    let out = Pipe()
    let stdin = Pipe()
    p.standardOutput = out
    p.standardError = out
    p.standardInput = stdin
    let run = HelperRun(done)
    do { try p.run() } catch {
      Log.shared.write("\(what): could not start: \(error.localizedDescription)")
      DispatchQueue.main.async { run.finish(.failed) }
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + limit) {
      guard !run.finished else { return }
      Log.shared.write("\(what): no answer in \(Int(limit)) s, stopped")
      if p.isRunning {
        p.terminate()
        let pid = p.processIdentifier
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { if p.isRunning { kill(pid, SIGKILL) } }
      }
      run.finish(.timedOut)
    }
    DispatchQueue.global(qos: .userInitiated).async {
      // SIGPIPE is ignored (see the start), so a Workbench that ended before reading only makes this write fail.
      if let input = input { try? stdin.fileHandleForWriting.write(contentsOf: input) }
      try? stdin.fileHandleForWriting.close()
      let data = out.fileHandleForReading.readDataToEndOfFile()
      p.waitUntilExit()
      let status = p.terminationStatus
      let lines = String(decoding: data, as: UTF8.self).split(separator: "\n")
        .map { $0.hasSuffix("\r") ? String($0.dropLast()) : String($0) }
      DispatchQueue.main.async {
        Log.shared.write("\(what): exited (\(status))")
        run.finish(.done(lines: lines, status: status))
      }
    }
  }
}

// ------------------------------------------------------------------ the app

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
  var engine: Engine?
  var boardWindow: NSWindow?
  var webView: WKWebView?
  var welcome: NSWindow?
  var cloneSheet: CloneSheet?
  var recentMenu = NSMenu(title: "Open Recent")
  var quitting = false
  var next: (() -> Void)?            // what to do once the current Workbench has stopped
  var launched = false
  var launchFolder: URL?
  var selfTest = false
  var selfTestStarted = false
  var selfTestCode: Int32 = 0

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMenus()
    NSApp.activate(ignoringOtherApps: true)
    let args = CommandLine.arguments
    selfTest = args.contains("--self-test")
    if selfTest {
      DispatchQueue.main.asyncAfter(deadline: .now() + 90) {
        print("SELF-TEST FAILED: the page did not load in 90 seconds."); fflush(stdout); exit(1)
      }
    }
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
    if cloneSheet != nil { cancelClone() }   // a folder dropped on the icon while the clone sheet was up
    if let engine = engine, engine.process.isRunning {
      let same = folder.map { engine.folder?.standardizedFileURL.path == $0.standardizedFileURL.path } ?? engine.isDemo
      if same {
        boardWindow?.makeKeyAndOrderFront(nil)   // already open
        return
      }
      confirmStop(verb: "Opening another folder") { [weak self] ok in
        guard ok, let self = self else { return }
        self.next = { self.start(folder.map { .repo($0) } ?? .demo) }
        self.engine?.stop()
      }
    } else {
      start(folder.map { .repo($0) } ?? .demo)
    }
  }

  func start(_ target: Target, port: Int = 4317, forClone: Bool = false) {
    if case .repo(let folder) = target { Recents.add(folder); rebuildRecent() }
    let e = Engine(target: target, port: port, claude: ChosenClaude.path)
    e.forClone = forClone || e.isClone
    engine = e
    e.onReady = { [weak self, weak e] url, name in
      guard let self = self else { return }
      if let e = e, case .clone(let address, let into) = e.target, let root = e.root ?? CloneAddress.folder(address, in: into) {
        Recents.add(root)
        self.rebuildRecent()
      }
      self.showBoard(url: url, name: name)
    }
    e.onClone = { [weak self] step in self?.cloneSheet?.show(step) }
    e.onExit = { [weak self, weak e] status in
      guard let self = self, let e = e else { return }
      self.exited(e, status: status)
    }
    do { try e.start() } catch {
      engine = nil
      if e.forClone, let s = cloneSheet {
        s.failed(kind: "start", sentence: "Workbench could not start.")
        return
      }
      alert("Workbench could not start.", info: error.localizedDescription)
      showWelcome()
    }
  }

  func exited(_ e: Engine, status: Int32) {
    Log.shared.write("Workbench exited (\(status))")
    let wasReady = e.ready != nil
    if engine === e { engine = nil }
    if quitting { if selfTest { exit(selfTestCode) }; NSApp.reply(toApplicationShouldTerminate: true); return }
    if let next = next { self.next = nil; next(); return }
    if e.cancelled {
      // The person cancelled the clone: if the folder that was open closed for it, nothing is open now.
      if engine == nil, cloneSheet == nil, boardWindow != nil { showWelcome(); closeBoard() }
      return
    }
    if !wasReady, case .clone(let address, let into) = e.target {
      cloneEnded(e, address: address, into: into)
      return
    }
    // Port 4317 taken (another Workbench): try once more on a free port.
    if !wasReady, e.port != 0, e.tail.contains(where: { $0.contains("is already in use") }) {
      start(e.target, port: 0, forClone: e.forClone)
      return
    }
    let said = e.tail.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.suffix(8).joined(separator: "\n")
    if selfTest { print("SELF-TEST FAILED: Workbench exited (\(status)): \(said)"); fflush(stdout); exit(1) }
    if let s = cloneSheet { cloneSheet = nil; s.end() }
    showWelcome()
    closeBoard()
    if wasReady {
      alert("Workbench stopped.", info: said.isEmpty ? "It exited with code \(status)." : said)
    } else {
      alert("Workbench could not open \(e.folder?.lastPathComponent ?? "the demo").", info: said.isEmpty ? "It exited with code \(status)." : said)
    }
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
      // On the clone sheet when it is up, and on top of any sheet: a sheet under another one waits for it to go.
      if var w = self.cloneSheet?.window ?? self.boardWindow {
        while let sheet = w.attachedSheet { w = sheet }
        a.beginSheetModal(for: w) { r in done(r == .alertFirstButtonReturn) }
      } else {
        done(a.runModal() == .alertFirstButtonReturn)
      }
    }
  }

  // MARK: cloning a repository

  /** Clone Repository…: the clone sheet, over the window in front (the board, or the first window). */
  @objc func showClone() {
    if let s = cloneSheet { s.host?.makeKeyAndOrderFront(nil); return }
    let host: NSWindow
    if let k = NSApp.keyWindow, k === welcome || k === boardWindow {
      host = k
    } else if let b = boardWindow {
      if b.isMiniaturized { b.deminiaturize(nil) }
      b.makeKeyAndOrderFront(nil)
      host = b
    } else {
      host = showWelcome()
    }
    let s = CloneSheet(app: self)
    cloneSheet = s
    s.present(on: host)
  }

  /** The sheet's Clone: what is open closes first (after asking, when agents work); then the clone runs as the board. */
  func beginClone(address: String, into: URL) {
    guard let s = cloneSheet else { return }
    guard let e = engine, e.process.isRunning else { start(.clone(address: address, into: into)); return }
    s.waiting("Closing \(visible(e.isDemo ? "the demo" : (e.folder?.lastPathComponent ?? "Workbench")))…")
    confirmStop(verb: "Cloning a repository") { [weak self] ok in
      guard let self = self, let s = self.cloneSheet else { return }
      guard ok else { s.idle(); return }
      guard let e = self.engine, e.process.isRunning else { self.start(.clone(address: address, into: into)); return }
      self.next = { [weak self] in self?.start(.clone(address: address, into: into)) }
      e.stop()
    }
  }

  /** The sheet's Cancel (or the sheet giving way to a folder dropped on the icon): a clone under way stops at once. */
  func cancelClone() {
    guard let s = cloneSheet else { return }
    cloneSheet = nil
    s.end()
    if let e = engine, e.forClone, e.ready == nil, e.process.isRunning {
      e.cancelled = true
      e.stop()
    } else if next != nil {
      // the folder that was open is still closing for the clone: once it has, nothing is open
      next = { [weak self] in self?.showWelcome(); self?.closeBoard() }
    } else if engine == nil, boardWindow != nil {
      // it closed for a clone that was refused: nothing is open
      showWelcome()
      closeBoard()
    }
  }

  /** A clone run that ended before its page was up: refused, or cloned but not opened. */
  func cloneEnded(_ e: Engine, address: String, into: URL) {
    let name = CloneAddress.shortName(address)
    let made = e.root ?? CloneAddress.folder(address, in: into)
    let cloned = e.cloneFailure == nil && made.map { FileManager.default.fileExists(atPath: $0.appendingPathComponent(".git").path) } == true
    // Port 4317 taken (another Workbench): the clone is done, so its folder is opened on a free port.
    if cloned, let root = made, e.port != 0, e.tail.contains(where: { $0.contains("is already in use") }) {
      start(.repo(root), port: 0, forClone: true)
      return
    }
    if cloned, let root = made { Recents.add(root); rebuildRecent() }
    let sentence: String
    if let f = e.cloneFailure {
      sentence = f.sentence.flatMap { $0.isEmpty ? nil : $0 } ?? CloneAddress.refusal(f.kind, address: address, into: into)
    } else if cloned {
      sentence = "Workbench cloned \(name), but could not open it. View → Show Log says why."
    } else {
      sentence = "Workbench could not clone \(name). View → Show Log says why."
    }
    if let s = cloneSheet {
      s.failed(kind: e.cloneFailure?.kind ?? "start", sentence: sentence)
      return
    }
    if engine == nil, boardWindow != nil { showWelcome(); closeBoard() }
    alert(visible(sentence), info: "")
  }

  // While the clone sheet is up, it is the way to open something: finish it, or cancel it, first.
  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    if cloneSheet != nil, let action = item.action,
       [#selector(chooseFolder), #selector(openDemo), #selector(openRecent(_:))].contains(action) { return false }
    return true
  }

  // MARK: the board window

  func showBoard(url: URL, name: String) {
    if let s = cloneSheet { cloneSheet = nil; s.end() }
    welcome?.close()
    welcome = nil
    if boardWindow == nil {
      let config = WKWebViewConfiguration()
      config.preferences.setValue(true, forKey: "developerExtrasEnabled")
      let wv = WKWebView(frame: .zero, configuration: config)
      wv.navigationDelegate = self
      wv.uiDelegate = self
      wv.isInspectable = true
      let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                       styleMask: [.titled, .closable, .miniaturizable, .resizable],
                       backing: .buffered, defer: false)
      w.contentView = wv
      w.minSize = NSSize(width: 960, height: 640)
      w.appearance = NSAppearance(named: .darkAqua) // a dark title bar above the dark board; the board starts below it
      w.backgroundColor = NSColor(calibratedRed: 0.06, green: 0.14, blue: 0.10, alpha: 1)
      w.isReleasedWhenClosed = false
      w.delegate = self
      if selfTest {
        w.center()   // a check: not where the person keeps their board, and its place is not saved
      } else {
        w.setFrameAutosaveName("WorkbenchBoard")
        if !w.setFrameUsingName("WorkbenchBoard") { w.center() }
      }
      boardWindow = w
      webView = wv
    }
    boardWindow?.title = selfTest ? "Workbench self-test — \(name)" : "Workbench — \(name)"
    webView?.load(URLRequest(url: url))
    boardWindow?.makeKeyAndOrderFront(nil)
  }

  func closeBoard() {
    if let s = cloneSheet, s.host === boardWindow { cloneSheet = nil; s.end() }
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
    guard selfTest, !selfTestStarted else { return }
    selfTestStarted = true
    // A page that cannot be seen does not draw: its animation frames do not run. Started from a terminal while the
    // person works in another app, the window opens behind theirs, so it comes in front of them (without taking the
    // keyboard) before the page is read.
    webView.evaluateJavaScript("document.hidden") { [weak self] hidden, _ in
      guard let self = self else { return }
      Log.shared.write("self-test: the page was \((hidden as? Bool) == true ? "hidden behind other windows" : "in view") when it loaded")
      self.boardWindow?.orderFrontRegardless()
      self.selfTestLook(webView, tries: 0)
    }
  }

  /** What the page shows, read every half second until its lid has words, for 15 seconds at most. */
  func selfTestLook(_ webView: WKWebView, tries: Int) {
    let js = """
      (() => { const lid = ((document.querySelector('#pages h1') || {}).textContent || '').slice(0, 80);
        return JSON.stringify({ title: document.title, hidden: document.hidden, drawn: !!lid, core: !!document.querySelector('#core'),
          dram: !!document.querySelector('#dram'), chips: document.querySelectorAll('#parts button').length,
          mode: (document.querySelector('#mode') || {}).textContent || '', repo: (document.querySelector('#repo') || {}).textContent || '',
          lid }); })()
      """
    webView.evaluateJavaScript(js) { [weak self] result, error in
      guard let self = self else { return }
      let text = (result as? String) ?? "error: \(error?.localizedDescription ?? "nothing")"
      let drawn = text.contains("\"drawn\":true")
      if !drawn && tries < 30 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.selfTestLook(webView, tries: tries + 1) }
        return
      }
      self.selfTestCode = drawn ? 0 : 1
      Log.shared.write("self-test: \(text)")
      print("SELF-TEST \(text)")
      if !drawn { print("SELF-TEST FAILED: the page did not draw in 15 seconds.") }
      fflush(stdout)
      let finish = {
        self.quitting = true
        if let e = self.engine, e.process.isRunning { e.stop(grace: 15) } else { exit(self.selfTestCode) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 25) { exit(self.selfTestCode) }
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

  @discardableResult
  func showWelcome() -> NSWindow {
    let w = welcome ?? {
      let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 360), styleMask: [.titled, .closable],
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
    let sub = NSTextField(wrappingLabelWithString: "Clone a git repository, or open one, to start agents on it. Each agent works in its own copy, and you merge what you want to keep.")
    sub.textColor = .secondaryLabelColor
    let clone = NSButton(title: "Clone Repository…", target: self, action: #selector(showClone))
    let open = NSButton(title: "Open Folder…", target: self, action: #selector(chooseFolder))
    open.keyEquivalent = "\r"
    let demo = NSButton(title: "Try the Demo", target: self, action: #selector(openDemo))
    let buttons = NSStackView(views: [clone, open, demo])
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
    return w
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
    add(fileMenu, "Clone Repository…", #selector(showClone), "o", mods: [.command, .shift], target: self)
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

// ------------------------------------------------------------------ the clone sheet

/// One of the person's repositories on GitHub, from `--github-repos`.
struct GitHubRepo {
  let fullName: String
  let cloneUrl: String
  let isPrivate: Bool
}

/**
 * Clone Repository…: an address, or one of the person's repositories on GitHub; the folder it goes in; then progress
 * while git works. The clone runs in the board's own Workbench process (`--clone … --into … --app`), so once it is done
 * that process is the board, and the sheet goes. A refused clone says why here, with "Connect GitHub…" when GitHub did
 * not let Workbench read the repository (`auth`); not when it did not accept this Mac's SSH key (`ssh`), which a
 * token does not mend.
 */
final class CloneSheet: NSObject, NSSearchFieldDelegate, NSTableViewDataSource, NSTableViewDelegate {
  weak var app: AppDelegate?
  private(set) weak var host: NSWindow?
  let window: NSWindow
  private let address = NSTextField()
  private let filter = NSSearchField()
  private let table = NSTableView()
  private let tableScroll = NSScrollView()
  private let note = NSStackView()              // in the list's place while it loads, or when there is none
  private let noteSpinner = NSProgressIndicator()
  private let noteText = NSTextField(wrappingLabelWithString: "")
  private let noteConnect = NSButton(title: "Connect GitHub…", target: nil, action: nil)
  private let folderText = NSTextField(labelWithString: "")
  private let chooseButton = NSButton(title: "Choose…", target: nil, action: nil)
  private let message = NSTextField(wrappingLabelWithString: "")
  private let messageConnect = NSButton(title: "Connect GitHub…", target: nil, action: nil)
  private let bar = NSProgressIndicator()
  private let cancelButton = NSButton(title: "Cancel", target: nil, action: nil)
  private let cloneButton = NSButton(title: "Clone", target: nil, action: nil)
  private var repos: [GitHubRepo] = []
  private var shown: [GitHubRepo] = []
  private var folder = CloneFolder.url
  private var name = ""                 // the repository being cloned, as the sheet names it
  private var busy = false              // closing what is open, or cloning
  private var lastFailure: String?      // auth, ssh, network, exists, url, git, …
  private var login: String?            // the GitHub account connected in this sheet
  private var loads = 0
  private var ended = false
  private var connect: ConnectGitHubSheet?

  init(app: AppDelegate) {
    self.app = app
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 480), styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    super.init()
    build()
  }

  private func build() {
    let title = NSTextField(labelWithString: "Clone a Repository")
    title.font = NSFont.systemFont(ofSize: 15, weight: .semibold)

    let addressLabel = NSTextField(labelWithString: "Address:")
    address.placeholderString = "https://github.com/owner/repo or git@github.com:owner/repo.git"
    address.delegate = self
    address.cell?.isScrollable = true
    address.cell?.wraps = false
    address.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let addressRow = NSStackView(views: [addressLabel, address])
    addressRow.spacing = 8

    let listTitle = NSTextField(labelWithString: "Your repositories on GitHub")
    listTitle.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
    listTitle.textColor = .secondaryLabelColor
    filter.placeholderString = "Filter"
    filter.delegate = self

    let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("repository"))
    column.title = "Repository"
    column.resizingMask = .autoresizingMask
    column.width = 500
    table.addTableColumn(column)
    table.headerView = nil
    table.rowHeight = 22
    table.allowsEmptySelection = true
    table.allowsMultipleSelection = false
    table.usesAlternatingRowBackgroundColors = true
    table.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
    table.dataSource = self
    table.delegate = self
    table.target = self
    table.doubleAction = #selector(rowChosenTwice)
    tableScroll.documentView = table
    tableScroll.hasVerticalScroller = true
    tableScroll.borderType = .bezelBorder
    tableScroll.translatesAutoresizingMaskIntoConstraints = false

    noteSpinner.style = .spinning
    noteSpinner.controlSize = .small
    noteSpinner.isDisplayedWhenStopped = false
    noteText.alignment = .center
    noteText.textColor = .secondaryLabelColor
    noteText.preferredMaxLayoutWidth = 420
    noteConnect.target = self
    noteConnect.action = #selector(connectGitHub)
    for v in [noteSpinner, noteText, noteConnect] as [NSView] { note.addArrangedSubview(v) }
    note.orientation = .vertical
    note.alignment = .centerX
    note.spacing = 8
    note.translatesAutoresizingMaskIntoConstraints = false

    let listBox = NSView()
    listBox.translatesAutoresizingMaskIntoConstraints = false
    listBox.addSubview(tableScroll)
    listBox.addSubview(note)

    let folderLabel = NSTextField(labelWithString: "Put it in:")
    folderText.lineBreakMode = .byTruncatingMiddle
    folderText.setContentHuggingPriority(.defaultLow, for: .horizontal)
    folderText.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    chooseButton.target = self
    chooseButton.action = #selector(chooseFolder)
    let folderRow = NSStackView(views: [folderLabel, folderText, chooseButton])
    folderRow.spacing = 8

    message.preferredMaxLayoutWidth = 370
    message.setContentHuggingPriority(.defaultLow, for: .horizontal)
    message.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    messageConnect.target = self
    messageConnect.action = #selector(connectGitHub)
    messageConnect.isHidden = true
    let messageRow = NSStackView(views: [message, messageConnect])
    messageRow.alignment = .centerY
    messageRow.spacing = 8

    bar.style = .bar
    bar.isIndeterminate = false
    bar.minValue = 0
    bar.maxValue = 100
    bar.isHidden = true

    cancelButton.target = self
    cancelButton.action = #selector(cancel)
    cancelButton.keyEquivalent = "\u{1b}"
    cloneButton.target = self
    cloneButton.action = #selector(clone)
    cloneButton.keyEquivalent = "\r"
    let buttons = NSStackView()
    buttons.setViews([cancelButton, cloneButton], in: .trailing)
    buttons.spacing = 8

    let stack = NSStackView(views: [title, addressRow, listTitle, filter, listBox, folderRow, messageRow, bar, buttons])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 10
    stack.detachesHiddenViews = false    // the sheet keeps its size when the progress bar comes and goes
    stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
    stack.setCustomSpacing(16, after: addressRow)
    stack.setCustomSpacing(6, after: listTitle)
    stack.setCustomSpacing(16, after: listBox)
    stack.translatesAutoresizingMaskIntoConstraints = false
    let content = NSView()
    content.addSubview(stack)
    var constraints = [
      stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      stack.topAnchor.constraint(equalTo: content.topAnchor),
      stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
      stack.widthAnchor.constraint(equalToConstant: 560),
      listBox.heightAnchor.constraint(equalToConstant: 150),
      tableScroll.leadingAnchor.constraint(equalTo: listBox.leadingAnchor),
      tableScroll.trailingAnchor.constraint(equalTo: listBox.trailingAnchor),
      tableScroll.topAnchor.constraint(equalTo: listBox.topAnchor),
      tableScroll.bottomAnchor.constraint(equalTo: listBox.bottomAnchor),
      note.centerXAnchor.constraint(equalTo: listBox.centerXAnchor),
      note.centerYAnchor.constraint(equalTo: listBox.centerYAnchor),
      note.widthAnchor.constraint(lessThanOrEqualTo: listBox.widthAnchor, constant: -40),
      messageRow.heightAnchor.constraint(greaterThanOrEqualToConstant: 34),
    ]
    for v in [addressRow, filter, listBox, folderRow, messageRow, bar, buttons] as [NSView] {
      constraints.append(v.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40))
    }
    NSLayoutConstraint.activate(constraints)
    window.contentView = content
    window.initialFirstResponder = address
    content.layoutSubtreeIfNeeded()
    window.setContentSize(content.fittingSize)
    content.layoutSubtreeIfNeeded()
    table.sizeLastColumnToFit()   // the one column is as wide as the list
  }

  func present(on host: NSWindow) {
    self.host = host
    window.appearance = host.appearance   // dark over the board, as its title bar is
    showFolder()
    update()
    host.beginSheet(window) { _ in }
    window.makeFirstResponder(address)
    loadRepos()
  }

  /** The sheet goes (the board opened, or the person cancelled). Nothing that arrives after this is shown. */
  func end() {
    guard !ended else { return }
    ended = true
    connect?.end()
    connect = nil
    if let parent = window.sheetParent { parent.endSheet(window) } else { window.orderOut(nil) }
  }

  // MARK: the list of repositories

  private enum ListState { case loading, list, none, failed(String) }

  private func showList(_ state: ListState) {
    noteSpinner.stopAnimation(nil)
    noteConnect.isHidden = true
    note.isHidden = false
    switch state {
    case .loading:
      noteSpinner.startAnimation(nil)
      noteText.stringValue = "Loading your repositories…"
    case .list:
      note.isHidden = true
    case .none:
      if let login = login {
        noteText.stringValue = "GitHub lists no repositories for \(visible(login))."
      } else {
        noteText.stringValue = "Connect your GitHub account to choose from your repositories here."
        noteConnect.isHidden = false
      }
    case .failed(let sentence):
      noteText.stringValue = sentence
      noteConnect.isHidden = false
    }
    update()
  }

  /** `--github-repos`, 20 seconds at most. With no GitHub account connected, the list is empty. */
  private func loadRepos() {
    loads += 1
    let mine = loads
    repos = []
    applyFilter()
    showList(.loading)
    Helper.run(["--github-repos"], limit: 20) { [weak self] r in
      guard let self = self, !self.ended, mine == self.loads else { return }
      switch r {
      case .done(let lines, _):
        guard let items = lines.reversed().lazy.compactMap({ payload($0, "WORKBENCH_GITHUB_REPOS") as? [Any] }).first else {
          self.showList(.failed("Your repositories on GitHub could not be listed."))
          return
        }
        self.repos = items.compactMap { item in
          guard let o = item as? [String: Any], let name = o["fullName"] as? String, let url = o["cloneUrl"] as? String,
                !name.isEmpty, !url.isEmpty else { return nil }
          return GitHubRepo(fullName: name, cloneUrl: url, isPrivate: (o["private"] as? Bool) == true)
        }
        self.applyFilter()
        self.showList(self.repos.isEmpty ? .none : .list)
      case .timedOut:
        self.showList(.failed("Your repositories on GitHub did not load within 20 seconds."))
      case .failed:
        self.showList(.failed("Your repositories on GitHub could not be listed."))
      }
    }
  }

  private func applyFilter() {
    let q = filter.stringValue.trimmingCharacters(in: .whitespaces).lowercased()
    table.deselectAll(nil)
    shown = q.isEmpty ? repos : repos.filter { $0.fullName.lowercased().contains(q) }
    table.reloadData()
  }

  func numberOfRows(in tableView: NSTableView) -> Int { shown.count }

  func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
    guard row >= 0, row < shown.count else { return nil }
    let id = NSUserInterfaceItemIdentifier("repositoryCell")
    let cell: NSTableCellView
    if let reused = tableView.makeView(withIdentifier: id, owner: nil) as? NSTableCellView {
      cell = reused
    } else {
      cell = NSTableCellView()
      cell.identifier = id
      let text = NSTextField(labelWithString: "")
      text.lineBreakMode = .byTruncatingMiddle
      text.translatesAutoresizingMaskIntoConstraints = false
      cell.addSubview(text)
      cell.textField = text
      NSLayoutConstraint.activate([
        text.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 6),
        text.trailingAnchor.constraint(lessThanOrEqualTo: cell.trailingAnchor, constant: -6),
        text.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
      ])
    }
    let r = shown[row]
    cell.textField?.stringValue = visible(r.fullName) + (r.isPrivate ? "  (private)" : "")
    return cell
  }

  // A click on a repository fills in its address; a double click clones it.
  func tableViewSelectionDidChange(_ notification: Notification) {
    let row = table.selectedRow
    guard !busy, row >= 0, row < shown.count else { return }
    address.stringValue = shown[row].cloneUrl
    clearMessage()
    update()
  }

  @objc func rowChosenTwice() {
    let row = table.clickedRow
    guard !busy, row >= 0, row < shown.count else { return }
    address.stringValue = shown[row].cloneUrl
    clone()
  }

  func controlTextDidChange(_ n: Notification) {
    if let f = n.object as? NSSearchField, f === filter {
      applyFilter()
    } else if let f = n.object as? NSTextField, f === address {
      if !busy { clearMessage() }
      update()
    }
  }

  // MARK: the folder

  private func showFolder() {
    folderText.stringValue = visible((folder.path as NSString).abbreviatingWithTildeInPath)
    folderText.toolTip = visible(folder.path)
  }

  @objc func chooseFolder() {
    guard !busy else { return }
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = true
    panel.allowsMultipleSelection = false
    panel.prompt = "Choose"
    panel.message = "Choose the folder to put the repository in. Workbench makes a folder of the repository’s name inside it."
    var isFolder: ObjCBool = false
    let there = FileManager.default.fileExists(atPath: folder.path, isDirectory: &isFolder) && isFolder.boolValue
    panel.directoryURL = there ? folder : FileManager.default.homeDirectoryForCurrentUser
    panel.beginSheetModal(for: window) { [weak self] r in
      guard let self = self, !self.ended, r == .OK, let url = panel.url else { return }
      self.folder = url
      CloneFolder.set(url)
      self.showFolder()
      self.clearMessage()
    }
  }

  // MARK: cloning

  @objc func clone() {
    guard !busy, !ended else { return }
    let a = address.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !a.isEmpty else { return }
    startClone(a, saying: nil)
  }

  private func startClone(_ a: String, saying first: String?) {
    if let problem = CloneAddress.problem(a) { failed(kind: "url", sentence: problem); return }
    let fm = FileManager.default
    let place = visible((folder.path as NSString).abbreviatingWithTildeInPath)
    var isFolder: ObjCBool = false
    if fm.fileExists(atPath: folder.path, isDirectory: &isFolder) {
      guard isFolder.boolValue else { failed(kind: "folder", sentence: "\(place) is a file, not a folder. Choose a folder to put the repository in."); return }
    } else if folder.standardizedFileURL.path == CloneFolder.standard.standardizedFileURL.path {
      // ~/Developer is made the first time it is used
      do { try fm.createDirectory(at: folder, withIntermediateDirectories: true) } catch {
        failed(kind: "folder", sentence: "Workbench could not make the folder \(place).")
        return
      }
    } else {
      failed(kind: "folder", sentence: "The folder \(place) is not there any more. Choose another one.")
      return
    }
    name = CloneAddress.shortName(a)
    lastFailure = nil
    messageConnect.isHidden = true
    busy = true
    message.stringValue = (first.map { $0 + " " } ?? "") + "Cloning \(visible(name)) into \(visible(folder.lastPathComponent))…"
    spin()
    update()
    app?.beginClone(address: a, into: folder)
  }

  /** Waiting for the folder that is open to close first. */
  func waiting(_ sentence: String) {
    guard !ended else { return }
    busy = true
    message.stringValue = sentence
    spin()
    update()
  }

  /** Back to the address as it was: the person chose not to stop the agents at work. */
  func idle() {
    guard !ended else { return }
    busy = false
    clearMessage()
    update()
  }

  /** The clone's progress, as Workbench reports it. */
  func show(_ step: CloneStep) {
    guard busy, !ended else { return }
    let n = visible(name)
    switch step {
    case .progress(let phase, let percent):
      let p = percent.map { max(0, min(100, $0)) }
      func words(_ verb: String) -> String { p.map { "\(verb) \(n): \(Int($0.rounded()))%" } ?? "\(verb) \(n)…" }
      // each step's share of the bar, so it never runs backwards
      let step: (words: String, from: Double, to: Double)
      switch phase {
      case "counting": step = ("Getting ready to download \(n)…", 0, 2)
      case "compressing": step = ("Getting ready to download \(n)…", 2, 5)
      case "receiving": step = (words("Downloading"), 5, 85)
      case "resolving": step = (words("Unpacking"), 85, 95)
      case "checkout": step = (words("Writing the files of"), 95, 100)
      default: step = ("Cloning \(n)…", 0, 0)
      }
      message.stringValue = step.words
      if step.to > 0 {
        if bar.isIndeterminate {
          bar.stopAnimation(nil)
          bar.isIndeterminate = false
          bar.doubleValue = 0
        }
        bar.doubleValue = max(bar.doubleValue, step.from + (step.to - step.from) * (p ?? 0) / 100)
      }
    case .opening:
      message.stringValue = "Opening \(n)…"
      spin()
    }
  }

  /** The clone was refused, or could not start: why, in words, and the address again. */
  func failed(kind: String, sentence: String) {
    guard !ended else { return }
    busy = false
    lastFailure = kind
    message.stringValue = visible(sentence)
    messageConnect.isHidden = kind != "auth"
    update()
    if kind == "url" { window.makeFirstResponder(address) }
  }

  private func spin() {
    bar.isHidden = false
    bar.isIndeterminate = true
    bar.startAnimation(nil)
  }

  private func clearMessage() {
    message.stringValue = ""
    messageConnect.isHidden = true
    lastFailure = nil
  }

  private func update() {
    address.isEnabled = !busy
    filter.isEnabled = !busy && !repos.isEmpty
    table.isEnabled = !busy
    chooseButton.isEnabled = !busy
    noteConnect.isEnabled = !busy
    messageConnect.isEnabled = !busy
    cloneButton.isEnabled = !busy && !address.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    if !busy {
      bar.stopAnimation(nil)
      bar.isHidden = true
      bar.isIndeterminate = false
      bar.doubleValue = 0
    }
  }

  @objc func cancel() { app?.cancelClone() }

  // MARK: Connect GitHub…

  /**
   * The token sheet. Once GitHub accepts the token, the list loads again; after a clone GitHub refused (`auth`), the
   * clone is tried again at once. The token is for https, so a github.com address over ssh is tried in its https form,
   * which the address field then shows; so is one refused for this Mac's SSH key (`ssh`).
   */
  @objc func connectGitHub() {
    guard !busy, !ended, connect == nil else { return }
    let c = ConnectGitHubSheet()
    connect = c
    c.onEnd = { [weak self] login, sentence in
      guard let self = self else { return }
      self.connect = nil
      guard let login = login, !self.ended else { return }
      self.login = login
      let a = self.address.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
      let https = CloneAddress.githubHTTPS(a)
      let again = self.lastFailure == "auth" || (self.lastFailure == "ssh" && https != nil)
      self.loadRepos()
      if again, !a.isEmpty {
        if let https = https { self.address.stringValue = https }
        self.startClone(https ?? a, saying: visible(sentence))
      } else {
        self.clearMessage()
        self.message.stringValue = visible(sentence)
      }
    }
    c.present(on: window)
  }
}

/**
 * Connect GitHub…: a token from the person's GitHub account, given to Workbench (`--connect-github`, with the token on
 * its standard input). Workbench checks it with GitHub, keeps it in the login keychain, and gives it to git for
 * github.com. The field is emptied as the token is sent, and the app keeps no copy of it.
 */
final class ConnectGitHubSheet: NSObject, NSTextFieldDelegate {
  static let tokenPage = URL(string: "https://github.com/settings/tokens/new?description=Workbench&scopes=repo")!
  let window: NSWindow
  private let field = NSSecureTextField()
  private let status = NSTextField(wrappingLabelWithString: "")
  private let spinner = NSProgressIndicator()
  private let cancelButton = NSButton(title: "Cancel", target: nil, action: nil)
  private let connectButton = NSButton(title: "Connect", target: nil, action: nil)
  private var working = false
  private var ended = false
  /// Called once, when the sheet goes: with the login and Workbench's sentence when GitHub accepted the token.
  var onEnd: ((_ login: String?, _ sentence: String) -> Void)?

  override init() {
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 260), styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    super.init()
    let title = NSTextField(labelWithString: "Connect GitHub")
    title.font = NSFont.systemFont(ofSize: 15, weight: .semibold)
    let about = NSTextField(wrappingLabelWithString: "Workbench lists your repositories on GitHub, and clones private ones, with a token from your GitHub account. Create one on GitHub, copy it, and paste it here. Workbench keeps it in your login keychain.")
    about.preferredMaxLayoutWidth = 420
    let link = NSButton(title: "Create a token on GitHub", target: self, action: #selector(openTokenPage))
    link.isBordered = false
    link.contentTintColor = .linkColor
    link.toolTip = ConnectGitHubSheet.tokenPage.absoluteString
    let fieldLabel = NSTextField(labelWithString: "Token:")
    field.placeholderString = "Paste the token here"
    field.delegate = self
    field.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let fieldRow = NSStackView(views: [fieldLabel, field])
    fieldRow.spacing = 8
    spinner.style = .spinning
    spinner.controlSize = .small
    spinner.isDisplayedWhenStopped = false
    status.preferredMaxLayoutWidth = 390
    status.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let statusRow = NSStackView(views: [spinner, status])
    statusRow.spacing = 6
    statusRow.alignment = .centerY
    cancelButton.target = self
    cancelButton.action = #selector(cancel)
    cancelButton.keyEquivalent = "\u{1b}"
    connectButton.target = self
    connectButton.action = #selector(connect)
    connectButton.keyEquivalent = "\r"
    let buttons = NSStackView()
    buttons.setViews([cancelButton, connectButton], in: .trailing)
    buttons.spacing = 8
    let stack = NSStackView(views: [title, about, link, fieldRow, statusRow, buttons])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 10
    stack.detachesHiddenViews = false
    stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
    stack.translatesAutoresizingMaskIntoConstraints = false
    let content = NSView()
    content.addSubview(stack)
    var constraints = [
      stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      stack.topAnchor.constraint(equalTo: content.topAnchor),
      stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
      stack.widthAnchor.constraint(equalToConstant: 460),
      statusRow.heightAnchor.constraint(greaterThanOrEqualToConstant: 34),
    ]
    for v in [about, fieldRow, statusRow, buttons] as [NSView] {
      constraints.append(v.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40))
    }
    NSLayoutConstraint.activate(constraints)
    window.contentView = content
    window.initialFirstResponder = field
    content.layoutSubtreeIfNeeded()
    window.setContentSize(content.fittingSize)
    update()
  }

  func present(on parent: NSWindow) {
    window.appearance = parent.appearance
    parent.beginSheet(window) { _ in }
    window.makeFirstResponder(field)
  }

  /** The sheet goes without a connection (Cancel, or the clone sheet went). */
  func end() { close(login: nil, sentence: "") }

  private func close(login: String?, sentence: String) {
    guard !ended else { return }
    ended = true
    field.stringValue = ""
    if let parent = window.sheetParent { parent.endSheet(window) } else { window.orderOut(nil) }
    let done = onEnd
    onEnd = nil
    done?(login, sentence)
  }

  @objc func openTokenPage() { NSWorkspace.shared.open(ConnectGitHubSheet.tokenPage) }

  @objc func cancel() { end() }

  func controlTextDidChange(_ n: Notification) { update() }

  private func update() {
    field.isEnabled = !working
    // While GitHub checks the token, Cancel waits too: Workbench would keep a token it accepts after the sheet went.
    cancelButton.isEnabled = !working
    connectButton.isEnabled = !working && !field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /** `--connect-github` with the token on its standard input, 30 seconds at most. */
  @objc func connect() {
    guard !working, !ended else { return }
    let token = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    field.stringValue = ""
    guard !token.isEmpty else { update(); return }
    working = true
    status.stringValue = "Checking the token with GitHub…"
    spinner.startAnimation(nil)
    update()
    Helper.run(["--connect-github"], input: Data((token + "\n").utf8), limit: 30) { [weak self] r in
      guard let self = self, !self.ended else { return }
      self.working = false
      self.spinner.stopAnimation(nil)
      var said = "Workbench could not connect to GitHub."
      switch r {
      case .done(let lines, _):
        if let o = lines.reversed().lazy.compactMap({ payload($0, "WORKBENCH_GITHUB") as? [String: Any] }).first {
          let sentence = (o["sentence"] as? String).flatMap { $0.isEmpty ? nil : $0 }
          if (o["ok"] as? Bool) == true, let login = o["login"] as? String, !login.isEmpty {
            self.close(login: login, sentence: sentence ?? "Connected to GitHub as \(login).")
            return
          }
          if let sentence = sentence { said = sentence }
        }
      case .timedOut:
        said = "GitHub did not answer within 30 seconds. Try again."
      case .failed:
        break
      }
      self.status.stringValue = visible(said)
      self.update()
      self.window.makeFirstResponder(self.field)
    }
  }
}

// ------------------------------------------------------------------ start

// The app writes to Workbench's standard input (the token, for Connect GitHub). When that Workbench has already ended,
// the write must fail, not end the app.
signal(SIGPIPE, SIG_IGN)
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
