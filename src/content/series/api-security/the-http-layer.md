---
title: "Building the HTTP Boundary"
description: "Phase 0 of barbican, implemented: follow one request from a raw TCP stream through a strict HTTP parser and router into SQLite, then back out as exactly one response."
date: 2026-09-14
order: 3
tags: ["Security", "API", "HTTP", "Zig", "SQLite"]
draft: false
---

Phase 0 of barbican is a package registry with five routes, SQLite persistence, and deliberately no authentication. An anonymous caller can publish a package or yank somebody else's version. That is the control group; later phases need something genuinely vulnerable to improve.

But "no authentication" cannot mean "no boundaries." Before an authorization check can run, the server has already decided where the request ends, which method it names, which resource the path identifies, how much memory its body may consume, and whether an error has already produced a response. If any decision is ambiguous, a perfect authorization function will receive the wrong inputs.

So this is a walk through one request as the code handles it: `accept` → request line → headers → bounded body → route → typed JSON → SQLite → response. The point is not a list of rules. It is where each rule lives, what its interface makes impossible, and which holes Phase 0 intentionally leaves open.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/parser-boundary.svg" alt="The request path through barbican: a TCP stream enters connection.serve, becomes a parsed request line and headers, is bounded before allocation, matched by method and path, parsed into a concrete body type, handled through SQLite, and returned through one response writer. Red marks client-controlled bytes, indigo marks enforced invariants, and amber marks deliberately open Phase 0 boundaries.">
  <img class="plate-dark" src="/images/api-security/parser-boundary-dark.svg" alt="The request path through barbican: a TCP stream enters connection.serve, becomes a parsed request line and headers, is bounded before allocation, matched by method and path, parsed into a concrete body type, handled through SQLite, and returned through one response writer. Red marks client-controlled bytes, indigo marks enforced invariants, and amber marks deliberately open Phase 0 boundaries.">
  <figcaption>The implementation narrows types as the request moves right. Phase 0 deliberately stops narrowing before SQL and JSON output.</figcaption>
</figure>

## Contain failure to one connection

The outer loop owns process lifetime. A parser error belongs to the connection that caused it, not to the listener:

```zig
while (true) {
    const conn = try server.accept(io);
    http.connection.serve(io, &ctx, conn) catch |err| {
        std.log.err("serving request: {t}", .{err});
    };
}
```

`accept` is allowed to escape because the listener itself has failed. Everything after it is caught. Inside `serve`, `defer conn.close(io)` makes the connection's owner explicit even when parsing, allocation, routing, or writing returns early.

This first version handles exactly one request per connection. That is inefficient, and currently useful. If the parser reads fewer body bytes than the sender intended, closing the socket discards the remainder. With keep-alive, those bytes would be waiting where the next request line is expected. Adding connection reuse later is therefore not just a performance change; it changes the exploitability of every framing mistake in this post.

The simple loop also has a cost: no concurrency, connection limit, or read deadline. One client can connect and send a request one byte at a time while the only accept loop waits. The body is bounded; time is not. That remains an availability finding for a later phase.

The state a handler may use is passed explicitly:

```zig
pub const Ctx = struct {
    db: *SQLDatabase,
    allocator: std.mem.Allocator,
    io: std.Io,
};
```

There is no module-global database handle. Later, the authenticated principal and request ID can join this context without turning request-scoped state into a global. `io` is present because Zig 0.16 makes the clock an explicit capability; the server, not the request body, generates `created_at`.

## Read the claim before paying for it

On the wire, HTTP/1.1 is a sequence of delimiters. The blank line ends the headers; `Content-Length` says how many bytes follow; on a persistent connection, the byte after that belongs to the next request. The parser's first job is therefore not JSON. It is deciding which bytes are this request at all.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/http-wire-format.svg" alt="An annotated HTTP request as a byte stream. The request line has exactly three fields. Header names, the colon boundary, optional value whitespace, the blank line, the bounded body, and the start of a possible next request are distinct regions.">
  <img class="plate-dark" src="/images/api-security/http-wire-format-dark.svg" alt="An annotated HTTP request as a byte stream. The request line has exactly three fields. Header names, the colon boundary, optional value whitespace, the blank line, the bounded body, and the start of a possible next request are distinct regions.">
  <figcaption>`connection.serve` consumes the stream in wire order. It does not allocate the body until the header block is parsed and the declared length passes the server's bound.</figcaption>
</figure>

The relevant part of `serve` is short enough to keep in one view:

