// Generate lightweight JPEG poster frames for the homepage publication videos.
//
// Posters are what visitors see immediately (and what slow / data-saver
// connections keep seeing) while the MP4 itself is lazy-loaded on scroll.
// Uses only macOS's built-in AVFoundation -- no ffmpeg needed.
//
// Usage (from the repo root, macOS):
//   swift scripts/make_video_posters.swift                 # all videos in images/publications
//   swift scripts/make_video_posters.swift path/to/a.mp4   # specific videos
//
// Writes <name>.jpg next to each <name>.mp4 (first frame, max 640px wide).

import AVFoundation
import AppKit

let maxWidth: CGFloat = 640
let quality: Double = 0.6

var inputs = Array(CommandLine.arguments.dropFirst())
if inputs.isEmpty {
    let dir = "images/publications"
    let names = (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
    inputs = names.filter { $0.hasSuffix(".mp4") }.sorted().map { "\(dir)/\($0)" }
}
if inputs.isEmpty {
    FileHandle.standardError.write("no .mp4 files found (run from the repo root)\n".data(using: .utf8)!)
    exit(1)
}

for path in inputs {
    let url = URL(fileURLWithPath: path)
    let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
    generator.appliesPreferredTrackTransform = true
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    generator.maximumSize = CGSize(width: maxWidth, height: maxWidth)
    do {
        let frame = try generator.copyCGImage(at: .zero, actualTime: nil)
        let rep = NSBitmapImageRep(cgImage: frame)
        guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: quality]) else {
            throw NSError(domain: "poster", code: 1)
        }
        let out = url.deletingPathExtension().appendingPathExtension("jpg")
        try jpeg.write(to: out)
        print("\(out.path)  \(frame.width)x\(frame.height)  \(jpeg.count / 1024) KB")
    } catch {
        FileHandle.standardError.write("failed: \(path): \(error)\n".data(using: .utf8)!)
        exit(1)
    }
}
