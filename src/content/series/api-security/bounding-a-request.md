---
title: "Remote OOM, Slowloris, and Injection in Two Grammars"
description: "Phase 1 of barbican: attacks that a syntactically perfect request can still carry — memory sized from a number the client typed, a connection held open forever, and a value that leaves its slot to become SQL or JSON."
date: 2026-09-14
order: 4
tags: ["Security", "API", "HTTP", "DoS", "SQL Injection", "Zig", "SQLite"]
draft: false
---

The [HTTP boundary](/series/api-security/the-http-layer) settles what a request *means*. It settles nothing about what a request may cost, or what its values are allowed to do further down. Every request below is syntactically perfect.

## Attack: memory sized from a number the client typed

```zig
const len = content_length orelse 0;
if (len > MAX_BODY) return error.BodyTooLarge;

const body = try allocator.alloc(u8, len);   // len is theirs
try reader.readSliceAll(body);
```

The bound caps the damage and leaves the shape intact. `Content-Length: 65535` followed by no body at all is 55 bytes on the wire and holds 64 KiB of server memory for as long as the client stays quiet. Multiply by the connection count.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/claim-vs-arrival.svg" alt="Two allocations compared. Sizing from the declared Content-Length makes 55 bytes sent hold 64 kibibytes. Sizing from bytes that arrive makes 55 bytes sent hold 55 bytes.">
  <img class="plate-dark" src="/images/api-security/claim-vs-arrival-dark.svg" alt="Two allocations compared. Sizing from the declared Content-Length makes 55 bytes sent hold 64 kibibytes. Sizing from bytes that arrive makes 55 bytes sent hold 55 bytes.">
</figure>

## Fix: never let a claim be an allocation size

```zig
while (body.items.len < len) {
    const want: usize = @min(len - body.items.len, CHUNK);
    try body.ensureUnusedCapacity(ctx.allocator, want);

    const dest = body.unusedCapacitySlice()[0..want];
    const n = try r.readSliceShort(dest);
    if (n == 0) return error.IncompleteRequest;
    body.items.len += n;
}
```

Arrival drives the allocation, bounded by a limit the server chose. To pin 64 KiB a client must now send 64 KiB.

The reduction is not to zero. `ensureUnusedCapacity` runs before the read, so a silent client still reserves one `CHUNK` — 16 KiB rather than 64. That makes `CHUNK` a security parameter as well as a throughput one. Reading into a fixed scratch buffer and appending only `scratch[0..n]` removes the reservation entirely, at the cost of a fixed per-connection buffer.

## Attack: a limit on each item is not a limit on the loop

`X-A: 1` repeated indefinitely trips no per-line bound, because every line is tiny. The header loop never ends.

## Fix: bound the loop, and place the counter deliberately

```zig
if (raw.len == 0) break;                                   // terminator is not a field
if (header_count == MAX_HEADERS) return error.TooManyHeaders;
header_count += 1;
```

Counting the blank line makes the real limit `MAX_HEADERS - 1`. Testing after the loop cannot distinguish "the condition failed" from "the loop hit `break`".

Line lengths need no separate check: `takeDelimiterInclusive` fails once the receive buffer fills without finding a newline, so capacity *is* the bound and no oversized line is ever buffered and then measured.

One low-level error, two meanings:

```zig
error.StreamTooLong => return error.UriTooLong,      // reading the request line -> 414
error.StreamTooLong => return error.HeaderTooLarge,  // reading a field line     -> 431
```

`StreamTooLong` carries no record of which grammar was being read. Named at the call site, the context still exists; in a central error mapper it is gone and half the statuses are wrong.

## Attack: a connection held open forever

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/size-versus-time.svg" alt="Two connections on a time axis. A hundred-megabyte body is refused immediately with 413. A client sending one byte at a time continues indefinitely, never tripping a size limit.">
  <img class="plate-dark" src="/images/api-security/size-versus-time-dark.svg" alt="Two connections on a time axis. A hundred-megabyte body is refused immediately with 413. A client sending one byte at a time continues indefinitely, never tripping a size limit.">
</figure>

Every bound so far answers *how much*. None answers *how long*. A client trickling one byte at a time never approaches a size limit.

With a serial accept loop this is not degradation, it is an outage: one stalled connection blocks `serve`, the process never returns to `accept`, and no other client is answered.

## Fix: concurrency, a bounded pool, and a deadline task

```zig
group.concurrent(io, connection.serve, .{ io, &ctx, conn }) catch {
    conn.close(io);   // capacity exhausted: shed, do not queue
};
```

Two task slots per admitted connection — the request and its deadline. Shedding at the limit is the control; queueing accepted connections without a bound just moves the exhaustion target from the pool to the queue.

The usual read deadline is unavailable here. `SO_RCVTIMEO` makes the underlying blocking `read()` return `EAGAIN`, which Zig 0.16's threaded I/O classifies as a programmer error and panics on — converting a remote hang into a remote crash. The deadline is therefore a second task:

```zig
fn reaper(io: Io, conn: net.Stream, done: *std.atomic.Value(bool)) void {
    io.sleep(.{ .nanoseconds = TIMEOUT_NS }, .real) catch return;
    if (done.load(.acquire)) return;
    conn.shutdown(io, .recv) catch {};
}
```

`shutdown(.recv)` rather than `close`: the serve task stays the sole owner that closes the socket, and closing from two tasks is a lifetime race on one handle. Cancellation covers a reaper still asleep; the `done` flag covers one that has woken but not yet acted. Together they narrow the race, and a shutdown landing just after a completed response affects only the receive half.

## Attack: a shared database handle under concurrency

Making request handling concurrent introduced a defect in code that did not change. The system SQLite is built in multi-thread mode, where separate connections may be used concurrently but **one connection may not**. Eight threads on one handle segfault; two hundred concurrent publishes produce intermittent `500`s.

## Fix: serialize the connection explicitly

```zig
const flags = c.SQLITE_OPEN_READWRITE | c.SQLITE_OPEN_CREATE | c.SQLITE_OPEN_FULLMUTEX;
```

`sqlite3_open` takes the library's compile-time default, which does not serialize. This is the minimum change that makes a shared context safe, not a scaling design; a connection pool is the eventual answer and must state the same ownership rule explicitly.

## Attack: a parser branch that writes a second response

Phase 0 removed error responses from handlers. The parser still wrote them, so every new branch that rejects a malformed request is another chance to write an error and then fall through to a second message on the same connection.

## Fix: the reader never writes

`handle` names every failure and returns; it has no writer to respond with. `serve` owns the single error-response point.

The mapping follows fault ownership:

```zig
error.MalformedLine, error.MalformedHeader, error.InvalidMethod,
error.InvalidCharacter, error.Overflow, error.IncompleteRequest  => 400,
error.BodyTooLarge                                               => 413,
error.UriTooLong                                                 => 414,
error.TooManyHeaders, error.HeaderTooLarge                       => 431,
error.ReadFailed                                                 => 500,
```

A `5xx` any stranger can trigger on demand is not a cosmetic problem: it pages an operator, moves an error-rate graph, and burns an availability budget whenever the attacker chooses. `4xx` for malformed input is operational isolation. The converse holds equally — a failed socket or database call stays `5xx`, because blaming the client conceals a real outage.

## Attack: a value that leaves its slot

A description reaches the database as part of a SQL statement, then reaches the client as part of a JSON document. Built by concatenation, both grammars let a value stop being a value.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/data-becomes-syntax.svg" alt="One payload in two grammars. Interpolated, it yields two SQL statements and two JSON keys. Bound and encoded, it yields one statement and one value.">
  <img class="plate-dark" src="/images/api-security/data-becomes-syntax-dark.svg" alt="One payload in two grammars. Interpolated, it yields two SQL statements and two JSON keys. Bound and encoded, it yields one statement and one value.">
</figure>

```
{"name":"p","description":"x', 'ts'); DROP TABLE versions;--"}   -> the table is gone
{"name":"p","description":"d\",\"admin\":\"true"}                -> {"description":"d","admin":"true"}
```

## Fix: an allowlist on every identifier

```
^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$
```

One pattern closing a list it never names:

| Excluded | Attack closed |
|---|---|
| `/` `.` | path traversal once artifacts reach the filesystem |
| `'` `"` | SQL injection |
| `<` `>` | stored XSS in a web UI |
| `%` | separator smuggling through double decoding |
| uppercase | `Foo` and `foo` as two packages; case typosquatting |
| non-ASCII | homograph squatting — Cyrillic `а` against Latin `a` |
| length > 64 | statement-buffer overflow, log flooding |

A denylist needs every row plus the rows nobody has written yet. An allowlist inherits the unwritten rows by refusing whatever it was not told to accept.

Semver takes `(0|[1-9][0-9]*)` rather than `[0-9]+`: without it `1.1.0` and `1.01.0` are two rows naming one version, and a lockfile pinning one resolves the other's checksum.

The validated value is a type with one constructor, so skipping the check does not compile, and both sources go through it — path capture and request body alike. A name arriving in JSON is exactly as untrusted as one in a URL.

## Attack: a NUL byte truncates the validator

Zig has no regex engine; the POSIX one arrives through `@cImport`. `regexec` takes a `char *`, and a C string ends at its first NUL:

```zig
const s = "abc\x00'; DROP TABLE packages;--";   // 29 bytes
c.regexec(&name_re, s.ptr, 0, null, 0) == 0     // VALID — only "abc" was examined
```

`std.json` decodes a `` escape into a real NUL, so this arrives in a request body.

An unanchored pattern is the second half of the same problem: `regexec` matches a *substring*, so `[a-z0-9-]+` accepts `x'; DROP TABLE packages;--` because `DROP` matches in the middle.

