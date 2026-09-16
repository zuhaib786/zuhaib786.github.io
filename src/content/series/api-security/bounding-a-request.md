---
title: "Bounding Request Cost and Removing Injection Paths"
description: "Why body limits need deadlines and admission control, and how validation, SQL parameters, and JSON serialization solve different problems."
date: 2026-09-14
order: 4
tags: ["Security", "API", "HTTP", "DoS", "SQL Injection", "Zig", "SQLite"]
draft: false
---

A request can be valid HTTP and still be a problem for the server. It can arrive one byte per minute, ask for work that consumes the entire worker pool, or carry a string that becomes executable SQL when the handler builds a query.

Barbican, the small package registry in this series, initially parses a request, dispatches it, and stores package metadata in SQLite. Its [HTTP boundary](/series/api-security/the-http-layer) is intentionally incomplete. This stage adds two things the parser cannot establish on its own: limits on resource consumption, and a safe way to move values between JSON, Zig, and SQL.

## Budget the whole request

The implementation uses several limits: a 4 KiB buffer for individual request and header lines, at most 64 header fields, a 64 KiB body cap, and a five-second receive deadline. It also bounds concurrent task capacity.

These numbers constrain different dimensions. A line limit does not stop thousands of tiny headers. A body limit does not stop a client taking an hour to send one kilobyte. A deadline does not prevent a burst of connections from consuming every task slot before any timer expires.

The memory estimate needs to include all of the request's allocations:

```text
request memory ≈ buffers + body capacity + parsed values + database results
process memory ≈ shared state + sum(memory of active requests)
```

For example, 128 bodies of 64 KiB account for 8 MiB. That is only the bodies: TLS state, thread stacks, parsed strings, and response construction add to it. A small per-request limit is useful only when paired with an admission limit and an understanding of what each admitted request can trigger.

The header count is enforced inside the read loop. The blank line that ends the header section is checked first, so it does not consume a header slot. An overlong request line becomes `414`; an overlong header becomes `431`. The reader may report the same low-level error for both, so the parser names the error while it still knows which grammar it was reading.

## Incremental allocation still has overhead

The initial body reader checked `Content-Length`, allocated that entire amount, and waited for the bytes. An idle client could reserve the full allowance. The revised version grows in steps:

```zig
while (body.items.len < len) {
    const want: usize = @min(len - body.items.len, CHUNK);
    try body.ensureUnusedCapacity(allocator, want);

    const dest = body.unusedCapacitySlice()[0..want];
    const n = try reader.readSliceShort(dest);
    if (n == 0) return error.IncompleteRequest;
    body.items.len += n;
}
```

Here `len` has already passed the 64 KiB limit, `body` is a growable byte array, and `CHUNK` is 16 KiB. Each read is bounded by the remaining declared length. EOF before that length is reached is an incomplete request.

This reduces speculative allocation, but it does not make memory consumption equal bytes received. The reserve happens before the read, and the array may allocate more capacity than requested to accommodate future growth. A client can still hold the next growth step without delivering it. Once these allocations use a request arena, superseded buffers may also remain allocated until the arena is released.

A fixed scratch buffer followed by appending only received bytes makes that relationship easier to inspect, at the cost of a copy. Large artifact uploads would benefit from streaming into a bounded sink instead of accumulating a complete body. The current endpoint handles small metadata documents, so the important point is to account for capacity and lifetime rather than only the final string length.

## A timer needs a socket-lifetime rule

With a serial accept loop, one client stalled halfway through a header prevents the server from serving anyone else. Concurrent handling removes that bottleneck. Bounded admission keeps concurrency from becoming unlimited resource consumption.

Barbican reserves task capacity for request workers and deadline workers. The configured task limit is `2 * 128 + 8`, allowing roughly two tasks per connection plus overhead. That is a pool-sizing policy, not an exact semaphore proving that only 128 connections exist. If either the request task or its deadline task cannot be started, the connection is closed.

The deadline worker sleeps, checks whether the request is done, and shuts down the socket's receive side if necessary. It does not close the socket handle. The request worker owns the final close and joins or cancels the timer first.

That ordering is essential. A “done” flag alone leaves a race between checking the flag and acting on the socket. If the request closes the descriptor during that gap, the operating system could reuse the number for another connection. Joining the timer before releasing the descriptor prevents the timer from operating on a different client's socket.

The timer is an absolute deadline: occasional bytes do not keep extending it. Its enforcement mechanism has a narrower scope than “request timeout,” however. Shutting down receiving can interrupt a blocked read, but cannot preempt a password hash, a database operation, or a blocked response write. Those need separate limits. When TLS is added, the timer must also begin before the handshake, since a client can connect and never send a `ClientHello`.

## Sharing SQLite changes the concurrency model

Making handlers concurrent exposes every object they share. In this version they use one SQLite connection, so opening that connection must state the synchronization policy:

```zig
const flags = c.SQLITE_OPEN_READWRITE |
    c.SQLITE_OPEN_CREATE |
    c.SQLITE_OPEN_FULLMUTEX;
```

