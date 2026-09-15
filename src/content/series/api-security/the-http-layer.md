---
title: "Request Smuggling, Remote OOM, and Response Splitting"
description: "Phase 0 of barbican: the attacks a server is exposed to before authentication exists, and the parser decisions that close them — framing disagreements between hops, unbounded allocation from a declared length, and two responses on one connection."
date: 2026-09-14
order: 3
tags: ["Security", "API", "HTTP", "Zig", "SQLite"]
draft: false
---

Barbican is a package registry with five routes, SQLite persistence, and deliberately no authentication — a control group for later phases to improve on.

No authentication does not mean no attacks. Before any authorization check can run, the server has already decided where the request ends, which method it names, which resource the path identifies, and how much memory the body may consume. Each of those decisions is attackable on its own, and a perfect authorization function fed the wrong inputs is not a control.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/parser-boundary.svg" alt="A left-to-right pipeline from untrusted bytes through request line, headers, body, route, typed body and row to response. Each stage narrows the type and may reject.">
  <img class="plate-dark" src="/images/api-security/parser-boundary-dark.svg" alt="A left-to-right pipeline from untrusted bytes through request line, headers, body, route, typed body and row to response. Each stage narrows the type and may reject.">
</figure>

## Attack: a length that costs memory before a body arrives

`Content-Length: 999999999` is 25 bytes on the wire. If the declared length reaches the allocator before it is checked, those 25 bytes request a gigabyte, and no body ever has to be sent.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/bound-before-read.svg" alt="Two control flows for an oversized Content-Length. Allocating first reaches a four-gibibyte allocation. Checking first returns 413 and never reaches the allocator.">
  <img class="plate-dark" src="/images/api-security/bound-before-read-dark.svg" alt="Two control flows for an oversized Content-Length. Allocating first reaches a four-gibibyte allocation. Checking first returns 413 and never reaches the allocator.">
</figure>

## Fix: compare against a server-chosen bound first

```zig
const len = content_length orelse 0;
if (len > MAX_BODY) {
    return response.respond(w, .content_too_large, "{\"error\":\"body too large\"}");
}

const body = try ctx.allocator.alloc(u8, len);
```

The ordering is the control, not the constant. Parsing into `u32` also rejects a decimal that does not fit rather than truncating it on a later cast — a truncating cast on a length is how bounds checks get bypassed.

## Attack: two hops disagree about where the request ends

HTTP/1.1 is delimiters. The blank line ends the headers, `Content-Length` says how many bytes follow, and the next byte belongs to the next request. Any disagreement about those boundaries between a proxy and this server lets the attacker decide which hop sees what.

Three shapes produce the disagreement. **A repeated `Content-Length`** — accept-first, accept-last and require-equal are three plausible policies and three chances to differ from whatever sits in front of you. **A case-varied name**, because HTTP field names are case-insensitive and `content-length` must not become an invisible second spelling. And **whitespace before the colon**, which is the sharpest of the three:

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/request-smuggling-tab.svg" alt="The same header with a tab before the colon. A proxy that trims the name sees a Content-Length and treats five following bytes as a body; a server that preserves it sees no such header and treats those bytes as a new request.">
  <img class="plate-dark" src="/images/api-security/request-smuggling-tab-dark.svg" alt="The same header with a tab before the colon. A proxy that trims the name sees a Content-Length and treats five following bytes as a body; a server that preserves it sees no such header and treats those bytes as a new request.">
</figure>

A proxy that trims the name sees `Content-Length` and consumes five bytes as a body. A server that preserves it sees a field named `Content-Length\t`, concludes there is no body, and reads those same five bytes as the start of the next request. The attacker has written the beginning of someone else's request.

## Fix: reject the shape rather than pick an interpretation

```zig
pub fn parseHeader(line: []const u8) Error!Header {
    const idx = std.mem.indexOfScalar(u8, line, ':') orelse return error.MalformedHeader;

    const name = line[0..idx];
    if (!syntax.isToken(name)) return error.MalformedHeader;

    return .{ .name = name, .value = std.mem.trim(u8, line[idx + 1 ..], syntax.OWS) };
}
```

Name and value have different grammars and are treated differently. Splitting at the **first** colon keeps `Host: localhost:8080` intact. The value permits surrounding space or tab; the name permits neither, so the tab is rejected before anything asks whether the field is `Content-Length`.

A duplicate `Content-Length` is refused even when both values agree, and names compare case-insensitively. Refusing the shape removes the choice that two hops could make differently.

## Attack: every byte nobody listed is accepted

