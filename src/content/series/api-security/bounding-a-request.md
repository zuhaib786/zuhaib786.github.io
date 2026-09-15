---
title: "What a Request May Cost, and What It May Mean"
description: "Phase 1 of barbican: explicit budgets on lines, headers, bodies, connections and time; then allowlists, bound parameters and a serializer, so no value can leave its slot and become syntax."
date: 2026-09-14
order: 4
tags: ["Security", "API", "HTTP", "DoS", "SQL Injection", "Zig", "SQLite"]
draft: false
---

The [HTTP boundary](/series/api-security/the-http-layer) decides whether a request has one unambiguous meaning. That is a syntax property, and it settles two questions it does not answer: how much a well-formed request may consume, and what its contents are allowed to *mean* further down.

All of these are well-formed:

- 200,000 one-line headers;
- a declared 64 KiB body that is never sent;
- a body delivered one byte every few seconds;
- a package description of `x', 'ts'); DROP TABLE versions;--`.

The first three are budget problems. The fourth is a grammar problem. Phase 1 is both.

## Part one: the resource envelope

| Resource controlled by the client | Budget | Enforcement point |
|---|---:|---|
| Request line | 4 KiB | receive-buffer capacity |
| One field line | 4 KiB | receive-buffer capacity |
| Field count | 64 | header loop |
| Declared body | 64 KiB | before body allocation or read |
| Body allocation | 16 KiB growth chunks | as the body is read |
| Complete-request time | 5 s | per-connection reaper task |
| Concurrent connections | 128 | task-pool capacity |

The constants are not the point. The data flow behind them is. A length check performed after buffering is not a memory bound. A connection cap backed by an unbounded queue is not a connection bound. A 64 KiB size limit does not stop a client holding a socket for an hour.

### A declaration is not a body

Phase 0 rejected `Content-Length` above 64 KiB before allocating:

```zig
const len = content_length orelse 0;
if (len > MAX_BODY) return error.BodyTooLarge;

const body = try allocator.alloc(u8, len);
try reader.readSliceAll(body);
```

That caps the allocation, but the allocation is still sized by a number the client typed. A request can declare `65535`, send nothing, and make the server hold 64 KiB while it waits — roughly 55 bytes of attacker effort per 64 KiB of server memory.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/claim-vs-arrival.svg" alt="The target allocation model. Sizing from Content-Length lets a small request reserve the entire declared body. Sizing from bytes that actually arrive makes the sender pay in bytes for the memory it occupies.">
  <img class="plate-dark" src="/images/api-security/claim-vs-arrival-dark.svg" alt="The target allocation model. Sizing from Content-Length lets a small request reserve the entire declared body. Sizing from bytes that actually arrive makes the sender pay in bytes for the memory it occupies.">
  <figcaption>The invariant: a client should have to send a byte before that byte costs body memory.</figcaption>
</figure>

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

This does **not** make idle-client amplification zero. `ensureUnusedCapacity` runs before `readSliceShort`, so a silent client still reserves one `CHUNK`. The worst claim-driven allocation drops from the whole 64 KiB body to 16 KiB — which makes `CHUNK` a security parameter as well as a throughput one. A literal arrival-driven version would read into a fixed scratch buffer and append only `scratch[0..n]`, trading a fixed per-connection stack cost for removing the reservation entirely.

`CHUNK` is large for a second reason: the request target and header values are slices into the 4 KiB receive buffer, and a large destination lets the body read bypass that buffer rather than refilling it over borrowed data. That is a hidden contract rather than a guarantee, and it is [where the next phase starts](/series/api-security/what-the-request-stands-on).

### Bound while reading, and name the error where the meaning is known

Line limits are the receive buffer's capacity. `takeDelimiterInclusive` returns `StreamTooLong` once the buffer fills without finding a newline, so the server never buffers an oversized line and then asks whether it was too large.

One low-level error, two meanings:

```zig
// reading the request line
error.StreamTooLong => return error.UriTooLong,        // 414

// reading a field line
error.StreamTooLong => return error.HeaderTooLarge,    // 431
```

`StreamTooLong` carries no information about which grammar was being read. At the call site that context still exists; in a central error mapper it is gone, and whichever status it picks is wrong half the time.

### Bound the loop, not only each item

Small headers slip under a per-line limit — `X-0: 1` repeated is valid input for as long as the sender continues. So the header loop carries a count, and where the increment sits defines the constant:

```zig
if (raw.len == 0) break;                                   // terminator is not a field
if (header_count == MAX_HEADERS) return error.TooManyHeaders;
header_count += 1;
```

Testing after the loop instead conflates "the condition failed" with "the loop hit `break`".

