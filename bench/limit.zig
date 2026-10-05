//! Baseline: what this machine can spend on a page, with nothing between the kernel and the numbers.
//!
//! Two modes:
//!        -c N -n PAGES URL         fetch pages over keep-alive HTTP/1.1, as fast as the machine can move them.
//!                                  With --crawl it also does a crawler's per-page work: extract links, dedupe them, write out.
//!        limit                     the machine's primitives on stderr, one "name<TAB>value<TAB>unit" line each: a
//!                                  syscall, memory at each level, a loopback round trip.
//! Raw Linux syscalls throughout.
const std = @import("std");
const linux = std.os.linux;

const Counter = std.atomic.Value(u64);

/// A crawl that ran to its end, whatever it fetched: like a crawler's, the exit code says the program worked and
/// the count it prints says what it got. On a faulted site a page lost to a fault is not retried: it is counted as an
/// error, and only a 200 answer is a page.
const exit_done: u8 = 0;
const exit_bad_usage: u8 = 2;

/// The most connections (threads) a fetch run uses; a larger -c is capped to this.
const max_connections = 64;

const loopback_ip: u32 = 0x7f000001;

/// Picks the mode: no arguments measures the machine's primitives, `-c N -n PAGES URL` fetches pages.
/// The two flags are positional: they are skipped, not checked.
pub fn main(init: std.process.Init) !u8 {
    var args = init.minimal.args.iterate();
    _ = args.next();

    var crawling = false;
    var connections: usize = 1;
    var pages: u64 = 0;
    var url: ?[]const u8 = null;
    var any_arg = false;

    while (args.next()) |arg| {
        any_arg = true;
        if (std.mem.eql(u8, arg, "--crawl")) {
            crawling = true;
        } else if (std.mem.eql(u8, arg, "-c")) {
            const val = args.next() orelse return exit_bad_usage;
            connections = try std.fmt.parseInt(usize, val, 10);
        } else if (std.mem.eql(u8, arg, "-n")) {
            const val = args.next() orelse return exit_bad_usage;
            pages = try std.fmt.parseInt(u64, val, 10);
        } else if (std.mem.eql(u8, arg, "-f")) {
            // fast / quiet flag, ignore
        } else if (!std.mem.startsWith(u8, arg, "-")) {
            url = arg;
        }
    }

    if (!any_arg) {
        try printPrimitives();
        return exit_done;
    }
    const target_url = url orelse return exit_bad_usage;
    return fetchPages(init.gpa, init.io, target_url, @min(connections, max_connections), pages, crawling);
}

/// Prints one measurement as a "name<TAB>value<TAB>unit" line on stderr.
fn printRow(name: []const u8, value: f64, unit: []const u8) void {
    std.debug.print("{s}\t{d:.2}\t{s}\n", .{ name, value, unit });
}

/// The monotonic clock, in nanoseconds.
fn nowNs() u64 {
    var ts: linux.timespec = undefined;
    _ = linux.clock_gettime(.MONOTONIC, &ts);
    return @as(u64, @intCast(ts.sec)) * std.time.ns_per_s + @as(u64, @intCast(ts.nsec));
}

/// Nanoseconds since `start_ns`, a reading of `nowNs`.
fn elapsedNs(start_ns: u64) u64 {
    return nowNs() - start_ns;
}

/// Nanoseconds per operation, for `ops` operations run since `start_ns`.
fn nsPerOp(start_ns: u64, ops: usize) f64 {
    return @as(f64, @floatFromInt(elapsedNs(start_ns))) / @as(f64, @floatFromInt(ops));
}

/// True if the raw syscall result `rc` is not an error.
fn succeeded(rc: usize) bool {
    return linux.errno(rc) == .SUCCESS;
}

/// Writes all of `bytes`, looping over partial writes; false if a write fails.
fn writeAll(fd: i32, bytes: []const u8) bool {
    var written: usize = 0;
    while (written < bytes.len) {
        const n = linux.write(fd, bytes[written..].ptr, bytes.len - written);
        if (!succeeded(n) or n == 0) return false;
        written += n;
    }
    return true;
}

