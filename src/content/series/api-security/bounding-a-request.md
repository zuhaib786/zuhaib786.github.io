---
title: "Bounding a Request"
description: "Phase 1 of barbican: put explicit budgets on lines, headers, bodies, connections, and time—then follow the concurrency change all the way to SQLite."
date: 2026-09-14
order: 4
tags: ["Security", "API", "HTTP", "DoS", "Zig", "SQLite"]
draft: false
---

The [HTTP boundary](/series/api-security/the-http-layer) decides whether a request has one unambiguous meaning. That is a syntax property. It says nothing about how many resources a syntactically valid request may consume.

All of these requests are well-formed:

- a request with 200,000 one-line headers;
- a request declaring a 64 KiB body and never sending it;
- a request delivered one byte every few seconds;
- 10,000 ordinary requests opened at the same time.

Phase 1 gives the parser a resource envelope. Each dimension is bounded at the first point that can enforce it:

| Resource controlled by the client | Budget | Enforcement point |
|---|---:|---|
| Request line | 4 KiB | receive-buffer capacity |
| One field line | 4 KiB | receive-buffer capacity |
| Field count | 64 | header loop |
| Declared body | 64 KiB | before body allocation/read |
| Body allocation | 16 KiB growth chunks | as the body is read |
| Complete-request time | 5 s | per-connection reaper task |
| Concurrent connections | 128 | task-pool capacity |

The important part is not the constants. It is the data flow behind them. A length check performed after buffering is not a memory bound. A connection cap backed by an unbounded queue is not a connection bound. A 64 KiB size limit does not stop a client from holding a socket for an hour.

## A declaration is not a body

Phase 0 already rejected `Content-Length` above 64 KiB before allocating:

```zig
const len = content_length orelse 0;
if (len > MAX_BODY) return error.BodyTooLarge;

const body = try allocator.alloc(u8, len);
try reader.readSliceAll(body);
```

That caps the allocation, but the allocation is still sized by a number the client typed. A request can declare `65535`, send no body, and make the server hold almost 64 KiB while it waits.

The intended invariant is stronger:

> A client should have to send a byte before that byte costs body memory.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/claim-vs-arrival.svg" alt="The target allocation model. Sizing from Content-Length lets a small request reserve the entire declared body. Sizing from bytes that actually arrive makes the sender pay in bytes for the memory it occupies.">
  <img class="plate-dark" src="/images/api-security/claim-vs-arrival-dark.svg" alt="The target allocation model. Sizing from Content-Length lets a small request reserve the entire declared body. Sizing from bytes that actually arrive makes the sender pay in bytes for the memory it occupies.">
  <figcaption>The right-hand side is the target property. The current implementation approaches it in chunks; it does not yet achieve literal byte-for-byte allocation.</figcaption>
</figure>

The Phase 1 reader grows an `ArrayList` while consuming the body:

```zig
var body: std.ArrayList(u8) = .empty;
defer body.deinit(ctx.allocator);

while (body.items.len < len) {
    const want: usize = @min(len - body.items.len, CHUNK);
    try body.ensureUnusedCapacity(ctx.allocator, want);

    const dest = body.unusedCapacitySlice()[0..want];
    const n = try r.readSliceShort(dest);
    if (n == 0) return error.IncompleteRequest;
    body.items.len += n;
}
```

This removes the full `Content-Length` from the allocation call. A client must deliver the first chunk before the next chunk is reserved, and must deliver the full body to make the list reach the declared size.

It does **not** make idle-client amplification zero. `ensureUnusedCapacity` runs before `readSliceShort`, so a silent client can still reserve one `CHUNK`—16 KiB—while the read blocks. The change reduces the worst claim-driven allocation from the entire 64 KiB body to one growth chunk. A literal arrival-driven implementation would read into a fixed scratch buffer first and append only `scratch[0..n]` after the read returns:

```zig
var scratch: [CHUNK]u8 = undefined;
const n = try r.readSliceShort(scratch[0..want]);
if (n == 0) return error.IncompleteRequest;
try body.appendSlice(ctx.allocator, scratch[0..n]);
```

