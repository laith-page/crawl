//! The trust store: system CAs, or SSL_CERT_FILE when set (DESIGN §1).
const std = @import("std");
const certs = @import("certs");
const TlsConnection = @import("tls").Connection;
const http = @import("http");
const Io = std.Io;
const Tls = @This();

gpa: std.mem.Allocator,
io: Io,
cert_file: ?[]const u8,
lock: Io.RwLock = .init,
bundle: std.crypto.Certificate.Bundle = .empty,
now: ?Io.Timestamp = null,

pub fn deinit(self: *Tls) void {
    self.bundle.deinit(self.gpa);
}

pub fn connect(self: *Tls, stream: Io.net.Stream, host: Io.net.HostName) !*TlsConnection {
    errdefer stream.close(self.io);
    try self.load();
    return TlsConnection.init(self.gpa, self.io, stream, .{
        .host = .{ .explicit = host.bytes },
        .ca = .{ .bundle = .{ .gpa = self.gpa, .io = self.io, .lock = &self.lock, .bundle = &self.bundle } },
        .realtime_now = self.now.?,
        // Servers often close without close_notify; framing (Content-Length/chunked) catches a cut body, and a close-delimited body is taken as sent.
        .allow_truncation_attacks = true,
    }) catch |err| if (err == error.Canceled) err else error.TlsInitializationFailed;
}

pub fn hook(self: *Tls) http.Client.TlsHook {
    return .{ .context = self, .connect = connectTransport };
}

fn connectTransport(context: *anyopaque, stream: Io.net.Stream, host: Io.net.HostName) anyerror!http.Client.Transport {
    const self: *Tls = @ptrCast(@alignCast(context));
    return .of(try self.connect(stream, host));
}

fn load(self: *Tls) !void {
    try self.lock.lock(self.io);
    defer self.lock.unlock(self.io);
    if (self.now != null) return;
    self.now = Io.Clock.real.now(self.io);
    try certs.loadBundle(self.gpa, self.io, self.cert_file, &self.bundle);
}
