// Headless build-time conversion of the existing icon; no WindowServer required.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let root = URL(fileURLWithPath: CommandLine.arguments[1])
let source = root.appendingPathComponent("client/public/favicon.png")
guard let input = CGImageSourceCreateWithURL(source as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(input, 0, nil) else {
    fatalError("Cannot load ForwardX icon: \(source.path)")
}
guard let context = CGContext(data: nil, width: 1024, height: 1024,
    bitsPerComponent: 8, bytesPerRow: 4096, space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
    fatalError("Cannot create opaque RGB icon context")
}
let rect = CGRect(x: 0, y: 0, width: 1024, height: 1024)
context.setFillColor(CGColor(gray: 1, alpha: 1))
context.fill(rect)
context.interpolationQuality = .high
context.draw(image, in: rect)
let output = root.appendingPathComponent(
    "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png")
guard let rendered = context.makeImage(),
      let destination = CGImageDestinationCreateWithURL(output as CFURL,
          UTType.png.identifier as CFString, 1, nil) else {
    fatalError("Cannot create PNG output")
}
CGImageDestinationAddImage(destination, rendered, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("Cannot save PNG icon") }