That trades a fixed 16 KiB stack cost per connection for eliminating the claim-driven heap reservation. The present implementation makes `CHUNK` a security parameter as well as a throughput parameter; changing it changes how much memory a stalled connection can pin.

### The borrowed-buffer constraint

`CHUNK` is large for another reason. The request target and header values are slices into the reader's 4 KiB receive buffer. A large destination lets `readSliceShort` read body bytes directly into the `ArrayList` instead of refilling that receive buffer and overwriting borrowed request data.

That optimization is not a complete lifetime guarantee. Header reads can also cause the reader to rebase its buffer, while `line.target` is retained until routing after the body. The robust design is to copy the parsed target into request-owned storage, or store stable offsets into an owned request buffer. Depending on a reader's refill fast path for slice validity is a hidden contract and remains a follow-up item.

## Enforce line limits while reading

The request line and every field line share a 4 KiB receive buffer:

```zig
pub const MAX_LINE: usize = 4096;

var recv_buffer: [MAX_LINE]u8 = undefined;
var reader = conn.reader(io, &recv_buffer);
```

`takeDelimiterInclusive` searches for a newline without allocating. If the buffer fills before the delimiter appears, it returns `StreamTooLong`. The capacity is therefore the bound; the server never buffers an oversized line and then asks whether it was too large.

The same low-level error means different things depending on which grammar is being read. That context is added immediately:

```zig
const raw_line = r.takeDelimiterInclusive('\n') catch |err| switch (err) {
    error.StreamTooLong => return error.UriTooLong,
    error.EndOfStream => return error.IncompleteRequest,
    error.ReadFailed => return err,
};
```

Inside the header loop, the mapping changes:

```zig
const raw = r.takeDelimiterInclusive('\n') catch |err| switch (err) {
    error.StreamTooLong => return error.HeaderTooLarge,
    error.EndOfStream => return error.IncompleteRequest,
    error.ReadFailed => return err,
};
```

This is why the errors are named beside the read rather than inside a generic reader wrapper. `StreamTooLong` contains no information about whether the server was reading a request line or a header. At the call site it can become `414 URI Too Long` or `431 Request Header Fields Too Large`; after the context is discarded, a central error mapper can only guess.

The 4 KiB request-line bound currently maps every overflow to `414`, including an abnormally long method or version token. The smoke test exercises the intended case—an 8,000-byte target—but exact per-field limits would require parsing into a bounded request-line representation rather than treating the whole line as a URI.

## Bound the loop, not only each item

Small headers bypass a per-line limit. This is valid input for as long as the sender keeps going:

```http
X-0: 1
X-1: 1
X-2: 1
```

The header loop therefore carries its own count:

```zig
var header_count: usize = 0;
while (true) {
    const raw = try readFieldLine(r);
    if (raw.len == 0) break;

    if (header_count == MAX_HEADERS) return error.TooManyHeaders;
    header_count += 1;

    const header = try request.parseHeader(raw);
    // consume header here
}
```

The location of the increment defines the constant. It occurs after the blank-line check because the terminator is not a field, and the equality check occurs before increment so exactly 64 fields are accepted. A count outside the loop tends to conflate "the condition failed" with "the loop ended through `break`."

The body, line, and count limits now cover how much input a request may contain. None covers how long the sender may take to deliver it.

## Time is part of the request budget

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/size-versus-time.svg" alt="Two connection timelines. A large body is stopped by the body-size limit, while a client sending one byte at a time remains under every size limit indefinitely.">
  <img class="plate-dark" src="/images/api-security/size-versus-time-dark.svg" alt="Two connection timelines. A large body is stopped by the body-size limit, while a client sending one byte at a time remains under every size limit indefinitely.">
  <figcaption>A size budget limits space. Slowloris spends time instead.</figcaption>
</figure>

The Phase 0 accept loop served one connection synchronously:

```zig
while (true) {
    const conn = try server.accept(io);
    try serve(io, &ctx, conn);
}
```

A client that stalls after the request line blocks `serve`, so the process never returns to `accept`. One slow connection becomes a complete outage.

Phase 1 makes request handling concurrent and bounds the task pool:

```zig
pub const MAX_CONNS: usize = 128;

var threaded: std.Io.Threaded = .init(gpa, .{
    .concurrent_limit = .limited(2 * MAX_CONNS),
});
var group: std.Io.Group = .init;

while (true) {
    const conn = try server.accept(io);
    group.concurrent(io, connection.serve, .{ io, &ctx, conn }) catch {
        conn.close(io); // capacity exhausted: shed, do not queue
    };
}
```

There are two task slots per admitted connection: one for `serve`, one for its deadline. If the pool has no slot for either, the connection is closed. Queuing accepted connections without a bound would move the exhaustion target from the thread pool to the queue.

Concurrency prevents one stalled client from blocking unrelated requests. It does not free the stalled connection itself. A five-second reaper provides the duration bound.

## Implement the deadline without sharing socket ownership

Zig 0.16's threaded I/O does not expose a compatible socket read deadline here. Setting `SO_RCVTIMEO` makes the underlying blocking `read()` return `EAGAIN`; this runtime classifies that result as a programmer error and panics. In this stack, the usual socket option converts a remote hang into a remote process crash.

The implemented deadline is a second task:

```zig
fn reaper(io: Io, conn: net.Stream, done: *std.atomic.Value(bool)) void {
    io.sleep(.{ .nanoseconds = TIMEOUT_NS }, .real) catch return;
    if (done.load(.acquire)) return;
    conn.shutdown(io, .recv) catch {};
}
```

`serve` arms it before reading:

```zig
var done: std.atomic.Value(bool) = .init(false);
var wd = io.concurrent(reaper, .{ io, conn, &done }) catch {
    return; // no deadline capacity: do not serve an unbounded request
};

defer {
    done.store(true, .release);
    _ = wd.cancel(io);
}
defer conn.close(io);
```

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/deadline-as-a-task.svg" alt="The request and reaper tasks on a five-second timeline. Normal completion cancels the reaper. A stalled request lets the reaper shut down the receive side so the blocked read returns EndOfStream.">
  <img class="plate-dark" src="/images/api-security/deadline-as-a-task-dark.svg" alt="The request and reaper tasks on a five-second timeline. Normal completion cancels the reaper. A stalled request lets the reaper shut down the receive side so the blocked read returns EndOfStream.">
  <figcaption>The reaper does not cancel arbitrary parser code. It shuts down input, turning the blocked read into an ordinary error path.</figcaption>
</figure>

`shutdown(.recv)` is narrower than `close`. The serve task remains the only owner that closes the socket; the reaper only makes further reads terminate. Closing from both tasks would create a lifetime race around the same handle.

Cancellation and the `done` flag cover different schedules. Cancellation interrupts a reaper still asleep. The atomic flag covers a reaper that has already woken but has not called `shutdown` yet. They narrow the race rather than proving it absent: a shutdown can still land immediately after a response completes, but only the receive half is affected and the request is already finished.

The five-second bound is enforced, but the response status is not yet exact. `shutdown(.recv)` reaches the reader as `EndOfStream`, which `handle` maps to `IncompleteRequest`, so a reaped request currently receives `400`. `response.fail` defines a `408` mapping for `error.Timeout`, but no path produces that error. Returning `408` requires the reaper to communicate *why* the read ended, not merely cause it to end.

## Concurrency is a transitive property

The task-pool change makes `connection.serve` concurrent, but the shared `Ctx` still holds one SQLite connection:

```zig
var database = try SQLDatabase.open("barbican.db");
var ctx: Ctx = .{ .db = &database, .allocator = gpa, .io = io };
```

The system SQLite is compiled in multi-thread mode. In that mode different connections may be used concurrently; one connection may not. Sharing this handle across request tasks is undefined behaviour, not a polite `SQLITE_BUSY` response. A reduced eight-thread probe reproduced a segmentation fault, and 200 concurrent publishes produced intermittent `500`s.

The database must therefore opt into per-connection serialization:

```zig
const flags = c.SQLITE_OPEN_READWRITE |
    c.SQLITE_OPEN_CREATE |
    c.SQLITE_OPEN_FULLMUTEX;

if (c.sqlite3_open_v2(path.ptr, &db.handle, flags, null) != c.SQLITE_OK) {
    return error.OpenFailed;
}
```