### Time is part of the budget

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/size-versus-time.svg" alt="Two connection timelines. A large body is stopped by the body-size limit, while a client sending one byte at a time remains under every size limit indefinitely.">
  <img class="plate-dark" src="/images/api-security/size-versus-time-dark.svg" alt="Two connection timelines. A large body is stopped by the body-size limit, while a client sending one byte at a time remains under every size limit indefinitely.">
  <figcaption>A size budget limits space. Slowloris spends time instead.</figcaption>
</figure>

Phase 0 served one connection synchronously, so a client that stalled after the request line blocked `serve` and the process never returned to `accept`. **One slow connection was a complete outage.** Phase 1 makes handling concurrent and bounds the pool:

```zig
group.concurrent(io, connection.serve, .{ io, &ctx, conn }) catch {
    conn.close(io);   // capacity exhausted: shed, do not queue
};
```

Two task slots per admitted connection — one for `serve`, one for its deadline. Queuing accepted connections without a bound would move the exhaustion target from the thread pool to the queue.

Concurrency stops one stalled client blocking unrelated requests. It does not free the stalled connection, and the obvious fix for that is a trap:

> Setting `SO_RCVTIMEO` makes the underlying blocking `read()` return `EAGAIN`. Zig 0.16's threaded I/O classifies that as a programmer error and panics. **The standard socket option converts a remote hang into a remote process crash.**

So the deadline is a second task that shuts down the read side:

```zig
fn reaper(io: Io, conn: net.Stream, done: *std.atomic.Value(bool)) void {
    io.sleep(.{ .nanoseconds = TIMEOUT_NS }, .real) catch return;
    if (done.load(.acquire)) return;
    conn.shutdown(io, .recv) catch {};
}
```

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/deadline-as-a-task.svg" alt="The request and reaper tasks on a five-second timeline. Normal completion cancels the reaper. A stalled request lets the reaper shut down the receive side so the blocked read returns EndOfStream.">
  <img class="plate-dark" src="/images/api-security/deadline-as-a-task-dark.svg" alt="The request and reaper tasks on a five-second timeline. Normal completion cancels the reaper. A stalled request lets the reaper shut down the receive side so the blocked read returns EndOfStream.">
  <figcaption>The reaper does not cancel parser code. It shuts down input, turning a blocked read into an ordinary error path.</figcaption>
</figure>

`shutdown(.recv)` rather than `close`: the serve task stays the only owner that closes the socket, and closing from both would be a lifetime race on one handle. Cancellation and the `done` flag cover different schedules — cancellation interrupts a reaper still asleep, the flag covers one that has woken but not yet acted. They narrow the race rather than proving it absent.

The duration bound is enforced; the status is not yet exact. `shutdown(.recv)` reaches the reader as `EndOfStream`, which maps to `400`. Returning `408` requires the reaper to communicate *why* the read ended, not merely cause it to end.

### Concurrency is a transitive property

Making `serve` concurrent introduced a defect in a file that did not change. The shared `Ctx` holds one SQLite connection, and the system SQLite is built in multi-thread mode: different connections may be used concurrently, one connection may not.

Sharing it across request tasks is undefined behaviour, not a polite `SQLITE_BUSY`. An eight-thread probe segfaults; 200 concurrent publishes produced intermittent `500`s. The fix is to opt into per-connection serialization with `SQLITE_OPEN_FULLMUTEX` — after which the same run returned 400 × `201`.

**No SQLite signature changed and every single-threaded database test still passed.** Thread safety is a property of a whole program, and it is invisible in a diff.

### Error responses are part of the boundary

Phase 0 caught parser failures outside the response writer, logged them, and closed the socket. Four smoke tests called that "refusal" because they asserted empty output — which proves the connection disappeared, not that the request was classified.

`handle` now names every failure and never turns one into bytes; `serve` owns the single error-response point, so a new parser branch cannot write an error and then fall through to a second response.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/whose-fault.svg" alt="Malformed or oversized client input maps to specific 4xx responses, while a socket read failure remains a 500 because it belongs to the server side of the boundary.">
  <img class="plate-dark" src="/images/api-security/whose-fault-dark.svg" alt="Malformed or oversized client input maps to specific 4xx responses, while a socket read failure remains a 500 because it belongs to the server side of the boundary.">
  <figcaption>Status codes preserve fault ownership: malformed input is not an outage, and an I/O failure is not a bad request.</figcaption>
</figure>

An attacker-triggerable `500` contaminates the signal reserved for server failure — it pages someone, moves an error-rate graph, and burns an availability budget on demand. Mapping malformed input to `4xx` is operational isolation, not API polish. The converse matters equally: a failed socket or database operation stays `5xx`, because blaming the client hides a real outage.

## Part two: what a value is allowed to mean