```zig
var content_length: ?u32 = null;
while (true) {
    const raw = syntax.trimLineEnd(
        try reader.interface.takeDelimiterInclusive('\n'),
    );
    if (raw.len == 0) break;

    const header = try request.parseHeader(raw);
    if (std.ascii.eqlIgnoreCase(header.name, "Content-Length")) {
        if (content_length != null) return error.BadRequest;
        content_length = try std.fmt.parseInt(u32, header.value, 10);
    }
}

const len = content_length orelse 0;
if (len > MAX_BODY) {
    return response.respond(w, .content_too_large,
        "{\"error\":\"body too large\"}");
}

const body = try ctx.allocator.alloc(u8, len);
defer ctx.allocator.free(body);
try reader.interface.readSliceAll(body);
```

There are three separate decisions here.

First, header names are compared case-insensitively because HTTP field names are case-insensitive. `content-length` must not become an invisible second spelling.

Second, a repeated `Content-Length` is rejected even when both values agree. Accepting the first, accepting the last, and requiring equality are three plausible policies—and three chances for a proxy and this server to choose differently. Refusing the shape removes the choice.

Third, `len` is checked **before** it reaches the allocator. With the opposite ordering, a header declaring `Content-Length: 999999999` needs no body to be expensive. The declaration alone would request almost a gigabyte. Here it receives `413` before allocation and before a body read.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/bound-before-read.svg" alt="Two control flows for an oversized Content-Length. The unsafe path allocates from the client value before any body arrives. Barbican's path parses into u32, compares against a 64 KiB maximum, returns 413, and never reaches allocation or read.">
  <img class="plate-dark" src="/images/api-security/bound-before-read-dark.svg" alt="Two control flows for an oversized Content-Length. The unsafe path allocates from the client value before any body arrives. Barbican's path parses into u32, compares against a 64 KiB maximum, returns 413, and never reaches allocation or read.">
  <figcaption>An attacker-controlled length cannot reach `alloc` until a server-controlled maximum has narrowed it.</figcaption>
</figure>

The current bound is `64 * 1024`. Parsing into `u32` also rejects a decimal value that does not fit rather than truncating it on a later cast. This is not a complete availability design: the total number of headers and the time spent reading them still need explicit limits. It is one complete data-flow path, from an untrusted number to the allocation it could influence.

## Make the request line have one meaning

The request-line parser produces a typed `Method` plus borrowed slices for the target and version:

```zig
pub fn parseRequestLine(line: []const u8) Error!RequestLine {
    var splits = std.mem.splitScalar(u8, line, ' ');

    const method = try Method.parse(
        splits.next() orelse return error.MalformedLine,
    );
    const target = splits.next() orelse return error.MalformedLine;
    const version = splits.next() orelse return error.MalformedLine;

    if (splits.next() != null) return error.MalformedLine;
    if (version.len == 0 or target.len == 0) return error.MalformedLine;
    if (target[0] != '/') return error.MalformedLine;

    return .{ .method = method, .target = target, .version = version };
}
```

`splitScalar`, rather than a whitespace tokenizer, is deliberate. `GET  /x HTTP/1.1` contains an empty second field and fails; it is not silently normalised. The extra `splits.next()` proves there are exactly three fields without a counter whose meaning changes after an early `break`.

`Method.parse` uses `std.mem.eql`, not `eqlIgnoreCase`. HTTP methods are case-sensitive, and the method will later become an authorization input: a policy for `DELETE` must not disagree with a router that also accepts `delete`.

The leading slash restricts the target to origin-form, the only form this origin server implements. Absolute-form and authority-form do not drift into routing code that was never designed to assign them a resource.

One missing check is visible in the snippet: `version` only has to be non-empty. `HTTP/9.9` currently passes. Phase 1 needs to require the protocol version the connection code actually implements instead of carrying an unvalidated string deeper into the server.

## Parse a header asymmetrically

A header is not `trim(line).split(':')`. The name and value have different grammars, so the implementation treats them differently:

```zig
pub fn parseHeader(line: []const u8) Error!Header {
    const idx = std.mem.indexOfScalar(u8, line, ':') orelse
        return error.MalformedHeader;

    const name = line[0..idx];
    if (!syntax.isToken(name)) return error.MalformedHeader;

    return .{
        .name = name,
        .value = std.mem.trim(u8, line[idx + 1 ..], syntax.OWS),
    };
}
```

