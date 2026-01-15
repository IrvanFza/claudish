// swift-tools-version: 5.9
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "ClaudishProxy",
    platforms: [
        .macOS(.v14)  // macOS 14+ required for MenuBarExtra
    ],
    products: [
        .executable(name: "ClaudishProxy", targets: ["ClaudishProxy"])
    ],
    dependencies: [],
    targets: [
        .executableTarget(
            name: "ClaudishProxy",
            dependencies: [],
            path: "Sources"
        )
    ]
)
