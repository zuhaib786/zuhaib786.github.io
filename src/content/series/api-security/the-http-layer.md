---
title: "Building the HTTP Boundary of a Zig API"
description: "How request framing, routing, typed JSON, and database constraints fit together in a small package registry, and where the first implementation still falls short."
date: 2026-09-14
order: 3
tags: ["Security", "API", "HTTP", "Zig", "SQLite"]
draft: false
---

A package registry has a small set of operations: create a package, publish a version, read its metadata, and withdraw a release from future resolution. I am building one in Zig, called Barbican, to understand the security decisions underneath those operations. The initial version has five routes and a SQLite database. It has no authentication yet.

Consider a request to yank a release:

```http
DELETE /packages/zig-toml/versions/0.1.0 HTTP/1.1
Host: registry.example
```

Eventually, an ownership check must establish whether this caller may modify this package. But before that check can run, the HTTP parser and router have already decided the action and package. If those components interpret the bytes incorrectly, a correct permission check can still receive the wrong inputs.

This first part is about establishing those inputs: where a request ends, which resource it identifies, which fields a client may set, and what the database can enforce. The snippets are small extracts or simplified examples using Zig 0.16; they illustrate the decisions without requiring the rest of the project.

## Message boundaries come before handlers

A TCP read is not an HTTP message. One read might contain half a header, an entire request, or the beginning of the next request. The parser has to recover boundaries from the byte stream.

For a request with `Content-Length`, the blank line ends the headers and the declared number determines how many body bytes follow. That creates two obligations before allocation: parse the number without overflow, and compare it with a server-chosen limit.

```zig
const len = content_length orelse 0;
if (len > MAX_BODY) return error.BodyTooLarge;

const body = try allocator.alloc(u8, len);
try reader.readSliceAll(body);
```

Here `content_length` is an optional parsed integer. In the limited framing model above, absence means no body. This code assumes transfer coding has already been ruled out; it is not a complete HTTP body-length algorithm.

A short header can declare several gigabytes. Checking the limit after allocating would therefore be too late, even if the client never sends a body. Parsing into a bounded integer catches representation overflow, but a number that fits in `u32` can still exceed the request budget. The decimal grammar also needs checking: a general integer parser may accept spellings that HTTP does not.

This first strategy still reserves the entire allowed body up front. A 64 KiB cap limits the damage per connection; it does not make thousands of idle connections affordable. The [next article](/series/api-security/bounding-a-request) addresses incremental allocation and deadlines.

## Why parser disagreements matter

Suppose a reverse proxy forwards requests over a persistent connection to the registry. Both systems must agree where each request ends. Now give them this header section:

```http
POST /packages HTTP/1.1
Host: registry.example
Content-Length: 5
Content-Length: 40
```

If the proxy uses the first length and the server uses the second, they assign different meanings to the following bytes. Data one hop considers part of a body can become another request at the next hop. This is the mechanism behind HTTP request smuggling. A malformed request alone is not proof of an exploit; connection reuse and the behavior of both parsers determine the outcome.

Barbican rejects repeated `Content-Length` fields, even when the values agree. That is deliberately stricter than HTTP's limited recovery allowance for identical lengths. Conflicting lengths cannot be guessed at. The framing rules are specified in [RFC 9112, section 6.3](https://www.rfc-editor.org/rfc/rfc9112.html#section-6.3).

Whitespace can create the same disagreement. In the following example, `\t` represents an actual tab:

```text
Content-Length\t: 5
```

A parser that trims the name recognizes a length field. One that preserves the tab may treat it as an unrelated field. The solution is to reject the malformed name before deciding what the header means.

```zig
const colon = std.mem.indexOfScalar(u8, line, ':')
    orelse return error.MalformedHeader;
const name = line[0..colon];
if (!isToken(name)) return error.MalformedHeader;

const value = std.mem.trim(u8, line[colon + 1 ..], " \t");
```

The first colon separates name from value; later colons belong to the value, as in `Host: localhost:8080`. Optional space and tab are trimmed around the value. They are not permitted inside the name. Names compare case-insensitively, so `content-length` cannot evade the duplicate check.

`isToken` accepts alphanumerics and HTTP's permitted punctuation. It rejects spaces, control bytes, and high bytes in a field name. This is narrower and easier to inspect than a growing list of forbidden characters. It still validates only the name; field values need their own rules.

## The router defines the resource identity

After parsing, the router matches both method and path. A public `GET` handler and a protected `DELETE` handler cannot share a decision keyed only on the URL.

The path policy is deliberately simple: remove the query string before matching, compare literal segments case-sensitively, and reject doubled or trailing slashes. Consequently, `/packages/demo?page=2` captures `demo`, while `/packages/demo/` does not silently acquire a second spelling for the same route.