`SQLITE_OPEN_FULLMUTEX` serializes calls on this handle. It is the minimum change that makes the existing shared-context architecture safe; it is not a scaling design. A later version can use a connection pool or a dedicated database task, but either must preserve the same ownership rule explicitly.

This dependency is why concurrency cannot be reviewed one file at a time. The connection code changed who may call the database code. No SQLite function signature changed, and every single-threaded database test still passed. After `FULLMUTEX`, the same 400-publish concurrency run completed with 400 `201` responses.

## Error responses are part of the boundary

Phase 0 caught parser failures outside the response writer, logged them, and closed the socket. Four smoke tests called that "refusal" because they asserted empty output. Empty output proves only that the connection disappeared; it does not prove that the server classified the request correctly.

Phase 1 splits connection handling in the same way the router already splits handlers from error responses:

```zig
pub fn serve(io: Io, ctx: *Ctx, conn: net.Stream) !void {
    // buffers and deadline omitted
    handle(ctx, &reader.interface, w) catch |err| {
        std.log.err("request failed: {t}", .{err});
        response.fail(w, err) catch {};
    };
}

fn handle(ctx: *Ctx, r: *Reader, w: *Writer) !void {
    // parse, bound, read, dispatch; no error response is written here
}
```

`handle` gives every failure a name but never turns it into bytes. `serve` owns the single error-response point. That keeps a new parser branch from writing an error and then falling through to a second response.

The mapping is based on fault ownership:

```zig
error.MalformedLine,
error.MalformedHeader,
error.InvalidMethod,
error.InvalidCharacter,
error.Overflow          => 400,

error.IncompleteRequest => 400,
error.BodyTooLarge      => 413,
error.UriTooLong        => 414,
error.TooManyHeaders,
error.HeaderTooLarge    => 431,

error.ReadFailed        => 500,
```

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/whose-fault.svg" alt="Malformed or oversized client input maps to specific 4xx responses, while a socket read failure remains a 500 because it belongs to the server side of the boundary.">
  <img class="plate-dark" src="/images/api-security/whose-fault-dark.svg" alt="Malformed or oversized client input maps to specific 4xx responses, while a socket read failure remains a 500 because it belongs to the server side of the boundary.">
  <figcaption>Status codes preserve fault ownership: malformed client input is not an internal outage, and an internal I/O failure is not a bad request.</figcaption>
</figure>

An attacker-triggerable `500` contaminates the signal reserved for server failure. It can page an operator, inflate an error-rate alert, and consume an availability budget on demand. Mapping malformed input to 4xx is therefore operational isolation, not cosmetic API polish. The converse matters just as much: a failed socket or database operation stays 5xx, because blaming the client would hide a real outage.

The smoke suite now asserts the response class rather than a silent close:

```sh
case "$(rawline "$request")" in
  *" 414"*) ok "over-long request target" ;;
  *)         bad "expected 414" ;;
esac
```

It exercises an 8,000-byte target, 200 field lines, one 5,000-byte field, a non-numeric `Content-Length`, an oversized declared body, and a body shorter than declared. Those are boundary tests: each input is selected to cross exactly one budget and verify both refusal and classification.

## The resulting contract

Phase 1 does not make resource use cheap. It makes the maximum cost of one request calculable:

```text
one admitted connection
  = one serve task
  + one deadline task
  + 4 KiB receive buffer
  + 4 KiB send buffer
  + at most 64 field lines
  + at most 64 KiB completed body
  + at most 5 seconds before receive shutdown
```

At process scope, at most 128 such connections are admitted, and the shared database handle serializes concurrent access. When a limit is exhausted, the server sheds work instead of creating an unbounded queue.

Three follow-ups remain visible rather than being hidden behind the word "bounded":

- body growth still reserves one chunk before that chunk arrives;
- request metadata still borrows from a receive buffer that later reads may rebase;
- deadline expiry is enforced but currently reported as `400`, because the reaper does not propagate `Timeout` provenance.

Those gaps do not erase the resource envelope. They define its actual strength, which is the only useful version of a security control to document.

Next: package-name and semver allowlists, parameterized SQLite statements, and JSON serialization—the boundaries where valid data must remain data instead of becoming syntax.