A check written as "reject a leading space, reject a trailing tab" grows one case per discovered attack and silently accepts everything unlisted — NUL, bare CR, bytes above ASCII.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/allowlist-vs-denylist.svg" alt="The 128 ASCII bytes shown twice. A denylist marks two refused bytes and leaves the rest accepted. An allowlist marks the 77 bytes it accepts and refuses everything else.">
  <img class="plate-dark" src="/images/api-security/allowlist-vs-denylist-dark.svg" alt="The 128 ASCII bytes shown twice. A denylist marks two refused bytes and leaves the rest accepted. An allowlist marks the 77 bytes it accepts and refuses everything else.">
</figure>

## Fix: implement the alphabet the grammar defines

```zig
fn isTchar(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or
        std.mem.indexOfScalar(u8, "!#$%&'*+-.^_`|~", c) != null;
}

fn isToken(text: []const u8) bool {
    if (text.len == 0) return false;
    for (text) |c| if (!isTchar(c)) return false;
    return true;
}
```

A field name is one or more `tchar` bytes. Stating that once rejects internal space, NUL, carriage return and high bytes in the same loop — including the cases nobody has enumerated yet.

## Attack: an ambiguous request line

`GET  /x HTTP/1.1` has an empty second field: a parser that normalises runs of whitespace accepts it, one that does not rejects it, and that is another two-hop disagreement.

A lowercase `delete` reaching a `DELETE` handler matters because the method becomes an authorization input later — a policy for `DELETE` must not disagree with a router that also accepts `delete`.

An absolute-form target (`GET http://evil.example/x`) makes an origin server into a forward proxy; authority-form makes it an open one.

## Fix: exactly three fields, case-sensitive method, origin-form only

```zig
var splits = std.mem.splitScalar(u8, line, ' ');

const method = try Method.parse(splits.next() orelse return error.MalformedLine);
const target = splits.next() orelse return error.MalformedLine;
const version = splits.next() orelse return error.MalformedLine;

if (splits.next() != null) return error.MalformedLine;
if (version.len == 0 or target.len == 0) return error.MalformedLine;
if (target[0] != '/') return error.MalformedLine;
```

`splitScalar` rather than a whitespace tokenizer: a doubled space produces an empty field and fails instead of being silently normalised. The extra `splits.next()` proves there are exactly three fields without a counter whose meaning changes after an early `break`. `Method.parse` uses `std.mem.eql`, not `eqlIgnoreCase`.

## Attack: a path that means two things to the router

`%2f` decoded before splitting turns one client-chosen segment into several *after* the router has decided the path's shape. A query string left attached lets `{name}` capture `barbican?admin=true`. Trailing and doubled slashes create second spellings of one resource, and a policy attached to one spelling does not cover the other.

Routing on the path alone is its own attack: `DELETE /packages/p/versions/1.0.0` reaching a `GET` handler written on the assumption that reads are public means the router changed an authorization input before authorization ran.

## Fix: match on method and path, and never decode before splitting

The order is fixed:

```text
split into segments → decode each segment → normalise once → validate
```

Phase 0 stops after the first step, so captures are neither decoded nor validated — which is where the live injection finding enters. What is enforced: the query string is stripped before matching, paths compare case-sensitively, trailing and doubled slashes are rejected rather than normalised, and route patterns are validated at registration so a pattern with too many placeholders cannot overflow the capture array — the server refuses to start instead.

Matching and capture extraction share one segment walker. `matches` is a pure predicate, so a route failing on its last segment cannot leave half-valid captures behind; `extract` runs only after a winner exists and so cannot disagree about slashes, case, or empty captures.

## Attack: a client sets a field the server owns

A body parsed into a dynamic tree lets a client supply `created_at`, `yanked`, or `owner`. Silently ignoring unknown fields is what makes mass assignment quiet. Duplicate keys reintroduce the first/last disagreement inside JSON.

## Fix: parse into a concrete type with strict options

```zig
pub const CreatePackage = struct {
    name: []const u8,
    description: []const u8,
};

return std.json.parseFromSlice(T, gpa, body, .{
    .duplicate_field_behavior = .@"error",
    .ignore_unknown_fields = false,
}) catch return error.BadJson;
```

There is no `created_at` in `CreatePackage` and no `yanked` in `PublishVersion`. The client cannot assign either because the parser has no field to put them in — the server generates the timestamp, and yanking is an operation with its own route and its own authorization question, not a field.

Parsing into a concrete struct also refuses a deeply nested document at the first token: there is no dynamic tree whose depth an attacker controls. This is shape validation only. A 10 KiB package name is valid JSON and reaches the handler.

## Attack: a storage error becomes a wrong answer

Collapsing "no rows" with "the query failed" lets a locked database masquerade as `404`. Returning `sqlite3_errmsg` to the client leaks the schema: `UNIQUE constraint failed: packages.name`.

## Fix: classify extended codes, keep the detail server-side

