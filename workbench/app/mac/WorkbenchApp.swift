// Workbench for macOS: a native window around the Workbench board.
//
// The app bundles Node (with npm) and Workbench. It asks which git repository to work on (or reopens a recent one, or
// clones one), starts `node workbench/bin/workbench.mjs --repo <folder> --app` (for a clone, `--clone <address> --into
// <folder> --app`, which clones first and then runs on the new folder), and shows the board in its own window. Its pipe
// to Workbench's standard input is a lifeline: when the app quits, or crashes, the pipe closes and Workbench stops its
// agents, as on Ctrl-C. Nothing here talks to the agents: the page does that, exactly as in a browser.
//
// The clone sheet signs the person in to GitHub with GitHub's own command-line tool (`--github-signin`), or takes a
// token instead. The first window says when git is not installed yet, and opens Apple's installer for it.
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
/// `WORKBENCH_GITHUB {…}` from `--connect-github`, `--github-signin` and `--github-status`, `WORKBENCH_GITHUB_REPOS
/// […]`), or nil.
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
  static let credentials = "Leave your name and password out of the address. If the repository is private, sign in to GitHub instead."

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
   * form (`https://github.com/owner/repo.git`), which a GitHub sign-in can read; nil for any other address. Sign in to
   * GitHub… and a token both give git a sign-in for https only, so a clone tried again after them goes over https.
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
    case "auth": return "GitHub did not let Workbench read this repository. If it is private, sign in to GitHub, then try again."
    case "ssh":
      let h = host(address)
      if h?.lowercased() == "github.com" {
        return "GitHub did not accept this Mac’s SSH key. Use the https:// address instead; for a private repository, sign in to GitHub first."
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

// ------------------------------------------------------------------ git on this Mac

/**
 * Whether git can run on this Mac. Apple's git comes with its developer tools (the Command Line Tools, or Xcode).
 * Without them, /usr/bin/git is only a stand-in that opens Apple's installer by itself when it is run, so it is run only
 * after `xcode-select -p` has named a developer folder with git in it. A git of another kind that comes first on
 * Workbench's PATH (Homebrew's, say) counts too, since that is the one Workbench runs.
 */
enum GitTools {
  enum State { case unknown, ready, missing }

  static let missing = "Git is not installed yet. Apple’s developer tools include it."

  /**
   * The check, off the main thread, 5 seconds at most for each program; `done` gets the answer on the main thread. Call
   * it on the main thread.
   */
  static func check(_ done: @escaping (Bool) -> Void) {
    let env = Environment.forWorkbench()
    DispatchQueue.global(qos: .utility).async {
      let ok = runs(env)
      DispatchQueue.main.async { done(ok) }
    }
  }

  private static func runs(_ env: [String: String]) -> Bool {
    if let p = run("/usr/bin/xcode-select", ["-p"], env: env), p.status == 0 {
      let dir = p.output.trimmingCharacters(in: .whitespacesAndNewlines)
      if dir.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: dir + "/usr/bin/git"),
         run("/usr/bin/git", ["--version"], env: env)?.status == 0 {
        return true
      }
    }
    guard let first = firstOnPath("git", env), first != "/usr/bin/git" else { return false }
    return run(first, ["--version"], env: env)?.status == 0
  }

  /** The program Workbench would run by this name: the first on its PATH, with links followed. */
  private static func firstOnPath(_ name: String, _ env: [String: String]) -> String? {
    for dir in (env["PATH"] ?? "").split(separator: ":") where dir.hasPrefix("/") {
      let p = "\(dir)/\(name)"
      if FileManager.default.isExecutableFile(atPath: p) { return URL(fileURLWithPath: p).resolvingSymlinksInPath().path }
    }
    return nil
  }

  /**
   * Install Git: `/usr/bin/xcode-select --install`, which opens Apple's own installer for its developer tools. `done`
   * gets, on the main thread, whether it opened (exit 0). It exits 1 when the tools are there already. What it printed
   * goes to the log only. Call it on the main thread.
   */
  static func install(_ done: @escaping (Bool) -> Void) {
    let env = Environment.forWorkbench()
    DispatchQueue.global(qos: .userInitiated).async {
      let r = run("/usr/bin/xcode-select", ["--install"], env: env, limit: 30)
      DispatchQueue.main.async {
        let said = r.map { $0.output.trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
        Log.shared.write("xcode-select --install: \(r.map { "exited (\($0.status))" } ?? "did not run or was stopped")\(said.isEmpty ? "" : ": \(said)")")
        done(r?.status == 0)
      }
    }
  }

  /**
   * A program run with an argument array, Workbench's environment and nothing on its standard input, its output read
   * as it comes. Past `limit` seconds it is stopped. nil when it could not start, or was stopped. Not on the main thread.
   */
  static func run(_ program: String, _ args: [String], env: [String: String], limit: TimeInterval = 5) -> (status: Int32, output: String)? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: program)
    p.arguments = args
    p.environment = env
    p.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
    let out = Pipe()
    p.standardOutput = out
    p.standardError = out
    p.standardInput = FileHandle.nullDevice
    let lock = NSLock()
    let ended = DispatchSemaphore(value: 0)
    var data = Data()
    out.fileHandleForReading.readabilityHandler = { h in
      let d = h.availableData
      if d.isEmpty { h.readabilityHandler = nil; ended.signal(); return }
      lock.lock(); if data.count < 65_536 { data.append(d) }; lock.unlock()
    }
    do { try p.run() } catch { out.fileHandleForReading.readabilityHandler = nil; return nil }
    let stop = DispatchWorkItem { if p.isRunning { p.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + limit, execute: stop)
    p.waitUntilExit()
    stop.cancel()
    // What it printed last; a program it left running may keep the pipe open, so this waits a second at most.
    _ = ended.wait(timeout: .now() + 1)
    out.fileHandleForReading.readabilityHandler = nil
    lock.lock(); let text = String(decoding: data, as: UTF8.self); lock.unlock()
    guard p.terminationReason == .exit else { return nil }
    return (p.terminationStatus, text)
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

/// What `--github-status` says: whether GitHub is signed in, as whom, and how (`gh`, GitHub's own command-line tool,
/// or `token`, a token Workbench keeps).
struct GitHubStatus {
  let signedIn: Bool
  let login: String?
  let via: String?
}

/**
 * Runs the bundled Workbench once, with the environment the board's own process gets: `--github-repos`,
 * `--github-status`, or `--connect-github` with the token on its standard input (never in its arguments, which other
 * programs on the Mac can read, nor in its environment). What it prints is read whole and not written to the log, since
 * it names the person's private repositories. Past `limit` seconds it is stopped. `quiet`: its exit is not logged
 * either (`--github-status`, asked every 3 seconds while a sign-in in Terminal is awaited).
 */
enum Helper {
  /** `--github-status`, 15 seconds at most; nil when it gave no answer. */
  static func githubStatus(quiet: Bool = false, _ done: @escaping (GitHubStatus?) -> Void) {
    run(["--github-status"], limit: 15, quiet: quiet) { r in
      guard case .done(let lines, _) = r,
            let o = lines.reversed().lazy.compactMap({ payload($0, "WORKBENCH_GITHUB") as? [String: Any] }).first,
            let signedIn = o["signedIn"] as? Bool else { done(nil); return }
      let login = (o["login"] as? String).flatMap { $0.isEmpty ? nil : $0 }
      done(GitHubStatus(signedIn: signedIn, login: login, via: o["via"] as? String))
    }
  }

  static func run(_ args: [String], input: Data? = nil, limit: TimeInterval, quiet: Bool = false, done: @escaping (HelperResult) -> Void) {
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
        if !quiet || status != 0 { Log.shared.write("\(what): exited (\(status))") }
        run.finish(.done(lines: lines, status: status))
      }
    }
  }
}

