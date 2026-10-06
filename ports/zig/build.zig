const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = withAesNi(b, b.standardTargetOptions(.{}));
    // The crawler is built with -Doptimize=ReleaseFast, and main.zig's panic handler turns
    // anything that still trips into one line and exit 1. The tests run with every safety check on.
    const optimize = b.standardOptimizeOption(.{});

    b.installArtifact(b.addExecutable(.{ .name = "crawler", .root_module = module(b, target, optimize) }));

    const run_tests = b.addRunArtifact(b.addTest(.{ .root_module = module(b, target, .Debug) }));
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_tests.step);
}

/// An x86-64 target with AVX2 (x86-64-v3 and up) gains AES-NI and PCLMULQDQ: no microarchitecture level includes
/// them, yet every CPU with AVX2 has both (Haswell, Zen 1 and later), and std.crypto picks its cipher suites and
/// its AES and GHASH at compile time. Without them a TLS crawl runs software ChaCha20-Poly1305: 14,900
/// instructions a KB received against 2,840 with AES-GCM on AES-NI. SHA-NI stays off: Intel's client cores
/// before Ice Lake lack it, and valgrind cannot run it.
fn withAesNi(b: *std.Build, target: std.Build.ResolvedTarget) std.Build.ResolvedTarget {
    const x86 = std.Target.x86;
    if (target.result.cpu.arch != .x86_64 or !x86.featureSetHas(target.result.cpu.features, .avx2)) return target;
    if (x86.featureSetHasAll(target.result.cpu.features, .{ .aes, .pclmul })) return target;
    var query = target.query;
    query.cpu_features_add.addFeature(@intFromEnum(x86.Feature.aes));
    query.cpu_features_add.addFeature(@intFromEnum(x86.Feature.pclmul));
    return b.resolveTargetQuery(query);
}

fn module(b: *std.Build, target: std.Build.ResolvedTarget, optimize: std.builtin.OptimizeMode) *std.Build.Module {
    const root = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .strip = optimize != .Debug,
        .link_libc = false,
    });
    const version = b.build_root.handle.readFileAlloc(b.graph.io, ".zig-cache/version.txt", b.allocator, .limited(4096)) catch "crawl dev (zig, dev, zig)\n";
    const options = b.addOptions();
    options.addOption([]const u8, "version", version);
    root.addOptions("build_options", options);
    inline for (.{ "certs", "cli", "collections", "hashing", "html", "http", "pacing", "signals", "tls", "whatwg-url", "workers" }) |name| {
        root.addImport(name, b.dependency(name, .{ .target = target, .optimize = optimize }).module(name));
    }
    return root;
}