A registry moves client bytes through two grammars on the way out — a package description becomes part of a SQL statement, then part of a JSON document. Phase 0 built both by concatenation, which gives every value the option of leaving its slot and becoming structure.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/data-becomes-syntax.svg" alt="One payload shown in two grammars. Built by interpolation it becomes two SQL statements and a forged JSON key. Built by each grammar's own writer it stays one bound parameter and one escaped field.">
  <img class="plate-dark" src="/images/api-security/data-becomes-syntax-dark.svg" alt="One payload shown in two grammars. Built by interpolation it becomes two SQL statements and a forged JSON key. Built by each grammar's own writer it stays one bound parameter and one escaped field.">
  <figcaption>Two findings, one defect: a value permitted to leave its slot.</figcaption>
</figure>

Three defences close this, and they do not have the same reach.

### An allowlist states what is permitted

```
^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$
```

One line, closing a list it never mentions:

| Excluded | Closes |
|---|---|
| `/` `.` | path traversal once artifacts reach the filesystem |
| `'` `"` | SQL injection |
| `<` `>` | stored XSS in a future web UI |
| `%` | separator smuggling through double decoding |
| uppercase | `Foo` and `foo` as two packages; case typosquatting |
| non-ASCII | homograph squatting — Cyrillic `а` against Latin `a` |
| length > 64 | statement-buffer overflow, log flooding |

That table is the case for allowlists. A denylist needs every row *plus* the rows nobody has written down; an allowlist inherits the unknown rows by refusing anything it was not told to accept.

Semver gets `(0|[1-9][0-9]*)` rather than `[0-9]+`, which looks cosmetic and is not: without it `1.1.0` and `1.01.0` are two rows naming one version, so a lockfile that pinned one can resolve the other's checksum.

**A validated value is a type, not a checked string.** Calling a validator at the top of each handler puts the guarantee in five places, and in whichever handler is added next. `PackageName` has one constructor, handlers carry the type, and skipping the check does not compile. Both sources go through it — path capture and request body alike, because a name from a JSON body is exactly as untrusted as one from a URL.

### POSIX regex loses the length at the C boundary

Zig's standard library has no regex engine; the POSIX one is available through `@cImport`, and is thread-safe on a compiled pattern (eight threads, 400,000 matches, no disagreement). It also has a property that turns validation into a bypass:

```zig
const s = "abc\x00'; DROP TABLE packages;--";   // 29 bytes
c.regexec(&name_re, s.ptr, 0, null, 0) == 0     // VALID
```

`regexec` takes a `char *`. A Zig slice carries its length; a C string ends at the first NUL. Everything after it is never examined, so the matcher approves `abc` and the caller approves 29 bytes — and `std.json` decodes a ` ` escape into a real NUL, so this arrives in a request body. **Crossing into C loses the length, and anything past the first NUL goes unread**; the check belongs before the crossing.

And `regexec` matches a *substring*. Unanchored, `[a-z0-9-]+` accepts `x'; DROP TABLE packages;--` because `DROP` matches in the middle. A missing `^` or `$` is the most common validation defect there is, so the test for it asserts a case whose only failure mode is a missing anchor:

```zig
try std.testing.expectError(error.InvalidName, PackageName.parse("!!!valid-name!!!"));
```

### Bound parameters remove the parse the attacker needs

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/prepare-bind-step.svg" alt="The prepared-statement lifecycle: prepare_v2 compiles the SQL text into a query plan and is the only parse; bind_text drops a value into a slot of the already-compiled plan; step executes it; finalize releases it. Only the first stage parses anything.">
  <img class="plate-dark" src="/images/api-security/prepare-bind-step-dark.svg" alt="The prepared-statement lifecycle: prepare_v2 compiles the SQL text into a query plan and is the only parse; bind_text drops a value into a slot of the already-compiled plan; step executes it; finalize releases it. Only the first stage parses anything.">
  <figcaption>The plan is compiled before any value exists, so there is no second parse for a value to reach.</figcaption>
</figure>

Escaping is a transformation that must be remembered, applied in the right dialect, and applied exactly once; it leaves the parse in place and tries to make the input survive it. Binding deletes the parse.

The change also removes `sqlite3_exec` from the request path, which matters on its own: `exec` runs *every* statement in a string, and that multi-statement capability is precisely the `; DROP TABLE` primitive. `prepare_v2` compiles only the first and hands the rest back — **returning `SQLITE_OK` while doing so**, so the leftover tail has to be an error or a two-statement string quietly half-runs. `exec` survives only in the schema load, where the SQL is a compile-time `@embedFile` with no client bytes in it.

Two checks the C API will not make for you:

**Binding fewer parameters than the statement has succeeds**, storing `NULL` and returning `SQLITE_DONE`. `std.fmt` caught that mismatch at compile time; parameterization *loses* the property, so `sqlite3_bind_parameter_count` has to restore it by hand. A security change that silently removes an existing guarantee is worth looking for every time.

**Passing `-1` as the value length means "read to the NUL"** — the same truncation as `regexec`, one layer down.