The first colon is the boundary because values may contain colons: `Host: localhost:8080` must keep `localhost:8080`. The value permits optional space or tab around its content. The name permits neither.

That asymmetry closes a real framing disagreement. Given `Content-Length\t: 5`, a proxy that trims the name sees `Content-Length`; a server that preserves it sees an unrelated field named `Content-Length\t` and concludes there is no body. The five bytes one hop consumed as a body become the next request at the other hop.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/request-smuggling-tab.svg" alt="A two-lane request-smuggling trace. The same Content-Length-with-tab reaches a normalising proxy and a literal server. The proxy treats five following bytes as a body; the server sees no Content-Length and treats them as the next request. A rejection gate before either interpretation is the implemented fix.">
  <img class="plate-dark" src="/images/api-security/request-smuggling-tab-dark.svg" alt="A two-lane request-smuggling trace. The same Content-Length-with-tab reaches a normalising proxy and a literal server. The proxy treats five following bytes as a body; the server sees no Content-Length and treats them as the next request. A rejection gate before either interpretation is the implemented fix.">
  <figcaption>`isToken(name)` rejects the request before barbican asks whether the field is `Content-Length`. The malformed name never gets to become an invisible header.</figcaption>
</figure>

The first version of this check grew as a denylist: reject a leading space; reject a trailing tab; add another case when a test finds it. A header name is already defined as one or more `tchar` bytes, so the code implements that alphabet once:

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

Now internal space, NUL, carriage return, and bytes above ASCII fail without appearing in four separate conditionals.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/allowlist-vs-denylist.svg" alt="A byte-alphabet comparison. A denylist removes a few remembered bad bytes but leaves a large unknown accepted region. The implemented token allowlist admits only letters, digits, and RFC tchar punctuation; every other byte is rejected by the same loop.">
  <img class="plate-dark" src="/images/api-security/allowlist-vs-denylist-dark.svg" alt="A byte-alphabet comparison. A denylist removes a few remembered bad bytes but leaves a large unknown accepted region. The implemented token allowlist admits only letters, digits, and RFC tchar punctuation; every other byte is rejected by the same loop.">
  <figcaption>The allowlist describes the language the parser accepts, not an expanding history of attacks it remembers.</figcaption>
</figure>

There is still a loose edge one layer above `parseHeader`: `trimLineEnd` removes a set of carriage-return and line-feed bytes, so a bare LF and repeated terminators are accepted. It must become an exact CRLF check. The connection code also needs an explicit policy for `Transfer-Encoding` rather than ignoring the field. Strictness is useful only when it covers the whole framing grammar; these are recorded gaps, not details hidden by calling the parser "strict."

Malformed request-line and header errors currently close the connection without an HTTP error response. Handler errors get structured JSON later in the pipeline. That difference is visible in the smoke suite and should remain deliberate until a parser-error response can itself be written safely.

## Route with the method and the path

The route table describes five operations:

```text
POST    /packages
GET     /packages/{name}
POST    /packages/{name}/versions
GET     /packages/{name}/versions/{semver}
DELETE  /packages/{name}/versions/{semver}
```

`Route.matches` compares both method and path. If routing were keyed only by path, `DELETE /packages/p/versions/1.0.0` could reach a `GET` handler written under the assumption that reads are public. The router would have changed an authorization input before authorization even ran.

Matching and capture extraction share one segment walker:

```zig
fn matches(self: *const Route, method: Method, target: []const u8) bool {
    if (self.method != method) return false;
    var walk: Walk = .init(self.path, target);
    while (true) switch (walk.next()) {
        .done => return true,
        .mismatch => return false,
        .literal, .capture => {},
    };
}

fn extract(self: *const Route, target: []const u8) Params {
    var out: Params = .{};
    var walk: Walk = .init(self.path, target);
    while (true) switch (walk.next()) {
        .done, .mismatch => return out,
        .literal => {},
        .capture => |param| {
            out.items[out.len] = param;
            out.len += 1;
        },
    };
}
```

This looks like duplicated work, but it avoids duplicated rules. `matches` is a pure predicate and cannot leave behind half-valid captures from a route that failed on its final segment. `extract` runs only after a winner exists, using the same `Walk`, so it cannot disagree about doubled slashes, trailing slashes, literal case, or empty captures.

The query string is stripped before matching, which prevents `{name}` from capturing `barbican?admin=true`. Paths are compared case-sensitively, and trailing or doubled slashes are rejected rather than normalised into a second spelling of the same resource. Route patterns are validated when registered; a pattern with more than four placeholders cannot overflow `Params` because the server refuses to start with it.