/// Reads until `buf` is full; false if the peer closes or fails first.
fn readFull(fd: i32, buf: []u8) bool {
    var got: usize = 0;
    while (got < buf.len) {
        const n = linux.read(fd, buf[got..].ptr, buf.len - got);
        if (!succeeded(n) or n == 0) return false;
        got += n;
    }
    return true;
}

/// A new TCP socket, closed on exec.
fn openTcpSocket() !i32 {
    const rc = linux.socket(linux.AF.INET, linux.SOCK.STREAM | linux.SOCK.CLOEXEC, 0);
    return if (succeeded(rc)) @intCast(rc) else error.Socket;
}

/// 127.0.0.1 at `port` (0 lets the kernel pick one when binding).
fn loopbackAddress(port: u16) linux.sockaddr.in {
    return .{ .port = std.mem.nativeToBig(u16, port), .addr = std.mem.nativeToBig(u32, loopback_ip) };
}

/// A TCP connection to `port` on loopback, with Nagle's algorithm off so a small request is sent at once.
fn connectToLoopback(port: u16) !i32 {
    const fd = try openTcpSocket();
    errdefer _ = linux.close(fd);
    const addr = loopbackAddress(port);
    if (!succeeded(linux.connect(fd, &addr, @sizeOf(linux.sockaddr.in)))) return error.Connect;
    const enabled: i32 = 1;
    _ = linux.setsockopt(fd, linux.IPPROTO.TCP, linux.TCP.NODELAY, std.mem.asBytes(&enabled), @sizeOf(i32));
    return fd;
}

/// Measures every primitive and prints one row for each.
fn printPrimitives() !void {
    measureSyscalls();
    try measureMemory(std.heap.smp_allocator);
    try measureLoopbackRoundTrip();
}

/// The cost of one system call, and of one clock reading through the vDSO (which needs no system call).
fn measureSyscalls() void {
    const calls = 2_000_000;
    var start = nowNs();
    for (0..calls) |_| std.mem.doNotOptimizeAway(linux.getpid());
    printRow("getpid syscall", nsPerOp(start, calls), "ns");

    start = nowNs();
    for (0..calls) |_| std.mem.doNotOptimizeAway(nowNs());
    printRow("clock_gettime, monotonic (vDSO)", nsPerOp(start, calls), "ns");
}

/// Memory bandwidth for one thread, and load latency at each level of the cache hierarchy and in DRAM.
fn measureMemory(gpa: std.mem.Allocator) !void {
    try measureSequentialRead(gpa);

    var prng = std.Random.DefaultPrng.init(42);
    const rng = prng.random();
    printRow("dependent load, 16 KiB (L1)", try measureLoadLatency(gpa, rng, 16 << 10), "ns");
    printRow("dependent load, 512 KiB (L2)", try measureLoadLatency(gpa, rng, 512 << 10), "ns");
    printRow("dependent load, 8 MiB (L3)", try measureLoadLatency(gpa, rng, 8 << 20), "ns");
    printRow("dependent load, 256 MiB (DRAM)", try measureLoadLatency(gpa, rng, 256 << 20), "ns");
}

/// GiB per second of one thread summing a 256 MiB array from start to end, the access pattern the prefetcher is best at.
fn measureSequentialRead(gpa: std.mem.Allocator) !void {
    const bytes = 256 << 20;
    const words = try gpa.alloc(u64, bytes / @sizeOf(u64));
    defer gpa.free(words);
    // Written with non-zero data, so every page is really mapped before the timed read touches it.
    for (words, 0..) |*word, index| word.* = index *% 0x9E3779B97F4A7C15;

    var sum: u64 = 0;
    const start = nowNs();
    for (words) |word| sum +%= word;
    std.mem.doNotOptimizeAway(sum);

    const elapsed_ns: f64 = @floatFromInt(elapsedNs(start));
    printRow("sequential read, one thread", bytes / elapsed_ns * std.time.ns_per_s / (1 << 30), "GiB/s");
}