### SQLITE_TRANSIENT is a C macro Zig cannot express

The last argument to `sqlite3_bind_text` answers *whose memory is this?*

| Value | Meaning | SQLite does |
|---|---|---|
| a function, e.g. `free` | take ownership | stores the pointer, calls it later |
| `SQLITE_STATIC` (`0`) | this outlives the statement | stores the pointer, no copy |
| `SQLITE_TRANSIENT` (`-1`) | this is about to disappear | copies immediately |

`-1` is not an address but a sentinel SQLite compares against and never calls. Zig refuses to build it: the type is `?*const fn (?*anyopaque) callconv(.c) void`, function pointers have alignment requirements, and `0xFFFF…FF` is not aligned. `@cImport` fails on the declaration, a `const` fails at comptime, and a runtime `@ptrFromInt` panics on the safety check. The fix disables that check for the one value where the rule does not apply:

```zig
fn transient() c.sqlite3_destructor_type {
    @setRuntimeSafety(false);   // a sentinel SQLite compares, never calls
    var v: usize = undefined;
    v = @bitCast(@as(isize, -1));
    return @ptrFromInt(v);
}
```

`SQLITE_STATIC` translates cleanly as `null` and is the wrong choice anyway: it makes correctness depend on an invariant written nowhere — *no one ever holds a statement past this call* — and the first person who caches a prepared statement for throughput turns it into a use-after-free serving one client's bytes inside another client's row.

### JSON output is a serializer, not a template

Response shapes become types, and `std.json.Stringify` escapes every string it emits. One correctness bug fell out that had nothing to do with security: `yanked` had been rendered as `if (eql(yanked, "1")) "true" else "false"`, emitting `"yanked":"false"` — a *string*. A client writing `if (response.yanked)` gets `true` for a version that is not yanked, because every non-empty string is truthy.

### Where each defence stops

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/blocked-versus-impossible.svg" alt="A coverage table. The allowlist covers name and version but cannot cover description, checksum, or fields added later. Bound parameters cover every field including ones not yet written.">
  <img class="plate-dark" src="/images/api-security/blocked-versus-impossible-dark.svg" alt="A coverage table. The allowlist covers name and version but cannot cover description, checksum, or fields added later. Bound parameters cover every field including ones not yet written.">
  <figcaption>The allowlist covers the fields somebody enumerated. Encoding covers the fields nobody has written yet.</figcaption>
</figure>

`description` is free text. Real ones contain `Rust's parser` and `a < b` — the exact characters an injection allowlist would have to refuse. No pattern accepts prose and rejects `'; DROP TABLE`, so the description rule bounds length and checks nothing else, and that bound is a resource control rather than an injection defence.

Which makes the ordering explicit. Validation is defence in depth and closes what encoding never touches — traversal, typosquatting, homographs, length. Encoding is the injection fix. Validation alone leaves every unvalidatable field open; encoding alone leaves a registry where `../../etc/passwd` is a legal package name.

## A passing test is not evidence of a fix

The smoke suite tracked the JSON injection finding with a payload delivered through `name`. After the allowlist landed, that check reported the finding as closed. It was not — the payload had moved to `description`, where it still worked:

```
{"name":"pkg","description":"d\",\"admin\":\"true"}
   ->  {"name":"pkg","description":"d","admin":"true"}
```

**A check that passes because the attack relocated is indistinguishable from one that passes because the attack died.** The fix is to re-derive the attack when a defence lands, rather than re-run the old one.

That was the fifth such check in this phase, after four that treated a silently closed connection as a refusal. Tests written against a vulnerable system encode the vulnerability's shape, and keep passing for the wrong reason long after that shape changes.

## The resulting contract

```text
one admitted connection
  = one serve task + one deadline task
  + 4 KiB receive + 4 KiB send buffer
  + at most 64 field lines, 64 KiB completed body
  + at most 5 seconds before receive shutdown
at most 128 such connections; past that, work is shed rather than queued

identifiers   allowlisted, typed, validated at every entry point
SQL           bound parameters only; exec confined to the schema load
JSON          serialized from a declared response type
free text     bounded in length, never allowlisted, always encoded
```

Phase 1 does not make resource use cheap or content trusted. It makes both calculable. What it does not cover, stated rather than implied:

- body growth still reserves one chunk before that chunk arrives;
- request metadata still borrows a receive buffer that later reads may rebase;
- deadline expiry is enforced but reported as `400`, because the reaper does not propagate timeout provenance;
- `description` is stored exactly as sent, so a future web UI must encode on output;
- `checksum` is not validated against any hash format;
- nothing is redacted in logs — the third grammar, and the one with no serializer in front of it.

Those gaps do not erase the envelope. They define its actual strength, which is the only useful version of a security control to document.

Next: the two layers underneath a request — the memory it borrows and the transport it arrives on — where a defect invalidates every control above it.
