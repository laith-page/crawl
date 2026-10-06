//! Fetches a URL within one deadline over HTTP/1.1: retries with backoff, reads the body, extracts the
//! links.
const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const http = @import("http");
const html = @import("html");
const pacing = @import("pacing");
const Pacer = pacing.Pacer;
const Links = @import("Links.zig");
const urls = @import("urls.zig");
const Page = @import("Page.zig");
const retry = @import("retries.zig");
const Failure = @import("failure.zig").Failure;
const Fetcher = @This();

pub const max_body_bytes: usize = 5 << 20;
pub const drain_limit_bytes = 64 << 10;

io: Io,
timeout: Io.Duration,
pacer: *Pacer,
shared_retries: bool,
client: *http.Client,

const Attempt = struct { page: Page, retry: ?Io.Duration };

fn waitToRetry(self: Fetcher, wait: Io.Duration, deadline: Io.Clock.Timestamp) bool {
    if (self.shared_retries) {
        self.pacer.postpone(self.io, wait);
        self.pacer.acquire(self.io, deadline) catch return false;
        return true;
    }
    if (deadline.durationFromNow(self.io).raw.nanoseconds <= wait.nanoseconds) return false;
    self.io.sleep(wait, .awake) catch return false;
    return true;
}

/// Fetches `url`, retrying up to `retries.max_retries` times while the deadline allows.
pub fn fetch(self: Fetcher, arena: Allocator, url: []const u8) Page {
    self.pacer.acquire(self.io, null) catch return .failed(url, null, .timeout);
    const deadline = Io.Clock.Timestamp.fromNow(self.io, .{ .raw = self.timeout, .clock = .awake });
    var retries: u32 = 0;
    while (true) : (retries += 1) {
        const attempt_result = self.attempt(arena, url, deadline, retries);
        const wait_time = attempt_result.retry orelse return attempt_result.page;
        const remaining = deadline.durationFromNow(self.io).raw.nanoseconds;
        if (remaining <= wait_time.nanoseconds) return attempt_result.page;
        if (!self.waitToRetry(wait_time, deadline)) return attempt_result.page;
        if (deadline.durationFromNow(self.io).raw.nanoseconds <= 0) return attempt_result.page;
    }
}

fn attempt(self: Fetcher, arena: Allocator, url: []const u8, deadline: Io.Clock.Timestamp, retries: u32) Attempt {
    var response = self.client.get(url, .{ .deadline = deadline }) catch |err| {
        const failure: Failure = .of(http.kindOf(self.io, err, deadline));
        return .{ .page = .failed(url, null, failure), .retry = retry.afterFailure(self.io, failure, retries) };
    };
    defer response.close();
    const status = response.status();
    const wait = retry.afterStatus(self.io, status, response.retryAfter(), retries);
    if (wait) |w| {
        response.discard(drain_limit_bytes);
        return .{ .page = .response(url, status, &.{}), .retry = w };
    }
    const found = links(arena, url, &response) catch |err|
        return .{ .page = .failed(url, status, .of(http.kindOf(self.io, err, deadline))), .retry = null };
    return .{ .page = .response(url, status, found), .retry = null };
}

fn links(arena: Allocator, url: []const u8, response: *http.Response) ![]const []const u8 {
    const status = response.status();
    if (wantsBody(status, response)) {
        var found: Links = .init(arena, url);
        defer found.deinit();
        const body = try response.body(arena, .{ .decode = true, .limit = max_body_bytes });
        while (try body.next()) |chunk| try found.feed(chunk);
        return found.end();
    }
    defer response.discard(drain_limit_bytes);
    if (status / 100 != 3) return &.{};
    const target = (try response.location(arena)) orelse return &.{};
    return location(arena, url, target);
}

fn location(arena: Allocator, page: []const u8, header: []const u8) ![]const []const u8 {
    const target = (try urls.resolve(arena, page, header)) orelse return &.{};
    return arena.dupe([]const u8, &.{target});
}

fn wantsBody(status: u16, response: *const http.Response) bool {
    return status / 100 == 2 and status != 204 and html.isHtml(response.contentType());
}