## Fix: check before the crossing, and anchor the pattern

```zig
if (s.len == 0 or s.len > max) return false;                 // the buffer is the bound
if (std.mem.indexOfScalar(u8, s, 0) != null) return false;    // no NUL reaches C
```

**Crossing into C loses the length.** A Zig slice carries one; a `char *` does not, and everything past the first NUL goes unread. The rule applies to every C string API in the program.

The anchoring test asserts a case whose only failure mode is a missing `^` or `$`:

```zig
try std.testing.expectError(error.InvalidName, PackageName.parse("!!!valid-name!!!"));
```

## Fix: bound parameters delete the parse the attack needs

`sqlite3_prepare_v2` compiles the statement into a query plan **before any value exists**. Binding fills a slot in a compiled plan. There is no later moment at which those bytes are read as SQL.

Escaping is the weaker alternative: a transformation that must be remembered, applied in the right dialect, and applied exactly once. It leaves the parse in place and tries to make the input survive it.

This also removes `sqlite3_exec` from the request path, which matters independently — `exec` runs *every* statement in a string, and that is precisely the `; DROP TABLE` primitive. `prepare_v2` compiles only the first and hands the rest back as an untouched tail, **returning `SQLITE_OK` while doing so**, so the tail must be rejected or a two-statement string quietly half-runs. `exec` survives only in the schema load, where the SQL is a compile-time `@embedFile`.

Two checks the C API will not make:

**Binding fewer parameters than the statement has succeeds**, storing `NULL` and returning `SQLITE_DONE`. `std.fmt` caught arity mismatches at compile time; parameterization loses that, so `sqlite3_bind_parameter_count` restores it by hand.

**Passing `-1` as the value length means "read to the NUL"** — the same truncation as `regexec`, one layer down.

### SQLITE_TRANSIENT cannot be expressed in Zig

The last argument to `sqlite3_bind_text` answers *whose memory is this*:

| Value | SQLite does |
|---|---|
| a function, e.g. `free` | stores the pointer, calls the function later |
| `SQLITE_STATIC` (`0`) | stores the pointer, no copy |
| `SQLITE_TRANSIENT` (`-1`) | copies immediately |

`-1` is a sentinel SQLite compares against and never calls. Function pointers have alignment requirements and `0xFFFF…FF` is not aligned, so `@cImport` cannot translate it, a `const` fails at comptime, and a runtime `@ptrFromInt` trips the safety check:

```zig
fn transient() c.sqlite3_destructor_type {
    @setRuntimeSafety(false);   // a sentinel SQLite compares, never calls
    var v: usize = undefined;
    v = @bitCast(@as(isize, -1));
    return @ptrFromInt(v);
}
```

`SQLITE_STATIC` translates cleanly as `null` and is the wrong choice: it makes correctness depend on an invariant written nowhere — *nobody holds a statement past this call* — and the first cached prepared statement turns it into a use-after-free serving one client's bytes inside another client's row.

## Fix: JSON from a serializer, not a template

Response shapes become types and `std.json.Stringify` escapes every string it emits, so no value can terminate the string it occupies.

A rendered boolean is the same defect in miniature. `if (eql(yanked, "1")) "true" else "false"` emits `"yanked":"false"` — a *string*, and every non-empty string is truthy, so a client writing `if (response.yanked)` gets `true` for a version that is not yanked.

## Attack: the field an allowlist cannot cover

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/blocked-versus-impossible.svg" alt="Coverage per field. The allowlist covers name and version but not description, checksum, or fields added later. Encoding covers all of them.">
  <img class="plate-dark" src="/images/api-security/blocked-versus-impossible-dark.svg" alt="Coverage per field. The allowlist covers name and version but not description, checksum, or fields added later. Encoding covers all of them.">
</figure>

`description` is free text. Real descriptions contain `Rust's parser` and `a < b` — exactly the characters an injection allowlist would have to refuse. No pattern accepts prose and rejects `'; DROP TABLE`, so the description rule bounds length only, and that bound is a resource control rather than an injection defence.

Validation closes what encoding never touches: traversal, typosquatting, homographs, length. Encoding closes injection everywhere, including in fields not yet written. Validation alone leaves every unvalidatable field open; encoding alone leaves a registry where `../../etc/passwd` is a legal package name.

## Attacks still open

- Body growth reserves one chunk before that chunk arrives.
- Request metadata borrows a receive buffer that later reads may rebase.
- Deadline expiry is enforced but reported as `400`, because the reaper does not propagate timeout provenance.
- `description` is stored exactly as sent, so a web UI must encode on output.
- `checksum` is not validated against any hash format.
- Nothing is redacted in logs — a third grammar, with no serializer in front of it.

Next: [the layers underneath](/series/api-security/what-the-request-stands-on) — the memory a request borrows and the transport it arrives on.
