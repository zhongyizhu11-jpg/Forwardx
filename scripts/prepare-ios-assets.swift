// Build-time conversion of the existing ForwardX icon; no external asset service.
import AppKit
import Foundation

let root = URL(fileURLWithPath: CommandLine.arguments[1])
let source = root.appendingPathComponent("client/public/favicon.png")
guard let image = NSImage(contentsOf: source),
      let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024,
          pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 3,
          hasAlpha: false, isPlanar: false, colorSpaceName: .deviceRGB,
          bytesPerRow: 0, bitsPerPixel: 0),
      let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fatalError("Cannot load or render the ForwardX icon")
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
let rect = NSRect(x: 0, y: 0, width: 1024, height: 1024)
NSColor.white.setFill()
rect.fill()
context.imageInterpolation = .high
image.draw(in: rect)
NSGraphicsContext.restoreGraphicsState()
guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Cannot encode the ForwardX icon")
}
try png.write(to: root.appendingPathComponent(
    "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"))