/**
 * A run of the bundled Workbench whose lines are answered as they come, while it still runs: `--github-signin`, which
 * prints a `WORKBENCH_GITHUB` line for each step of a sign-in that can take 15 minutes. Its standard input stays open
 * while it runs, and closes when the app stops it or goes away. Its other lines (Workbench's own words about what went
 * wrong) go to the log, as the board's do; the `WORKBENCH_GITHUB` lines do not.
 */
final class HelperStream {
  /// Every run under way, kept until its process has exited, whoever let go of it (main thread only).
  private static var running: [ObjectIdentifier: HelperStream] = [:]
  let what: String
  private let process = Process()
  private let input = Pipe()
  private let output = Pipe()
  private var buffer = Data()
  private var exitStatus: Int32?
  private var outputEnded = false
  private var reported = false
  /// Each whole line, on the main thread.
  var onLine: ((String) -> Void)?
  /// Once it has exited and all it printed has been read (or a second after it exited), on the main thread.
  var onExit: ((Int32) -> Void)?

  init(_ args: [String]) {
    what = args.first ?? "Workbench"
    let res = Bundle.main.resourceURL!
    process.executableURL = res.appendingPathComponent("node/bin/node")
    process.arguments = [res.appendingPathComponent("workbench/bin/workbench.mjs").path] + args
    process.environment = Environment.forWorkbench()
    process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
    process.standardInput = input
    process.standardOutput = output
    process.standardError = output
  }