Matching does **not** percent-decode. If `%2f` became `/` before splitting, one client-chosen segment could become several after the router had decided the path's shape. The intended order is:

```text
split into segments → decode each segment → normalise once → validate
```

Phase 0 currently stops after the first step. Captured names and versions are neither decoded nor semantically validated, and that is exactly where the live injection finding enters.

## Parse JSON into a capability, not a bag of fields

The body parser exposes concrete request shapes rather than `std.json.Value`:

```zig
pub const CreatePackage = struct {
    name: []const u8,
    description: []const u8,
};

pub const PublishVersion = struct {
    version: []const u8,
    checksum: []const u8,
};

return std.json.parseFromSlice(T, gpa, body, .{
    .duplicate_field_behavior = .@"error",
    .ignore_unknown_fields = false,
}) catch return error.BadJson;
```

There is no `created_at` in `CreatePackage` and no `yanked` in `PublishVersion`. The client cannot assign either because the parser has no place to put them. An unknown `owner` field is rejected instead of being silently ignored, and duplicate `name` keys are rejected instead of choosing first-wins or last-wins.

Parsing into a concrete struct also rejects a deeply nested array at the first token; there is no dynamic JSON tree whose depth the attacker controls. But this is only **shape validation**. A 10 KB package name is valid JSON and reaches the handler. Phase 1 must add value validation—length, alphabet, and semver—after decoding and before the data reaches any output grammar.

## The handler exposes the remaining boundary

Every handler follows the same success path:

```zig
const parsed = try body_parser.parse(CreatePackage, ctx.allocator, body);
defer parsed.deinit();

var sql_buf: [2048]u8 = undefined;
const sql = try std.fmt.bufPrintZ(&sql_buf, commands.insert_package, .{
    parsed.value.name,
    parsed.value.description,
    try now(ctx.io, &ts_buf),
});
try ctx.db.run(sql);

var json_buf: [4096]u8 = undefined;
const out = try std.fmt.bufPrint(&json_buf,
    \\{{"name":"{s}","description":"{s}"}}
, .{ parsed.value.name, parsed.value.description });
try response.respond(w, .created, out);
```

This is where narrowing stops. `name` and `description` are data while JSON is parsed, then become SQL syntax through `bufPrintZ`, then become JSON syntax through `bufPrint`. The fixed buffers prevent those operations from allocating without limit, but `error.NoSpaceLeft` becoming a `500` is not input validation, and a short malicious value fits easily.

The database wrapper does three pieces of C-boundary work that are easy to miss:

- Every SQLite return code becomes a Zig error instead of an ignored integer.
- `sqlite3_column_text` is paired with `sqlite3_column_bytes` to recover a bounded slice from a C pointer.
- Row text is duplicated before the next `step` or `finalize` invalidates SQLite's borrowed memory.

It also classifies extended constraint codes:

```zig
return switch (sqlite3_extended_errcode(handle)) {
    SQLITE_CONSTRAINT_PRIMARYKEY,
    SQLITE_CONSTRAINT_UNIQUE     => error.Duplicate,
    SQLITE_CONSTRAINT_FOREIGNKEY => error.MissingParent,
    else                         => error.ExecFailed,
};
```

That distinction survives to the response: duplicate package or version → `409`; missing parent package → `404`; an unrecognised storage failure → `500`. `SQLITE_DONE` is kept separate from a failed `step`, so a locked database cannot masquerade as "not found."

The schema contributes a security property of its own:

```sql
CREATE TABLE versions (
  name     TEXT NOT NULL REFERENCES packages(name),
  semver   TEXT NOT NULL,
  checksum TEXT NOT NULL,
  yanked   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (name, semver)
);
```

The composite primary key makes an already-published version immutable on every write path. SQLite foreign keys, however, are disabled by default on every connection, so `open` executes `PRAGMA foreign_keys = ON` before applying the schema. The test does not assert that the pragma ran. It attempts to insert a version for a nonexistent package and expects `error.MissingParent`. SQLite silently ignores an unknown pragma; testing the resulting behaviour is what catches a typo in the setting.

## Make one response the only possible response

All success and error responses pass through `respond`, where `Content-Length` is computed from `body.len`; callers cannot supply it. The guarantee is in the function signature, not in a comment asking every handler to count correctly.

