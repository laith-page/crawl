//! The crawler's headers and body limit over the generic HTTP client.
const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const http = @import("http");
const Links = @import("Links.zig");
const Tls = @import("Tls.zig");
const Http = @This();

client: *http.Client,
tls: *Tls,
fields: [3]http.Client.Field,

/// Bodies longer are refused: `body over 5 MiB` (DESIGN §1).
pub const max_body_bytes: usize = 5 << 20;
/// Longest body drained so its connection can be reused.
pub const drain_limit_bytes = 64 << 10;

pub fn init(client: *http.Client, tls: *Tls, user_agent: []const u8) Http {
    return .{ .client = client, .tls = tls, .fields = .{ .{ .name = "User-Agent", .value = user_agent }, .{ .name = "Accept", .value = "*/*" }, .{ .name = "Accept-Encoding", .value = "gzip, deflate" } } };
}

/// One response on its connection.
pub const Response = struct {
    inner: ?http.Client.Response = null,

    pub fn status(self: *const Response) u16 {
        return if (self.inner) |response| response.status() else 0;
    }
    pub fn contentType(self: *const Response) ?[]const u8 {
        return self.inner.?.header("content-type");
    }
    pub fn location(self: *const Response) ?[]const u8 {
        return self.inner.?.header("location");
    }
    pub fn retryAfterSeconds(self: *const Response) ?u64 {
        const value = self.inner.?.header("retry-after") orelse return null;
        if (value.len == 0) return null;
        for (value) |char| {
            if (!std.ascii.isDigit(char)) return null;
        }
        return std.fmt.parseInt(u64, value, 10) catch std.math.maxInt(u64);
    }

    /// Streams and decodes the body, up to max_body_bytes.
    pub fn body(self: *Response, arena: Allocator, links: *Links) !void {
        var response = &self.inner.?;
        const reader = try response.reader(arena, .{ .decode = true, .limit = max_body_bytes });
        while (try reader.next()) |chunk| try links.feed(chunk);
    }

    pub fn skipBody(self: *Response) void {
        self.inner.?.discardBody(drain_limit_bytes);
    }

    pub fn close(self: *Response) void {
        if (self.inner) |*response| response.close();
        self.inner = null;
    }
};

/// Sends the GET and leaves the response body for the caller.
pub fn get(self: *const Http, response: *Response, url: []const u8, deadline: Io.Clock.Timestamp) !void {
    response.inner = try self.client.get(url, .{ .deadline = deadline, .tls = self.tls.hook(), .headers = &self.fields });
}