/// Nanoseconds per dependent load over one random cycle through `size` bytes.
///
/// Every load's address is the value the previous load returned, so the CPU cannot start the next load early and the
/// prefetcher cannot guess it: each hop waits for the level of the hierarchy that holds `size` bytes.
fn measureLoadLatency(gpa: std.mem.Allocator, rng: std.Random, size: usize) !f64 {
    const slots = size / @sizeOf(u32);
    const next = try gpa.alloc(u32, slots);
    defer gpa.free(next);
    for (next, 0..) |*link, index| link.* = @intCast(index);

    // Sattolo's shuffle: each slot swaps with a strictly earlier one, never with itself, which leaves one cycle through
    // all the slots. A plain shuffle can leave short cycles that fit in a small cache and understate the latency.
    var i = slots - 1;
    while (i > 0) : (i -= 1) std.mem.swap(u32, &next[i], &next[rng.uintLessThan(usize, i)]);

    const hops = 10_000_000;
    var slot: u32 = 0;
    const start = nowNs();
    for (0..hops) |_| slot = next[slot];
    std.mem.doNotOptimizeAway(slot);
    return nsPerOp(start, hops);
}

/// The size of the message sent back and forth by the loopback round-trip measurement.
const echo_len = 64;

/// Accepts one connection on `listener` and echoes it, `echo_len` bytes at a time, until it closes.
fn echoOneConnection(listener: i32) void {
    const rc = linux.accept4(listener, null, null, linux.SOCK.CLOEXEC);
    if (!succeeded(rc)) return;
    const conn: i32 = @intCast(rc);
    defer _ = linux.close(conn);

    var buf: [echo_len]u8 = undefined;
    while (readFull(conn, &buf)) {
        if (!writeAll(conn, &buf)) return;
    }
}

const Listener = struct {
    fd: i32,
    port: u16,
};

const listen_backlog = 16;

/// A listening TCP socket on loopback, on a port the kernel picked.
fn listenOnLoopback() !Listener {
    const fd = try openTcpSocket();
    errdefer _ = linux.close(fd);

    var addr = loopbackAddress(0);
    var addr_len: linux.socklen_t = @sizeOf(linux.sockaddr.in);
    if (!succeeded(linux.bind(fd, @ptrCast(&addr), addr_len))) return error.Bind;
    if (!succeeded(linux.listen(fd, listen_backlog))) return error.Listen;
    // Binding to port 0 made the kernel pick the port; getsockname says which.
    if (!succeeded(linux.getsockname(fd, @ptrCast(&addr), &addr_len))) return error.GetSockName;
    return .{ .fd = fd, .port = std.mem.bigToNative(u16, addr.port) };
}

/// The median time for a small message to go through loopback TCP to an echo thread and back.
fn measureLoopbackRoundTrip() !void {
    const listener = try listenOnLoopback();
    defer _ = linux.close(listener.fd);
    const echo_thread = try std.Thread.spawn(.{}, echoOneConnection, .{listener.fd});
    defer echo_thread.join();

    const fd = try connectToLoopback(listener.port);
    defer _ = linux.close(fd);

    var round_trips_ns: [20_000]u64 = undefined;
    var message = [_]u8{0} ** echo_len;
    for (&round_trips_ns) |*round_trip| {
        const start = nowNs();
        if (!writeAll(fd, &message)) return error.Echo;
        if (!readFull(fd, &message)) return error.Echo;
        round_trip.* = elapsedNs(start);
    }

    std.mem.sort(u64, &round_trips_ns, {}, std.sort.asc(u64));
    const median_ns = round_trips_ns[round_trips_ns.len / 2];
    printRow("loopback TCP round trip, 64 B, p50", @as(f64, @floatFromInt(median_ns)) / 1000, "µs");
}

const Target = struct {
    port: u16,
    before_id: []const u8,
    after_id: []const u8,
};