  /** Start it; false when it could not start (said in the log). */
  func start() -> Bool {
    output.fileHandleForReading.readabilityHandler = { [weak self] h in
      let data = h.availableData
      if data.isEmpty { h.readabilityHandler = nil }   // the end: it closed its output
      DispatchQueue.main.async { self?.take(data) }
    }
    process.terminationHandler = { [weak self] p in
      let status = p.terminationStatus
      DispatchQueue.main.async {
        guard let self = self else { return }
        self.exitStatus = status
        self.reportExit(force: false)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.reportExit(force: true) }
      }
    }
    do { try process.run() } catch {
      output.fileHandleForReading.readabilityHandler = nil
      Log.shared.write("\(what): could not start: \(error.localizedDescription)")
      return false
    }
    HelperStream.running[ObjectIdentifier(self)] = self
    Log.shared.write("\(what): started")
    return true
  }

  /** Stop it: its standard input closes, then SIGTERM, and SIGKILL 3 seconds later. Nothing it says after this is heard. */
  func stop() {
    onLine = nil
    onExit = nil
    try? input.fileHandleForWriting.close()
    guard process.isRunning else { return }
    let p = process
    let pid = p.processIdentifier
    Log.shared.write("\(what): stopped")
    p.terminate()
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { if p.isRunning { kill(pid, SIGKILL) } }
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
    if buffer.count > 1_000_000 { buffer.removeAll() }   // no line is that long
  }

  private func take(line raw: String) {
    let line = raw.hasSuffix("\r") ? String(raw.dropLast()) : raw
    if !line.hasPrefix("WORKBENCH_"), !line.trimmingCharacters(in: .whitespaces).isEmpty { Log.shared.write("\(what): \(line)") }
    onLine?(line)
  }

  private func reportExit(force: Bool) {
    guard !reported, let status = exitStatus, outputEnded || force else { return }
    reported = true
    output.fileHandleForReading.readabilityHandler = nil
    Log.shared.write("\(what): exited (\(status))")
    let done = onExit
    onLine = nil
    onExit = nil
    HelperStream.running[ObjectIdentifier(self)] = nil
    done?(status)
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
  /// Whether git runs, as the last check found (GitTools). Clone Repository… is on only once a check found it ready.
  var git = GitTools.State.unknown
  private var gitChecking = false
  private var gitCheckAgain = false
  private var gitInstalling = false
  /// What the first window says after Install Git, in place of "Git is not installed yet. …".
  private var gitWords: String?
  private weak var welcomeClone: NSButton?
  private weak var welcomeGit: NSView?
  private weak var welcomeGitText: NSTextField?
  private weak var welcomeInstall: NSButton?

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMenus()
    checkGit()
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

  // Back in front, after Apple's installer, say: is git there now?
  func applicationDidBecomeActive(_ note: Notification) { checkGit() }

  // A sign-in to GitHub under way stops with the app.
  func applicationWillTerminate(_ note: Notification) { cloneSheet?.end() }

  // MARK: git

  /** Whether git runs, found again (one check at a time). Only a change redraws anything. */
  func checkGit() {
    guard !gitChecking else { gitCheckAgain = true; return }
    gitChecking = true
    GitTools.check { [weak self] ok in
      guard let self = self else { return }
      self.gitChecking = false
      let found: GitTools.State = ok ? .ready : .missing
      if found != self.git {
        Log.shared.write(ok ? "git runs" : "git does not run: \(GitTools.missing)")
        self.git = found
        if ok { self.gitWords = nil }
        self.showGit()
        self.cloneSheet?.refresh()
      }
      if self.gitCheckAgain { self.gitCheckAgain = false; self.checkGit() }
    }
  }

  /** Install Git: Apple's installer for its developer tools, which include git. The app checks again when it is back in front. */
  @objc func installGit() {
    guard !gitInstalling else { return }
    gitInstalling = true
    welcomeInstall?.isEnabled = false
    GitTools.install { [weak self] opened in
      guard let self = self else { return }
      self.gitInstalling = false
      self.gitWords = opened ? "Apple’s installer is open: follow its steps, then come back here."
        : "Apple’s installer did not open. View → Show Log says why."
      self.showGit()
      self.checkGit()   // the tools may be there already
    }
  }

  /** The first window's git line, Install Git and Clone Repository…, as the last check found git; in place. */
  func showGit() {
    welcomeClone?.isEnabled = git == .ready
    welcomeGit?.isHidden = git != .missing
    welcomeGitText?.stringValue = gitWords ?? GitTools.missing
    welcomeInstall?.isEnabled = !gitInstalling
    if let w = welcome { fitWelcome(w) }
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

  /** Clone Repository…: the clone sheet, over the window in front (the board, or the first window). Only once git runs. */
  @objc func showClone() {
    if let s = cloneSheet { s.host?.makeKeyAndOrderFront(nil); return }
    guard git == .ready else { NSSound.beep(); return }   // the button and the menu item are off: the first window says why
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

  // While the clone sheet is up, it is the way to open something: finish it, or cancel it, first. Clone Repository…
  // waits until a check has found that git runs.
  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    if cloneSheet != nil, let action = item.action,
       [#selector(chooseFolder), #selector(openDemo), #selector(openRecent(_:))].contains(action) { return false }
    if item.action == #selector(showClone), cloneSheet == nil, git != .ready { return false }
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
    sub.preferredMaxLayoutWidth = 444
    // Git missing: why Clone is off, and Install Git (Apple's installer). Hidden while git runs.
    let gitIcon = NSImageView()
    gitIcon.image = NSImage(systemSymbolName: "exclamationmark.triangle.fill", accessibilityDescription: nil)
    gitIcon.contentTintColor = .systemOrange
    gitIcon.setContentHuggingPriority(.required, for: .horizontal)
    let gitText = NSTextField(wrappingLabelWithString: gitWords ?? GitTools.missing)
    gitText.preferredMaxLayoutWidth = 300
    let install = NSButton(title: "Install Git", target: self, action: #selector(installGit))
    install.isEnabled = !gitInstalling
    let gitRow = NSStackView(views: [gitIcon, gitText, install])
    gitRow.alignment = .centerY
    gitRow.spacing = 8
    gitRow.isHidden = git != .missing
    let clone = NSButton(title: "Clone Repository…", target: self, action: #selector(showClone))
    clone.isEnabled = git == .ready
    let open = NSButton(title: "Open Folder…", target: self, action: #selector(chooseFolder))
    open.keyEquivalent = "\r"
    let demo = NSButton(title: "Try the Demo", target: self, action: #selector(openDemo))
    let buttons = NSStackView(views: [clone, open, demo])
    buttons.spacing = 8
    stack.addArrangedSubview(title)
    stack.addArrangedSubview(sub)
    stack.addArrangedSubview(gitRow)
    stack.addArrangedSubview(buttons)
    welcomeClone = clone
    welcomeGit = gitRow
    welcomeGitText = gitText
    welcomeInstall = install
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
    fitWelcome(w)
    w.makeKeyAndOrderFront(nil)
    return w
  }

  /** The first window as tall as what it shows, 360 points at least, its top edge where it was. */
  func fitWelcome(_ w: NSWindow) {
    guard let content = w.contentView else { return }
    content.layoutSubtreeIfNeeded()
    let size = NSSize(width: 500, height: max(360, ceil(content.fittingSize.height)))
    let frame = w.frameRect(forContentRect: NSRect(origin: .zero, size: size))
    var f = w.frame
    guard abs(f.height - frame.height) > 0.5 else { return }
    f.origin.y += f.height - frame.height
    f.size = frame.size
    w.setFrame(f, display: true)
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
 * that process is the board, and the sheet goes. A refused clone says why here, with "Sign in to GitHub…" and "Use a
 * token instead…" when GitHub did not let Workbench read the repository (`auth`); not when it did not accept this Mac's
 * SSH key (`ssh`), which a sign-in for https does not mend.
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
  private let noteSignIn = NSButton(title: "Sign in to GitHub…", target: nil, action: nil)
  private let noteToken = CloneSheet.link("Use a token instead…")
  private let folderText = NSTextField(labelWithString: "")
  private let chooseButton = NSButton(title: "Choose…", target: nil, action: nil)
  private let message = NSTextField(wrappingLabelWithString: "")
  private let messageActions = NSStackView()    // beside the message after an `auth` refusal
  private let messageSignIn = NSButton(title: "Sign in to GitHub…", target: nil, action: nil)
  private let messageToken = CloneSheet.link("Use a token instead…")
  private let bar = NSProgressIndicator()
  private let cancelButton = NSButton(title: "Cancel", target: nil, action: nil)
  private let cloneButton = NSButton(title: "Clone", target: nil, action: nil)
  private var repos: [GitHubRepo] = []
  private var shown: [GitHubRepo] = []
  private var folder = CloneFolder.url
  private var name = ""                 // the repository being cloned, as the sheet names it
  private var busy = false              // closing what is open, or cloning
  private var lastFailure: String?      // auth, ssh, network, exists, url, git, …
  private var login: String?            // the GitHub account: signed in or connected in this sheet, or as Workbench says
  private var connected = false         // GitHub is signed in or connected, as this sheet knows
  private var loads = 0
  private var ended = false
  private var connect: ConnectGitHubSheet?
  private var signIn: SignInGitHubSheet?

  /** A small button that reads like a link: "Use a token instead…". */
  static func link(_ title: String) -> NSButton {
    let b = NSButton(title: title, target: nil, action: nil)
    b.isBordered = false
    b.contentTintColor = .linkColor
    b.font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)
    return b
  }

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
    noteSignIn.target = self
    noteSignIn.action = #selector(signInToGitHub)
    noteToken.target = self
    noteToken.action = #selector(useToken)
    for v in [noteSpinner, noteText, noteSignIn, noteToken] as [NSView] { note.addArrangedSubview(v) }
    note.orientation = .vertical
    note.alignment = .centerX
    note.spacing = 8
    note.setCustomSpacing(4, after: noteSignIn)
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
    messageSignIn.target = self
    messageSignIn.action = #selector(signInToGitHub)
    messageToken.target = self
    messageToken.action = #selector(useToken)
    messageActions.orientation = .vertical
    messageActions.alignment = .centerX
    messageActions.spacing = 2
    messageActions.setViews([messageSignIn, messageToken], in: .center)
    messageActions.setContentHuggingPriority(.required, for: .horizontal)
    messageActions.isHidden = true
    let messageRow = NSStackView(views: [message, messageActions])
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
      messageRow.heightAnchor.constraint(greaterThanOrEqualToConstant: 40),   // room for Sign in to GitHub… and its link
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

  /**
   * The sheet goes (the board opened, or the person cancelled, or the app quits). Nothing that arrives after this is
   * shown, and a sign-in to GitHub under way stops.
   */
  func end() {
    guard !ended else { return }
    ended = true
    connect?.end()
    connect = nil
    signIn?.end()
    signIn = nil
    if let parent = window.sheetParent { parent.endSheet(window) } else { window.orderOut(nil) }
  }

  /** Whether git runs changed: Clone follows it. */
  func refresh() {
    guard !ended else { return }
    update()
  }

  // MARK: the list of repositories

  private enum ListState { case loading, list, none, failed(String) }

  private func showList(_ state: ListState) {
    noteSpinner.stopAnimation(nil)
    noteSignIn.isHidden = true
    noteToken.isHidden = true
    note.isHidden = false
    switch state {
    case .loading:
      noteSpinner.startAnimation(nil)
      noteText.stringValue = "Loading your repositories…"
    case .list:
      note.isHidden = true
    case .none:
      if connected {
        noteText.stringValue = "GitHub lists no repositories for \(login.map(visible) ?? "your account")."
      } else {
        noteText.stringValue = "Sign in to GitHub to choose from your repositories here."
        noteSignIn.isHidden = false
        noteToken.isHidden = false
      }
    case .failed(let sentence):
      noteText.stringValue = sentence
      noteSignIn.isHidden = false
      noteToken.isHidden = false
    }
    update()
  }

  /**
   * `--github-repos`, 20 seconds at most. With no GitHub account signed in or connected, the list is empty; then
   * `--github-status` tells that apart from an account with no repositories.
   */
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
        guard self.repos.isEmpty, !self.connected else {
          self.showList(self.repos.isEmpty ? .none : .list)
          return
        }
        // Empty: no sign-in, or an account with no repositories? Workbench says which.
        Helper.githubStatus { [weak self] s in
          guard let self = self, !self.ended, mine == self.loads else { return }
          if let s = s, s.signedIn {
            self.connected = true
            if let l = s.login { self.login = l }
          }
          self.showList(.none)
        }
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
    if app?.git == .missing { failed(kind: "nogit", sentence: GitTools.missing); return }
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
    messageActions.isHidden = true
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
    messageActions.isHidden = kind != "auth"
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
    messageActions.isHidden = true
    lastFailure = nil
  }

  private func update() {
    address.isEnabled = !busy
    filter.isEnabled = !busy && !repos.isEmpty
    table.isEnabled = !busy
    chooseButton.isEnabled = !busy
    for b in [noteSignIn, noteToken, messageSignIn, messageToken] { b.isEnabled = !busy }
    cloneButton.isEnabled = !busy && app?.git != .missing
      && !address.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    if !busy {
      bar.stopAnimation(nil)
      bar.isHidden = true
      bar.isIndeterminate = false
      bar.doubleValue = 0
    }
  }

  @objc func cancel() { app?.cancelClone() }

  // MARK: Sign in to GitHub…, or a token

  /** Sign in to GitHub…: GitHub's own command-line tool signs the person in (SignInGitHubSheet). */
  @objc func signInToGitHub() {
    guard !busy, !ended, connect == nil, signIn == nil else { return }
    let s = SignInGitHubSheet()
    signIn = s
    s.onEnd = { [weak self] outcome in
      guard let self = self else { return }
      self.signIn = nil
      guard !self.ended else { return }
      switch outcome {
      case .signedIn(let login):
        self.signedIn(login: login, sentence: login.map { "Signed in to GitHub as \($0)." } ?? "Signed in to GitHub.")
      case .useToken:
        self.useToken()
      case .cancelled:
        break
      }
    }
    s.present(on: window)
  }

  /** Use a token instead…: milestone 1's token sheet (ConnectGitHubSheet), for a Mac where GitHub's tool cannot run. */
  @objc func useToken() {
    guard !busy, !ended, connect == nil, signIn == nil else { return }
    let c = ConnectGitHubSheet()
    connect = c
    c.onEnd = { [weak self] login, sentence in
      guard let self = self else { return }
      self.connect = nil
      guard let login = login, !self.ended else { return }
      self.signedIn(login: login, sentence: sentence)
    }
    c.present(on: window)
  }

  /**
   * GitHub is signed in, or a token connected. The list loads again; after a clone GitHub refused (`auth`), the clone is
   * tried again at once. Both are for https, so a github.com address over ssh is tried in its https form, which the
   * address field then shows; so is one refused for this Mac's SSH key (`ssh`).
   */
  private func signedIn(login: String?, sentence: String) {
    connected = true
    if let login = login { self.login = login }
    let a = address.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let https = CloneAddress.githubHTTPS(a)
    let again = lastFailure == "auth" || (lastFailure == "ssh" && https != nil)
    loadRepos()
    if again, !a.isEmpty {
      if let https = https { address.stringValue = https }
      startClone(https ?? a, saying: visible(sentence))
    } else {
      clearMessage()
      message.stringValue = visible(sentence)
    }
  }
}

/**
 * Sign in to GitHub…: GitHub's own command-line tool, gh, signs the person in, through Workbench's `--github-signin`,
 * which first gets gh from GitHub's releases when this Mac has none. Its `WORKBENCH_GITHUB {"phase",…}` lines drive the
 * sheet, in whatever order they come:
 * - `installing`: "Getting GitHub’s command-line tool…";
 * - `code` (with `code` and `url`): "Your code: ABCD-1234", and Open GitHub, which copies the code and opens the page;
 *   the run goes on until gh is done, and its `done` line (after git is set up to use gh) is waited for;
 * - `terminal`: Terminal is open on the sign-in, since it could not run without it. Whether or not the run goes on,
 *   `--github-status` is asked every 3 seconds, one at a time, for 10 minutes at most, and a sign-in through gh ends it;
 * - `done` (with `login`), or `error` (with `sentence`).
 * A run that ends without `done` or `error` is checked once with `--github-status`. gh keeps the sign-in: Workbench
 * never sees the token. "Use a token instead…" ends the sheet and opens the token sheet.
 */
final class SignInGitHubSheet: NSObject {
  enum Outcome { case signedIn(login: String?), useToken, cancelled }
  private enum Phase { case starting, installing, code, terminal, done, failed }
  /// Where GitHub's device sign-in is; a `code` line's `url` is opened only when it is a page on https://github.com.
  static let devicePage = URL(string: "https://github.com/login/device")!

  let window: NSWindow
  private let codeRow = NSStackView()
  private let codeText = NSTextField(labelWithString: "")
  private let openButton = NSButton(title: "Open GitHub", target: nil, action: nil)
  private let spinner = NSProgressIndicator()
  private let status = NSTextField(wrappingLabelWithString: "")
  private let tokenLink = CloneSheet.link("Use a token instead…")
  private let cancelButton = NSButton(title: "Cancel", target: nil, action: nil)
  private let againButton = NSButton(title: "Try Again", target: nil, action: nil)
  private var phase = Phase.starting
  private var run: HelperStream?
  private var code = ""
  private var page = SignInGitHubSheet.devicePage
  private var generation = 0          // one per try: a timer, a poll or a line from an earlier try is not heard
  private var heard = false           // this try printed a WORKBENCH_GITHUB line
  private var ended = false
  /// Called once, when the sheet goes.
  var onEnd: ((Outcome) -> Void)?

  override init() {
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 260), styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    super.init()
    let title = NSTextField(labelWithString: "Sign in to GitHub")
    title.font = NSFont.systemFont(ofSize: 15, weight: .semibold)
    let about = NSTextField(wrappingLabelWithString: "GitHub’s own command-line tool signs you in, and keeps the sign-in itself. Git in Terminal, Workbench and your agents then use it.")
    about.preferredMaxLayoutWidth = 420
    let codeLabel = NSTextField(labelWithString: "Your code:")
    codeText.font = NSFont.monospacedSystemFont(ofSize: 20, weight: .semibold)
    codeText.isSelectable = true
    openButton.target = self
    openButton.action = #selector(openGitHub)
    codeRow.setViews([codeLabel, codeText], in: .leading)
    codeRow.setViews([openButton], in: .trailing)
    codeRow.alignment = .centerY
    codeRow.spacing = 8
    codeRow.isHidden = true
    spinner.style = .spinning
    spinner.controlSize = .small
    spinner.isDisplayedWhenStopped = false
    status.preferredMaxLayoutWidth = 390
    status.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let statusRow = NSStackView(views: [spinner, status])
    statusRow.spacing = 6
    statusRow.alignment = .centerY
    tokenLink.target = self
    tokenLink.action = #selector(useToken)
    cancelButton.target = self
    cancelButton.action = #selector(cancel)
    cancelButton.keyEquivalent = "\u{1b}"
    againButton.target = self
    againButton.action = #selector(tryAgain)
    let buttons = NSStackView()
    buttons.setViews([tokenLink], in: .leading)
    buttons.setViews([cancelButton, againButton], in: .trailing)
    buttons.spacing = 8
    let stack = NSStackView(views: [title, about, codeRow, statusRow, buttons])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 10
    stack.detachesHiddenViews = false    // the sheet keeps its size from one step to the next
    stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
    stack.setCustomSpacing(14, after: about)
    stack.translatesAutoresizingMaskIntoConstraints = false
    let content = NSView()
    content.addSubview(stack)
    var constraints = [
      stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      stack.topAnchor.constraint(equalTo: content.topAnchor),
      stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
      stack.widthAnchor.constraint(equalToConstant: 460),
      codeRow.heightAnchor.constraint(greaterThanOrEqualToConstant: 32),
      statusRow.heightAnchor.constraint(greaterThanOrEqualToConstant: 50),   // three lines of words
    ]
    for v in [about, codeRow, statusRow, buttons] as [NSView] {
      constraints.append(v.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40))
    }
    NSLayoutConstraint.activate(constraints)
    window.contentView = content
    content.layoutSubtreeIfNeeded()
    window.setContentSize(content.fittingSize)
  }

  func present(on parent: NSWindow) {
    window.appearance = parent.appearance
    parent.beginSheet(window) { _ in }
    begin()
  }

  /** The sheet goes without a sign-in (the clone sheet went, or the app quits). */
  func end() { close(.cancelled) }

  private func close(_ outcome: Outcome) {
    guard !ended else { return }
    ended = true
    generation += 1
    run?.stop()
    run = nil
    spinner.stopAnimation(nil)
    if let parent = window.sheetParent { parent.endSheet(window) } else { window.orderOut(nil) }
    let done = onEnd
    onEnd = nil
    done?(outcome)
  }

  @objc func cancel() { close(.cancelled) }

  @objc func useToken() { close(.useToken) }

  @objc func tryAgain() {
    guard !ended, phase == .failed else { return }
    begin()
  }

  /**
   * Open GitHub: the code goes on the clipboard, and GitHub's page opens in the browser, to paste it in. Only a code of
   * plain letters, digits and signs (like WDJB-MJHT) is copied.
   */
  @objc func openGitHub() {
    guard !ended, phase == .code, !code.isEmpty else { return }
    if code.unicodeScalars.allSatisfy({ $0.value > 0x20 && $0.value < 0x7F }) {
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(code, forType: .string)
    }
    NSWorkspace.shared.open(page)
  }

  // MARK: a try

  /** A try: `--github-signin`, its lines answered as they come. */
  private func begin() {
    run?.stop()
    generation += 1
    let gen = generation
    heard = false
    code = ""
    page = SignInGitHubSheet.devicePage
    show(.starting, "Starting the sign-in…")
    limit(120, "The sign-in did not start within 2 minutes.")
    let r = HelperStream(["--github-signin"])
    r.onLine = { [weak self] line in
      guard let self = self, gen == self.generation, !self.ended else { return }
      self.take(line)
    }
    r.onExit = { [weak self] status in
      guard let self = self, gen == self.generation, !self.ended else { return }
      self.run = nil
      self.exited(status)
    }
    run = r
    if !r.start() {
      run = nil
      failed("Workbench could not start the sign-in. View → Show Log says why.")
    }
  }

  private func take(_ line: String) {
    guard let o = payload(line, "WORKBENCH_GITHUB") as? [String: Any], let step = o["phase"] as? String else { return }
    heard = true
    let sentence = (o["sentence"] as? String).flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
    switch step {
    case "installing":
      guard phase == .starting || phase == .installing else { return }
      show(.installing, sentence ?? "Getting GitHub’s command-line tool…")
      limit(600, "Getting GitHub’s command-line tool took more than 10 minutes. Check this Mac’s internet connection, then try again.")
    case "code":
      guard phase == .starting || phase == .installing || phase == .code,
            let c = (o["code"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !c.isEmpty else { return }
      code = String(c.prefix(32))
      page = SignInGitHubSheet.githubPage(o["url"] as? String)
      codeText.stringValue = visible(code)
      show(.code, "Open GitHub copies the code and opens GitHub’s page: paste it there, and approve the sign-in.")
      limit(16 * 60, "The code has expired. Try again for a new one.")
    case "terminal":
      guard phase != .terminal, phase != .done, phase != .failed else { return }
      show(.terminal, sentence ?? "Terminal is open: follow the steps there, then come back here.")
      let gen = generation
      let deadline = Date().addingTimeInterval(600)
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.poll(gen, until: deadline) }
    case "done":
      guard phase != .done, phase != .failed else { return }
      signedIn((o["login"] as? String).flatMap { $0.isEmpty ? nil : $0 }, settle: phase == .terminal)
    case "error":
      guard phase != .done, phase != .failed else { return }
      failed(sentence ?? "Workbench could not sign you in to GitHub.")
    default:
      break
    }
  }

  /** The run ended without `done` or `error`. After Terminal, the polls go on; otherwise Workbench is asked once. */
  private func exited(_ status: Int32) {
    switch phase {
    case .terminal, .done, .failed:
      return
    case .starting where !heard:
      failed("Workbench could not start the sign-in. View → Show Log says why.")
    case .starting, .installing, .code:
      let gen = generation
      show(phase, "Checking the sign-in…")
      Helper.githubStatus { [weak self] s in
        guard let self = self, gen == self.generation, !self.ended, self.phase != .done, self.phase != .failed else { return }
        if let s = s, s.signedIn, s.via == nil || s.via == "gh" {
          self.signedIn(s.login, settle: false)
        } else {
          self.failed("The sign-in did not finish.")
        }
      }
    }
  }

  /**
   * After Terminal: `--github-status` every 3 seconds, one at a time, until it says signed in through gh, or `deadline`.
   * A sign-in through a token Workbench keeps (`via: token`) does not count: it was there before.
   */
  private func poll(_ gen: Int, until deadline: Date) {
    guard gen == generation, !ended, phase == .terminal else { return }
    guard Date() < deadline else {
      Log.shared.write("--github-signin: no sign-in in Terminal within 10 minutes")
      failed("The sign-in in Terminal did not finish within 10 minutes.")
      return
    }
    Helper.githubStatus(quiet: true) { [weak self] s in
      guard let self = self, gen == self.generation, !self.ended, self.phase == .terminal else { return }
      if let s = s, s.signedIn, s.via == nil || s.via == "gh" {
        self.signedIn(s.login, settle: true)
        return
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.poll(gen, until: deadline) }
    }
  }

  /**
   * Signed in. After Terminal, the sheet stays two seconds more: Terminal's second step, which makes git use gh, runs
   * right after the sign-in that was seen.
   */
  private func signedIn(_ login: String?, settle: Bool) {
    show(.done, login.map { "Signed in to GitHub as \($0)." } ?? "Signed in to GitHub.")
    guard settle else { close(.signedIn(login: login)); return }
    let gen = generation
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
      guard let self = self, gen == self.generation, !self.ended else { return }
      self.close(.signedIn(login: login))
    }
  }

  private func failed(_ sentence: String) {
    generation += 1      // this try's timers, polls and lines are not heard any more
    run?.stop()
    run = nil
    show(.failed, sentence)
  }

  /** Past `seconds` in the step it was set in, the try stops, with this sentence. */
  private func limit(_ seconds: TimeInterval, _ sentence: String) {
    let gen = generation
    let at = phase
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
      guard let self = self, gen == self.generation, !self.ended, self.phase == at else { return }
      Log.shared.write("--github-signin: stopped after \(Int(seconds)) s without the next step")
      self.failed(sentence)
    }
  }

  private func show(_ p: Phase, _ words: String) {
    guard !ended else { return }
    phase = p
    status.stringValue = visible(words)
    let waiting = p == .starting || p == .installing || p == .code || p == .terminal
    if waiting { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
    codeRow.isHidden = p != .code
    againButton.isHidden = p != .failed
    tokenLink.isHidden = p == .done
    openButton.keyEquivalent = p == .code ? "\r" : ""
    againButton.keyEquivalent = p == .failed ? "\r" : ""
  }

  /** A `code` line's address when it is a page on https://github.com, else GitHub's device sign-in page. */
  static func githubPage(_ s: String?) -> URL {
    guard let s = s, let u = URL(string: s), u.scheme?.lowercased() == "https", u.host?.lowercased() == "github.com",
          u.user == nil, u.password == nil, u.port == nil else { return devicePage }
    return u
  }
}

/**
 * Use a token instead…: a token from the person's GitHub account, given to Workbench (`--connect-github`, with the
 * token on its standard input), milestone 1's way, for a Mac where GitHub's own tool cannot run. Workbench checks it
 * with GitHub, keeps it in the login keychain, and gives it to git for github.com. The field is emptied as the token is
 * sent, and the app keeps no copy of it.
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