The first error-handling shape still allowed a different desynchronization bug: a handler could write an error response, forget `return`, and then write its success response. The fix was to remove error responses from handlers entirely:

```zig
if (route.matches(method, target)) {
    const params = route.extract(target);
    route.handler(ctx, w, &params, body) catch |err| {
        std.log.err("{t} {s}: {t}", .{ method, target, err });
        try response.fail(w, err);
    };
    return;
}
```

A handler either reaches its one success `respond`, or returns an error before it. `dispatch` catches that error and calls `response.fail` once. The underlying SQLite error is logged, while the client gets a fixed message such as `{"error":"internal error"}` rather than `UNIQUE constraint failed: packages.name`.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/response-splitting-error-path.svg" alt="Before and after control-flow diagrams for handler errors. In the unsafe version an error branch writes 404 and falls through to a 201 response. In the implemented version the handler returns an error value to dispatch, which alone maps it through response.fail, while only the success path may write 201.">
  <img class="plate-dark" src="/images/api-security/response-splitting-error-path-dark.svg" alt="Before and after control-flow diagrams for handler errors. In the unsafe version an error branch writes 404 and falls through to a 201 response. In the implemented version the handler returns an error value to dispatch, which alone maps it through response.fail, while only the success path may write 201.">
  <figcaption>The invariant is not "remember to return." No handler API exists for writing an error response, so the fall-through shape cannot be expressed.</figcaption>
</figure>

With one request per connection, the extra response would currently be junk before close. With keep-alive or an intermediary pooling connections, it can be mistaken for the response to the next request. Fixing the control flow now means connection reuse does not inherit a known response-queue desynchronization.

## What Phase 0 leaves live

The parser and response writer close ambiguities needed to give later controls stable inputs. They do not make the API secure. Three attacks are deliberately executable against the current branch.

### SQL injection

`sqlite3_exec` accepts multiple statements, and the handler interpolates the description into one of them:

```sh
curl -X POST "$BASE/packages" \
  -d $'{"name":"pwn","description":"x\', \'ts\'); DROP TABLE versions;--"}'
```

This returns `201`, and `versions` is gone. The common `x'); DROP...` payload fails because it leaves the original three-column `INSERT` with only two values; `sqlite3_exec` stops at that first error. The working payload supplies the missing value before closing the statement. One failed canned payload would have looked like protection if the test had not inspected the SQL being produced.

### JSON injection

The same mistake exists in a second grammar:

```sh
curl -X POST "$BASE/packages" \
  -d '{"name":"evil\",\"admin\":\"true","description":"d"}'
```

Because the response is assembled with string interpolation, the quote in `name` ends the string and forges a sibling field:

```json
{"name":"evil","admin":"true","description":"d"}
```

Phase 1 will replace SQL interpolation with prepare/bind and JSON interpolation with the standard serializer. The fixes look different at the API level and share one property: values travel to the grammar through a data channel, never by concatenation into its source text.

### No identity, no ownership

The `DELETE` route is intentionally public:

```sh
curl -X DELETE \
  "$BASE/packages/zig-toml/versions/0.1.0"
# 200 OK
```

It performs a yank rather than deleting the row, so existing lockfiles can still resolve the version. That package-registry invariant works. The authorization invariant does not exist: the handler has no principal to compare with an owner.

The smoke suite has a `VERIFY` half for ordinary behaviour and an `ATTACK` half that expects all three findings to succeed. As controls land, each attack moves from an expected success to an expected failure. That transition—not the existence of a validation function—is the evidence that a phase changed the system.

The honest state at the end of Phase 0 is:

| Implemented now | Deliberately open | Deferred parser and availability gaps |
|---|---|---|
| Body bound before allocation | SQL values become syntax | Exact CRLF enforcement |
| Token-only header names | JSON values become syntax | `Transfer-Encoding` policy |
| Duplicate `Content-Length` rejected | Anonymous publish and yank | Exact HTTP version check |
| Method + path routing | No ownership model | Header-count and time limits |
| Concrete JSON body types | No audit identity | Concurrency and connection caps |
| Schema-enforced version immutability | Plaintext transport | Percent-decode + value validation |
| One error-to-response boundary | | |

That is enough structure to build on without pretending the phase is finished. Authentication will eventually answer *who*. Authorization will answer *may they do this to that package*. Both will depend on the less glamorous work here: turning one byte stream into one request, one route, and one response.

---

*Next: the injection boundary—parameterised queries, output encoding, and the validators between decoding and use.*