SQLite's multi-thread mode permits concurrent use of different connections. Serialized mode additionally protects access to the same connection. The upstream default is serialized, but library builds and startup configuration can change it. `FULLMUTEX` requests serialized access for this connection, provided mutex support exists in the library. [SQLite's threading documentation](https://sqlite.org/threadsafe.html) explains those distinctions.

A serialized connection still does not make several application calls one atomic operation. If one task starts a transaction and another uses the same connection, the second task can execute inside the first task's transaction. Reading a connection's last-error state after another task has used it can also report the wrong operation's error.

The application therefore needs ownership across the whole multi-call operation: a lock around that interval, or exclusive checkout of a connection from a pool. “Thread-safe” describes individual API guarantees; it does not define transaction ownership for the service.

## Give identifiers a grammar

A package name is an identifier, so the registry can impose a small alphabet:

```text
^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$
```

This accepts 1–64 bytes, with alphanumeric endpoints and optional interior hyphens. It gives names one case convention and excludes path separators, percent escapes, and Unicode lookalikes. It does not prevent all confusing names: `zig-tom1` still resembles `zig-toml`.

Version strings have a different grammar. Their validator checks the major, minor, and patch numbers, optional prerelease identifiers, and build metadata. Numeric core and prerelease identifiers cannot have leading zeroes. Rejecting `1.01.0` prevents an invalid semantic-version spelling; it does not mean SQLite would otherwise automatically resolve it as `1.1.0`.

Validated identifiers are wrapped in Zig structs so handler signatures can distinguish a package name from an arbitrary slice. This helps prevent accidental misuse. It is still a convention within the program: code that can initialize the struct's fields can bypass the validating constructor. The type does not constitute an unforgeable security boundary.

## A C string can hide the end of a Zig slice

The identifier validator uses POSIX regular expressions through C. Zig slices carry a length; `regexec` reads a NUL-terminated string. That mismatch matters for this input:

```text
abc\x00'; DROP TABLE packages;--
```

Here `\x00` denotes a NUL byte. The regex engine sees only `abc`, while a length-aware consumer can see the suffix. JSON can carry the same byte through a `\u0000` escape.

The wrapper therefore checks the length, rejects embedded NUL, copies into a sufficiently large buffer, and adds a terminator before calling C. Rejecting embedded NUL alone is insufficient: an ordinary slice is not necessarily terminated at its end.

The pattern also needs anchors. Without `^` and `$`, `regexec` can accept a matching substring inside a larger invalid value. A regression case such as `!!!valid-name!!!` exercises that mistake directly. These checks belong at the language boundary, where the representation changes.

## Parameter binding is the SQL boundary

An identifier grammar cannot protect a free-text description. `Rust's parser` contains a quote, and `a < b` contains markup punctuation. Both are legitimate descriptions.

The unsafe operation is inserting those characters into SQL source. The replacement keeps the command fixed and supplies values separately:

```sql
INSERT INTO packages (name, description, created_at)
VALUES (?, ?, ?);
```

A simplified call then looks like this:

```zig
try db.run(insert_package, &.{
    .{ .text = name },
    .{ .text = description },
    .{ .int = created_at },
});
```

The helper prepares the statement and binds each argument. A description containing `'); DROP TABLE versions;--` remains one text value because its bytes never become SQL source. This is the property that closes value injection. If a client chooses a column to sort by, that is a different problem: SQL identifiers cannot be supplied as value parameters and need a mapping to approved query fragments.

The wrapper checks argument count because unbound placeholders otherwise become `NULL`. It also rejects an unconsumed statement tail, enforcing its one-statement contract. That tail check is useful, but the binding is what prevents input values from modifying the statement.

SQLite's text binding API also requires a lifetime decision. `SQLITE_TRANSIENT` asks SQLite to copy the bytes; `SQLITE_STATIC` requires the caller to keep them alive until the binding is replaced or the statement is finalized. The registry chooses copying so a cached statement cannot retain a pointer into a finished request. It passes an explicit byte length rather than asking SQLite to find a NUL terminator. These contracts are documented in the [SQLite binding API](https://sqlite.org/c3ref/bind_blob.html).

## Serialization is a separate boundary

Safe SQL does not produce safe JSON automatically. A handler that builds a response by concatenating strings can turn a stored description into extra response members.

The response is therefore a concrete value passed to a JSON serializer. Quotes and control characters are escaped as part of the string, and booleans are emitted as booleans. These two responses are observably different:

```json
{"yanked": false}
{"yanked": "false"}
```

The second value is a nonempty string; a JavaScript truthiness check treats it as true. A useful response test parses the output and checks types and fields, rather than only searching for expected text.

That protection ends at the JSON boundary. A browser UI still needs to insert a description as text or use context-appropriate HTML encoding. Logs also need encoding and redaction so control characters cannot forge entries and credentials cannot become permanent records.

After this phase, metadata requests have bounded input, database values use parameters, and responses use a serializer. Complete HTTP framing, downstream execution budgets, and transport security remain separate work. The [next article](/series/api-security/what-the-request-stands-on) examines ownership of parsed bytes and the TLS adapter that carries them.