/// "http://127.0.0.1:8080/scale/7?x=1" as its port and the request target around the page id, the last number of
/// its path: "/scale/" and "?x=1". The limit only ever talks to loopback, so any other host is rejected.
fn parseTarget(url: []const u8) ?Target {
    // There is no resolver here, so loopback only: the harness names it, the benchmark numbers it.
    const after_host = for ([_][]const u8{ "http://127.0.0.1:", "http://localhost:" }) |prefix| {
        if (std.mem.startsWith(u8, url, prefix)) break url[prefix.len..];
    } else return null;
    const path_start = std.mem.indexOfScalar(u8, after_host, '/') orelse return null;
    const port = std.fmt.parseInt(u16, after_host[0..path_start], 10) catch return null;

    const request_target = after_host[path_start..];
    const path = request_target[0 .. std.mem.indexOfScalar(u8, request_target, '?') orelse request_target.len];

    // The page id is the last run of digits in the path; digits in the query do not count.
    var id_end = path.len;
    while (id_end > 0 and !std.ascii.isDigit(path[id_end - 1])) id_end -= 1;
    if (id_end == 0) return null;
    var id_start = id_end;
    while (id_start > 0 and std.ascii.isDigit(path[id_start - 1])) id_start -= 1;

    return .{ .port = port, .before_id = request_target[0..id_start], .after_id = request_target[id_end..] };
}

test "the page id is the last number of the path" {
    const target = parseTarget("http://127.0.0.1:8080/scale/0?links=4&limit=10") orelse return error.TestUnexpectedResult;
    try std.testing.expectEqual(@as(u16, 8080), target.port);
    try std.testing.expectEqualStrings("/scale/", target.before_id);
    try std.testing.expectEqualStrings("?links=4&limit=10", target.after_id);
}

test "loopback is taken by name as well as by number" {
    // The harness hands out http://localhost:PORT, so a limit that took only the number never ran.
    const named = parseTarget("http://localhost:8080/scale/0?links=4") orelse return error.TestUnexpectedResult;
    try std.testing.expectEqual(@as(u16, 8080), named.port);
    try std.testing.expectEqualStrings("/scale/", named.before_id);
}

test "path after the page id, and digits in the query, are kept out of the id" {
    const after_path = parseTarget("http://127.0.0.1:9/a/12/b?q=1") orelse return error.TestUnexpectedResult;
    try std.testing.expectEqualStrings("/a/", after_path.before_id);
    try std.testing.expectEqualStrings("/b?q=1", after_path.after_id);

    const in_query = parseTarget("http://127.0.0.1:9/a/5?n=99") orelse return error.TestUnexpectedResult;
    try std.testing.expectEqualStrings("/a/", in_query.before_id);
    try std.testing.expectEqualStrings("?n=99", in_query.after_id);
}

test "a url without loopback, a port, or a page id is rejected" {
    try std.testing.expect(parseTarget("http://example.com:8080/a/1") == null);
    try std.testing.expect(parseTarget("https://127.0.0.1:8080/a/1") == null);
    try std.testing.expect(parseTarget("http://127.0.0.1:99999/a/1") == null);
    try std.testing.expect(parseTarget("http://127.0.0.1:8080/none") == null);
    try std.testing.expect(parseTarget("http://127.0.0.1:8080") == null);
}

const Crawl = struct {
    target: Target,
    pages: u64,
    next_page: Counter = .init(0),
    pages_done: Counter = .init(0),
    pages_lost: Counter = .init(0),
    /// Set with --crawl.
    work: ?*Work = null,
    io: std.Io,
};

/// A crawler's per-page work, without the frontier.
const Work = struct {
    seen: Seen,
    /// "http://host:port", prefixed to root-relative links.
    origin: []const u8,
};

/// Seen links as 64-bit hashes, in a lock-free open-addressed table.
const Seen = struct {
    slots: []Counter,

    /// Sized for four links a page at half load, capped at 128 MiB (16M slots, DESIGN.md).
    fn init(gpa: std.mem.Allocator, pages: u64) !Seen {
        const wanted = try std.math.ceilPowerOfTwo(usize, @max(@as(usize, @intCast(pages)) * 8, 1024));
        const capacity = @min(wanted, 1 << 24);
        const slots = try gpa.alloc(Counter, capacity);
        for (slots) |*slot| slot.* = .init(0);
        return .{ .slots = slots };
    }

    /// Adds the hash and returns whether it was new; zero is stored as one.
    fn insert(self: *Seen, hash: u64) bool {
        const stored = if (hash == 0) 1 else hash;
        const mask = self.slots.len - 1;
        var slot: usize = @intCast(stored & mask);
        for (0..self.slots.len) |_| {
            const found = self.slots[slot].cmpxchgStrong(0, stored, .acq_rel, .acquire) orelse return true;
            if (found == stored) return false;
            slot = (slot + 1) & mask;
        }
        return false;
    }
};