None of these spelling policies is inherently secure on its own. The requirement is that routing, permission checks, caches, and any proxy agree on resource identity. Normalizing a path can be safe if the normalization happens once and every subsequent decision uses the result.

Percent escapes need particular care. If `%2F` is decoded into `/` before segmentation, one segment becomes two. A design that splits first must still decide whether a decoded separator is legal inside a segment, and prevent downstream code from decoding it again. This version leaves captures encoded; later identifier validation rejects percent signs for package names.

There is a deliberate compatibility limitation too: the request-line parser accepts only targets beginning with `/`. A fully conforming HTTP/1.1 server must also accept absolute-form targets. Accepting `http://example/path` does not itself make a server a proxy; forwarding to that authority would. The distinction is explicit in [RFC 9112, section 3.2.2](https://www.rfc-editor.org/rfc/rfc9112.html#section-3.2.2).

Internally, matching and capture extraction share the same segment walker. A candidate route first answers whether it matches; only the winning route produces parameters. That avoids exposing partially filled captures from a route that failed on its last segment. The route table also has a fixed maximum capture count, checked at startup rather than during a request.

## Request types define what clients may write

Creating a package accepts a name and description. It does not accept a timestamp, owner, or yank flag:

```zig
const CreatePackage = struct {
    name: []const u8,
    description: []const u8,
};
```

In Zig, `[]const u8` is a read-only byte slice: a pointer and a length. The JSON parser fills these fields using strict options:

```zig
const parsed = try std.json.parseFromSlice(CreatePackage, allocator, body, .{
    .duplicate_field_behavior = .@"error",
    .ignore_unknown_fields = false,
});
defer parsed.deinit();
```

A request containing `created_at` is rejected because that field is not in the input contract. The server computes the timestamp. Yanking is a separate operation with its own permission question.

This prevents mass assignment, where deserializing into a general persistence object accidentally exposes fields the client should not control. Rejecting unknown fields also catches misspellings, though it means adding fields requires a deliberate compatibility policy. Duplicate keys are rejected so different JSON consumers cannot choose different values.

Shape validation is not domain validation. A ten-kilobyte package name is still a string. The body limit bounds input bytes; the package-name rule will separately bound and interpret that string. Typed parsing also does not justify assuming every malformed or nested document is cheap to process.

## Database guarantees have precise limits

A version is identified by its package name and version string:

```sql
CREATE TABLE versions (
  name     TEXT NOT NULL REFERENCES packages(name),
  semver   TEXT NOT NULL,
  checksum TEXT NOT NULL,
  yanked   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (name, semver)
);
```

The composite primary key prevents duplicate rows. It does not make a release immutable. An `UPDATE` can still replace the checksum, and replacement-style insertion can defeat an insert-only convention. Immutability requires restricting every write path, or adding enforcement such as a suitable database trigger. The initial publish operation inserts a new row and maps duplicate insertion to a conflict.

Foreign-key enforcement is enabled explicitly for the connection. A useful test attempts to insert a version for a nonexistent package and expects failure. Merely seeing `REFERENCES` in the schema does not establish that enforcement is active.

Query outcomes also need separation. A successful query with no row means the resource is missing. A query that failed because the database was unavailable says nothing about whether the row exists. The wrapper preserves that distinction and maps known extended constraint codes to application errors. Unfamiliar failures remain server errors; raw database messages stay out of responses.

## A failed response is not an opportunity to send another one

The response helper computes `Content-Length` from the body bytes rather than accepting an independent number. Handlers return errors to a shared mapper, reducing the chance that one writes an error and then falls through into a success response.

There is still an important limit to this design. If a success response has already started and its write fails, an error mapper must not append a fresh HTTP response. Some bytes are already on the wire. The connection should be closed. Centralizing error handling reduces duplicated decisions; tracking whether the response has been committed is a separate requirement.

This version handles one request per connection, then closes. Unread bytes are discarded rather than interpreted as another request. That simplifies recovery, but it is not a general proof against desynchronization through intermediaries. Adding keep-alive requires revisiting every early return: either consume the request body completely or close the connection.

## The remaining work

The baseline still interpolates values into SQL and JSON. A description containing quotes can therefore change the structure of a database command or response. It also accepts writes anonymously. A correctly parsed yank request is still unauthorized in the ordinary sense because no identity or ownership check exists yet.

HTTP support remains incomplete: transfer coding has no policy, protocol-version and `Host` validation need work, line endings are permissive, and there is no receive deadline. In particular, silently ignoring `Transfer-Encoding` is unsafe. A constrained parser must reject unsupported framing and close; a complete server must implement the protocol's framing rules.

Those are concrete limits on what this stage establishes. The [next article](/series/api-security/bounding-a-request) adds request budgets, prepared statements, and structured JSON output, then examines the concurrency problems those changes introduce.