```zig
return switch (sqlite3_extended_errcode(handle)) {
    SQLITE_CONSTRAINT_PRIMARYKEY,
    SQLITE_CONSTRAINT_UNIQUE     => error.Duplicate,      // 409
    SQLITE_CONSTRAINT_FOREIGNKEY => error.MissingParent,  // 404
    else                         => error.ExecFailed,     // 500
};
```

The plain `SQLITE_CONSTRAINT` code cannot separate a duplicate key — the client's problem — from a NOT NULL violation, which is a server bug. `SQLITE_DONE` stays distinct from a failed `step`. The client receives a fixed message; the underlying text goes to the log.

The schema carries two guarantees of its own:

```sql
CREATE TABLE versions (
  name     TEXT NOT NULL REFERENCES packages(name),
  semver   TEXT NOT NULL,
  checksum TEXT NOT NULL,
  yanked   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (name, semver)
);
```

The composite primary key makes a published version immutable on every write path — without it, anyone able to publish can retroactively swap the contents of a version others have pinned. Foreign keys are **disabled by default on every SQLite connection**, so `open` runs `PRAGMA foreign_keys = ON` before applying the schema. SQLite silently ignores an unknown pragma, so the test inserts a version for a nonexistent package and expects `error.MissingParent` rather than asserting the setting was applied.

## Attack: two responses on one connection

A handler that writes an error response and then falls through to its success response sends two complete messages. The client parses the second as the response to the *next* request.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/response-splitting-error-path.svg" alt="A handler that responds and forgets to return emits both a 404 and a 201; the second is read as the next response. A handler that returns an error emits one response through a single mapper.">
  <img class="plate-dark" src="/images/api-security/response-splitting-error-path-dark.svg" alt="A handler that responds and forgets to return emits both a 404 and a 201; the second is read as the next response. A handler that returns an error emits one response through a single mapper.">
</figure>

The same desynchronization arrives from a declared `Content-Length` that disagrees with the bytes written — the recipient reads the wrong number and parses the remainder as the start of the next message.

## Fix: remove the ability to write an error response

```zig
route.handler(ctx, w, &params, body) catch |err| {
    std.log.err("{t} {s}: {t}", .{ method, target, err });
    try response.fail(w, err);
};
```

A handler either reaches its single success `respond` or returns an error before it, and `dispatch` maps that error once. There is no handler API for writing an error response, so the fall-through shape cannot be expressed rather than merely being discouraged.

`Content-Length` is computed inside `respond` from `body.len` and is not a parameter, so a declared length cannot disagree with what was written. `X-Content-Type-Options: nosniff` goes on every response, because without it a browser may ignore the declared type and guess from the bytes — a JSON body beginning with `<` becomes HTML.

One request per connection, then close, is currently load-bearing: unread body bytes are discarded by the close rather than left where the next request line is expected. Adding keep-alive later changes the exploitability of every framing mistake above.

## Attack: a failure that reaches the listener

An error propagating out of the accept loop exits the process, which turns any parse bug into a way to take the whole service down with one request.

## Fix: the connection owns its failures

```zig
while (true) {
    const conn = try server.accept(io);
    http.connection.serve(io, &ctx, conn) catch |err| {
        std.log.err("serving request: {t}", .{err});
    };
}
```

`accept` is allowed to escape, because the listener itself has failed. Everything after it is caught. Handler state is passed explicitly rather than held in a module global, so request-scoped values — an authenticated principal, a request ID — have somewhere to live later that is not global.

## Attacks left open on purpose

Three attacks are executable against this branch on purpose.

**SQL injection.** `sqlite3_exec` accepts multiple statements and the handler interpolates the description into one:

```sh
curl -X POST "$BASE/packages" \
  -d $'{"name":"pwn","description":"x\', \'ts\'); DROP TABLE versions;--"}'
```

Returns `201`; `versions` is gone. The usual `x'); DROP...` payload fails here because it leaves the three-column `INSERT` with two values and `exec` stops at that error — the working payload supplies the missing value before closing the statement.

**JSON injection**, the same defect in a second grammar:

```sh
curl -X POST "$BASE/packages" -d '{"name":"evil\",\"admin\":\"true","description":"d"}'
```

```json
{"name":"evil","admin":"true","description":"d"}
```

**No identity, no ownership.** `DELETE /packages/zig-toml/versions/0.1.0` returns `200` for anyone. The yank semantics are right — the row is marked, not removed, so existing lockfiles still resolve — but the handler has no principal to compare against an owner.

Also open and recorded: `version` is only checked non-empty, so `HTTP/9.9` passes; `trimLineEnd` accepts a bare LF instead of requiring exact CRLF; there is no `Transfer-Encoding` policy; and there is no header count limit, no connection limit and no read deadline, so one client sending a byte at a time occupies the only accept loop indefinitely.

Next: [what a request may cost, and what its values may mean](/series/api-security/bounding-a-request).