test "a hash is new once, a zero hash included" {
    var seen = try Seen.init(std.testing.allocator, 1);
    defer std.testing.allocator.free(seen.slots);
    try std.testing.expect(seen.insert(42));
    try std.testing.expect(!seen.insert(42));
    try std.testing.expect(seen.insert(0));
    try std.testing.expect(!seen.insert(0));
}

/// The href values in a page, in order.
const Hrefs = struct {
    html: []const u8,
    at: usize = 0,

    fn next(self: *Hrefs) ?[]const u8 {
        const marker = "href=\"";
        const start = (std.mem.indexOfPos(u8, self.html, self.at, marker) orelse return null) + marker.len;
        const end = std.mem.indexOfScalarPos(u8, self.html, start, '"') orelse return null;
        self.at = end + 1;
        return self.html[start..end];
    }
};

test "every href is found, and nothing else" {
    var hrefs: Hrefs = .{ .html = "<a href=\"/scale/1?x\">1</a> <p>href</p> <a href=\"/scale/2\">2</a>" };
    try std.testing.expectEqualStrings("/scale/1?x", hrefs.next().?);
    try std.testing.expectEqualStrings("/scale/2", hrefs.next().?);
    try std.testing.expectEqual(@as(?[]const u8, null), hrefs.next());
}

/// Serialises output: pipe writes over PIPE_BUF can interleave.
var output_lock: std.Io.Mutex = .init;

/// Per-thread output buffer, flushed when full.
const Out = struct {
    io: std.Io,
    buffer: [64 * 1024]u8 = undefined,
    len: usize = 0,

    fn add(self: *Out, parts: []const []const u8) void {
        var need: usize = 0;
        for (parts) |part| need += part.len;
        if (self.len + need > self.buffer.len) self.flush();
        for (parts) |part| {
            const room = self.buffer.len - self.len;
            const take = @min(part.len, room);
            @memcpy(self.buffer[self.len..][0..take], part[0..take]);
            self.len += take;
        }
    }

    fn flush(self: *Out) void {
        if (self.len == 0) return;
        output_lock.lockUncancelable(self.io);
        defer output_lock.unlock(self.io);
        _ = writeAll(1, self.buffer[0..self.len]);
        self.len = 0;
    }
};

/// The value of the content-length header in `headers`.
fn contentLength(headers: []const u8) ?usize {
    const name = "content-length:";
    const name_at = std.ascii.indexOfIgnoreCase(headers, name) orelse return null;
    const after_name = headers[name_at + name.len ..];
    const line_end = std.mem.indexOf(u8, after_name, "\r\n") orelse after_name.len;
    const value = std.mem.trim(u8, after_name[0..line_end], " ");
    return std.fmt.parseInt(usize, value, 10) catch null;
}

test "content-length is found in any letter case" {
    try std.testing.expectEqual(@as(?usize, 42), contentLength("HTTP/1.1 200 OK\r\nContent-Length: 42\r\nX: y\r\n\r\n"));
    try std.testing.expectEqual(@as(?usize, 7), contentLength("HTTP/1.1 200 OK\r\ncontent-length:7\r\n\r\n"));
    try std.testing.expectEqual(@as(?usize, null), contentLength("HTTP/1.1 200 OK\r\n\r\n"));
}

const Response = struct {
    ok: bool,
    /// Empty unless the body was asked for and fits the buffer.
    body: []const u8,
};

/// Reads one response by content-length, keeping the body if asked and it fits. Null on failure.
fn readResponse(fd: i32, buffer: []u8, keep: bool) ?Response {
    var filled: usize = 0;
    const headers_len = while (true) {
        const n = linux.read(fd, buffer[filled..].ptr, buffer.len - filled);
        if (!succeeded(n) or n == 0) return null;
        filled += n;
        if (std.mem.indexOf(u8, buffer[0..filled], "\r\n\r\n")) |at| break at + 4;
    };
    const length = contentLength(buffer[0..headers_len]) orelse return null;
    const is_ok = std.mem.startsWith(u8, buffer[0..headers_len], "HTTP/1.1 200 ");

    // A kept body appends after the headers; otherwise it overwrites the buffer.
    var body_read = filled - headers_len;
    while (body_read < length) {
        const appending = keep and filled < buffer.len;
        const room = if (appending) buffer[filled..] else buffer;
        const n = linux.read(fd, room.ptr, room.len);
        if (!succeeded(n) or n == 0) return null;
        body_read += n;
        if (appending) filled += n;
    }
    const kept = keep and headers_len + length <= buffer.len;
    return .{ .ok = is_ok, .body = if (kept) buffer[headers_len .. headers_len + length] else &.{} };
}

