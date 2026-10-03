//! Fetches a URL within one deadline over HTTP/1.1: retries with backoff, reads the body, extracts the
//! links.
const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const http_lib = @import("http");
const html = @import("html");
const Links = @import("Links.zig");
const urls = @import("urls.zig");
const Page = @import("Page.zig");
const retry = @import("retries.zig");
const Http = @import("Http.zig");
const Throttle = @import("Throttle.zig");
const Failure = @import("failure.zig").Failure;
const Fetcher = @This();

io: Io,
timeout: Io.Duration,
throttle: *Throttle,
http: Http,

const Attempt = struct { page: Page, retry: ?u64 };

/// Fetches `url`, retrying up to `retries.max_retries` times while the deadline allows.
pub fn fetch(self: Fetcher, arena: Allocator, url: []const u8) Page {
    if (!self.throttle.start(self.io, null)) return .failed(url, null, .timeout);
    const deadline = Io.Clock.Timestamp.fromNow(self.io, .{ .raw = self.timeout, .clock = .awake });
    var retries: u32 = 0;
    while (true) : (retries += 1) {
        const attempt_result = self.attempt(arena, url, deadline, retries);
        const remaining = deadline.durationFromNow(self.io).raw.nanoseconds;
        if (remaining <= 0 and attempt_result.page.isFailure()) return .failed(url, null, .timeout);
        const wait_time = attempt_result.retry orelse return attempt_result.page;
        if (remaining <= wait_time) return attempt_result.page;
        if (!self.throttle.retry(self.io, wait_time, deadline)) return attempt_result.page;
        if (deadline.durationFromNow(self.io).raw.nanoseconds <= 0) return attempt_result.page;
    }
}

fn attempt(self: Fetcher, arena: Allocator, url: []const u8, deadline: Io.Clock.Timestamp, retries: u32) Attempt {
    var resp: Http.Response = .{};
    defer resp.close();
    self.http.get(&resp, url, deadline) catch |err| {
        const status = resp.status();
        const failure: Failure = .of(err);
        return .{ .page = .failed(url, if (status == 0) null else status, failure), .retry = retry.afterFailure(self.io, failure, status, retries) };
    };
    const status = resp.status();
    const decision = if (retry.retryable(status))
        retry.afterStatus(self.io, status, resp.retryAfterSeconds(), retries)
    else
        null;
    if (decision != null) {
        resp.skipBody();
        return .{ .page = .response(url, status, &.{}), .retry = decision };
    }
    const found = links(arena, url, &resp) catch |err| return .{ .page = .failed(url, status, .of(err)), .retry = decision };
    return .{ .page = .response(url, status, found), .retry = decision };
}

fn links(arena: Allocator, url: []const u8, resp: *Http.Response) ![]const []const u8 {
    const status = resp.status();
    if (wantsBody(status, resp.contentType())) {
        var found: Links = .init(arena, url);
        defer found.deinit();
        try resp.body(arena, &found);
        return found.end();
    }
    defer resp.skipBody();
    if (status / 100 != 3) return &.{};
    const header = resp.location() orelse return &.{};
    if (header.len == 0) return &.{};
    const decoded = http_lib.latin1(arena, header) catch header;
    return location(arena, url, decoded);
}

fn location(arena: Allocator, page: []const u8, header: []const u8) ![]const []const u8 {
    const target = (try urls.resolve(arena, page, header)) orelse return &.{};
    return arena.dupe([]const u8, &.{target});
}

fn wantsBody(status: u16, content_type: ?[]const u8) bool {
    return status / 100 == 2 and status != 204 and html.isHtml(content_type);
}
