// Draws Workbench's app icon (the board: copper traces into the core, its lid, the workbench diamond, and the git chip)
// and writes the PNGs of a macOS .iconset into the folder given as the first argument.
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.iconset", isDirectory: true)
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func color(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
  CGColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: a)
}

func draw(_ ctx: CGContext, _ S: CGFloat) {
  let u = S / 1024
  // the board: a rounded square inside the icon grid, deep green
  let board = CGRect(x: 100 * u, y: 100 * u, width: 824 * u, height: 824 * u)
  let path = CGPath(roundedRect: board, cornerWidth: 185 * u, cornerHeight: 185 * u, transform: nil)
  ctx.saveGState()
  ctx.addPath(path); ctx.clip()
  let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [color(0x1f5a40), color(0x123526)] as CFArray, locations: [0, 1])!
  ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: board.maxY), end: CGPoint(x: 0, y: board.minY), options: [])
  // copper traces into the core, with 45° bends
  ctx.setStrokeColor(color(0x4fa576, 0.9)); ctx.setLineWidth(14 * u); ctx.setLineCap(.round); ctx.setLineJoin(.round)
  let traces: [[CGPoint]] = [
    [CGPoint(x: 160, y: 700), CGPoint(x: 300, y: 700), CGPoint(x: 360, y: 640)],
    [CGPoint(x: 160, y: 470), CGPoint(x: 360, y: 470)],
    [CGPoint(x: 864, y: 720), CGPoint(x: 730, y: 720), CGPoint(x: 664, y: 654)],
    [CGPoint(x: 864, y: 500), CGPoint(x: 664, y: 500)],
  ]
  for t in traces {
    ctx.beginPath(); ctx.move(to: CGPoint(x: t[0].x * u, y: t[0].y * u))
    for p in t.dropFirst() { ctx.addLine(to: CGPoint(x: p.x * u, y: p.y * u)) }
    ctx.strokePath()
  }
  // the git chip under the core, and its bus
  ctx.setStrokeColor(color(0x4fa576, 0.9)); ctx.setLineWidth(6 * u)
  for i in 0..<6 { let x = (452 + CGFloat(i) * 24) * u; ctx.beginPath(); ctx.move(to: CGPoint(x: x, y: 352 * u)); ctx.addLine(to: CGPoint(x: x, y: 300 * u)); ctx.strokePath() }
  let chip = CGRect(x: 392 * u, y: 222 * u, width: 240 * u, height: 82 * u)
  ctx.setFillColor(color(0x1b1d1c)); ctx.fill(chip)
  ctx.setFillColor(color(0xbfc4c0, 0.9))
  for i in 0..<10 { let x = (404 + CGFloat(i) * 22) * u; ctx.fill(CGRect(x: x, y: 304 * u, width: 8 * u, height: 12 * u)); ctx.fill(CGRect(x: x, y: 210 * u, width: 8 * u, height: 12 * u)) }
  let git = NSAttributedString(string: "git", attributes: [
    .font: NSFont.monospacedSystemFont(ofSize: 52 * u, weight: .bold),
    .foregroundColor: NSColor(calibratedWhite: 0.92, alpha: 1)])
  let gs = git.size()
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
  git.draw(at: NSPoint(x: chip.midX - gs.width / 2, y: chip.midY - gs.height / 2 + 2 * u))
  NSGraphicsContext.restoreGraphicsState()
  // the core: a dark package, a ring of gold balls, the light lid
  let core = CGRect(x: 352 * u, y: 352 * u, width: 320 * u, height: 320 * u)
  ctx.setFillColor(color(0x101412)); ctx.fill(core)
  ctx.setFillColor(color(0xd2a650))
  let n = 9
  for i in 0..<n {
    let t = (CGFloat(i) + 0.5) / CGFloat(n)
    for p in [CGPoint(x: core.minX + t * core.width, y: core.minY + 14 * u), CGPoint(x: core.minX + t * core.width, y: core.maxY - 14 * u),
              CGPoint(x: core.minX + 14 * u, y: core.minY + t * core.height), CGPoint(x: core.maxX - 14 * u, y: core.minY + t * core.height)] {
      ctx.fillEllipse(in: CGRect(x: p.x - 7 * u, y: p.y - 7 * u, width: 14 * u, height: 14 * u))
    }
  }
  let lid = core.insetBy(dx: 38 * u, dy: 38 * u)
  ctx.setFillColor(color(0xe9e6dc)); ctx.fill(lid)
  // the workbench mark: a diamond on the lid
  ctx.setFillColor(color(0x1a1d1b))
  ctx.beginPath()
  ctx.move(to: CGPoint(x: lid.midX, y: lid.midY + 70 * u)); ctx.addLine(to: CGPoint(x: lid.midX + 70 * u, y: lid.midY))
  ctx.addLine(to: CGPoint(x: lid.midX, y: lid.midY - 70 * u)); ctx.addLine(to: CGPoint(x: lid.midX - 70 * u, y: lid.midY))
  ctx.closePath(); ctx.fillPath()
  ctx.restoreGState()
}

for (name, px) in [("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64), ("icon_128x128", 128),
                   ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512), ("icon_512x512", 512), ("icon_512x512@2x", 1024)] {
  let S = CGFloat(px)
  guard let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { continue }
  draw(ctx, S)
  guard let image = ctx.makeImage() else { continue }
  let rep = NSBitmapImageRep(cgImage: image)
  try rep.representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent("\(name).png"))
}