/// Fetches on one keep-alive connection until the page ids run out (true) or the connection fails (false): a
/// hand-written GET for the next page id, then its response. A page lost to a fault is not retried.
fn fetchOnConnection(fd: i32, crawl: *Crawl, out: *Out) bool {
    var response: [16 * 1024]u8 = undefined;
    var path_buffer: [256]u8 = undefined;
    var request_buffer: [512]u8 = undefined;
    while (true) {
        const id = crawl.next_page.fetchAdd(1, .monotonic);
        if (id >= crawl.pages) return true;

        const path = std.fmt.bufPrint(&path_buffer, "{s}{d}{s}", .{ crawl.target.before_id, id, crawl.target.after_id }) catch return false;
        const request = std.fmt.bufPrint(&request_buffer, "GET {s} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", .{path}) catch return false;
        if (!writeAll(fd, request)) return false;
        const answer = readResponse(fd, &response, crawl.work != null) orelse {
            _ = crawl.pages_lost.fetchAdd(1, .monotonic);
            return false;
        };
        if (!answer.ok) {
            _ = crawl.pages_lost.fetchAdd(1, .monotonic);
            continue;
        }
        _ = crawl.pages_done.fetchAdd(1, .monotonic);
        if (crawl.work) |work| {
            out.add(&.{ work.origin, path, "\n" });
            var hrefs: Hrefs = .{ .html = answer.body };
            while (hrefs.next()) |link| {
                var hash = std.hash.Wyhash.init(0);
                if (link.len > 0 and link[0] == '/') hash.update(work.origin);
                hash.update(link);
                _ = work.seen.insert(hash.final());
            }
        }
    }
}

/// The body of one connection's thread: connect, fetch until the pages run out, and connect again if the connection
/// fails. Stops when it cannot connect.
fn fetchWorker(crawl: *Crawl) void {
    var out: Out = .{ .io = crawl.io };
    defer out.flush();
    while (true) {
        const fd = connectToLoopback(crawl.target.port) catch return;
        defer _ = linux.close(fd);
        if (fetchOnConnection(fd, crawl, &out)) return;
    }
}

/// Fetches `pages` pages of `url` over `connections` connections and prints how many arrived and how long it took.
fn fetchPages(gpa: std.mem.Allocator, io: std.Io, url: []const u8, connections: usize, pages: u64, crawling: bool) !u8 {
    const target = parseTarget(url) orelse return exit_bad_usage;
    var crawl: Crawl = .{ .target = target, .pages = pages, .io = io };
    var work: Work = undefined;
    if (crawling) {
        const scheme_end = (std.mem.indexOf(u8, url, "://") orelse return exit_bad_usage) + 3;
        const path_start = std.mem.indexOfScalarPos(u8, url, scheme_end, '/') orelse return exit_bad_usage;
        work = .{ .seen = try Seen.init(gpa, pages), .origin = url[0..path_start] };
        crawl.work = &work;
    }
    defer if (crawling) gpa.free(work.seen.slots);

    const start = nowNs();
    var threads: [max_connections]std.Thread = undefined;
    for (threads[0..connections]) |*thread| thread.* = try std.Thread.spawn(.{}, fetchWorker, .{&crawl});
    for (threads[0..connections]) |thread| thread.join();

    const fetched = crawl.pages_done.load(.monotonic);
    const lost = crawl.pages_lost.load(.monotonic);
    const seconds = @as(f64, @floatFromInt(elapsedNs(start))) / std.time.ns_per_s;
    std.debug.print("crawled {d} pages in {d:.2}s, {d} errors\n", .{ fetched, seconds, lost });
    return exit_done;
}
