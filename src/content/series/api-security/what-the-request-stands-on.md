---
title: "Route Confusion, Truncation, and Plaintext Credentials"
description: "Phases 2 and 3 of barbican: the attacks reachable underneath the API — a body that rewrites the request target, a parser bug turned into an exploit by a build flag, a message truncated by an attacker, and a credential spent before the response arrives."
date: 2026-09-15
order: 5
tags: ["Security", "Memory Safety", "TLS", "Zig", "OpenSSL"]
draft: false
---

The controls in [Phase 1](/series/api-security/bounding-a-request) act on a request's cost and its contents. They assume the request the router sees is the request the client sent, and that nobody else read it on the way. These attacks break those assumptions without touching a handler.

## Attack: a large body rewrites the request target

Parsing a request line returns slices into the connection's receive buffer:

```zig
target: []const u8,   // points into recv_buffer
```

Bodies are read in 16 KiB chunks. A body needing a second chunk refills that buffer, and the target's bytes are replaced by body bytes at the same offset.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/route-confusion.svg" alt="The receive buffer with a span marked as the request target. After a body larger than sixteen kibibytes is read, the buffer is full of body bytes and the same span now holds attacker data, which the router reads.">
  <img class="plate-dark" src="/images/api-security/route-confusion-dark.svg" alt="The receive buffer with a span marked as the request target. After a body larger than sixteen kibibytes is read, the buffer is full of body bytes and the same span now holds attacker data, which the router reads.">
</figure>

The router dispatches on whatever the client placed at that offset:

```
body 16347  ->  400 Bad Request     one chunk
body 16447  ->  404 Not Found       two chunks, target lost
```

A crafted body turns that 404 into a 400 — the target had become a *different valid path* that matched a route and failed name validation. The client chooses the route.

With anonymous routes the damage is limited to reaching the wrong handler. With authentication it is an authorization bypass: the path an access check reads and the path the handler acts on are different strings, and the attacker picks the second. The check is not wrong; it is checking a value that no longer exists.

## Fix: the parser owns every byte it returns

Copying the target at the call site works and puts the invariant in the caller. Copying the whole line into storage the parser owns removes the invariant instead.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/owned-request-line.svg" alt="The request line is copied out of the receive buffer into storage owned by the parser. The receive buffer is later refilled with body bytes, the owned copy is untouched, and the router reads the owned copy.">
  <img class="plate-dark" src="/images/api-security/owned-request-line-dark.svg" alt="The request line is copied out of the receive buffer into storage owned by the parser. The receive buffer is later refilled with body bytes, the owned copy is untouched, and the router reads the owned copy.">
</figure>

```zig
pub const RequestLine = struct {
    method: Method,
    storage: [MAX_REQUEST_LINE]u8,
    target_off: u16,
    target_len: u16,
    version_off: u16,
    version_len: u16,

    pub fn target(self: *const RequestLine) []const u8 {
        return self.storage[self.target_off..][0..self.target_len];
    }
};
```

Copying the line rather than the target means no per-field decision about which fields are safe to keep. `version` had the identical defect, latent only because nothing read it after the body.

**The spans are offsets, not slices.** A struct holding slices into its own array is self-referential, and Zig moves structs by copying:

```zig
var b = a;                 // plain copy
@memset(&a.storage, 'X');  // clobber the original

b.slice    // garbage — still aimed at a.storage
b.storage  // intact
```

Offsets are meaningless until combined with the storage they are read from, so they survive a move. Returning a struct of slices-into-self hands the caller dangling pointers into a dead stack frame.

`MAX_TARGET` becomes an explicit 2048 returning `414`, rather than 4096 inherited from whatever size the read buffer happens to be.

## Attack: a build flag turns a parser bug into an exploit

`ReleaseFast` removes bounds checking, integer-overflow detection, and the `unreachable` check. In a process parsing attacker-controlled bytes, an out-of-bounds index stops being a panic and becomes an out-of-bounds write.

## Fix: ReleaseSafe for anything on a socket

```zig
const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .ReleaseSafe });
```

The safety checks are the control. They convert memory-corruption bugs — the class that produces remote code execution — into crashes, which are a denial of service and nothing worse. `ReleaseFast` stays reachable and stays a decision that has to be argued for.

The same phase adds an arena per request, so every allocation a handler makes has one lifetime and is released in one move, and allocation-failure paths are exercised with `FailingAllocator` under a leak-checking allocator. An attacker chooses the input sizes, which makes `OutOfMemory` a reachable path rather than a theoretical one.

## Attack: everything on the wire is readable and rewritable

Without transport security, a network attacker reads every credential sent in Phase 4 onward, and rewrites any checksum in a package response — which is a supply-chain compromise, not an integrity nit. There is also no way for a client to verify it is talking to the real registry.

## Fix: terminate TLS before authentication exists

Doing this before the first credential is written means no code path ever sends one in the clear, not even temporarily.

`std.crypto.tls` ships a client and no server, so the server side is OpenSSL through `@cImport`. The integration is two lines, because the parser takes a `std.Io.Reader` and a `std.Io.Writer` rather than a socket:

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/tls-seam.svg" alt="Handlers, router and parser stacked above a horizontal line marked std.Io.Reader and std.Io.Writer. Below the line, either a socket adapter or a TLS adapter feeds the same interfaces.">
  <img class="plate-dark" src="/images/api-security/tls-seam-dark.svg" alt="Handlers, router and parser stacked above a horizontal line marked std.Io.Reader and std.Io.Writer. Below the line, either a socket adapter or a TLS adapter feeds the same interfaces.">
</figure>

```zig
var reader = tls_conn.reader(&recv_buffer);
var writer = tls_conn.writer(&send_buffer);
```

Writing the adapter is two functions: `stream` on the Reader, `drain` on the Writer. Everything else in both interfaces is built on those.

Four calls set up the context, and the fourth is the one usually omitted:

```zig
if (c.SSL_CTX_set_min_proto_version(ctx, c.TLS1_2_VERSION) != 1) return error.TlsInitFailed;
if (c.SSL_CTX_use_certificate_chain_file(ctx, cert.ptr) != 1) return error.CertLoadFailed;
if (c.SSL_CTX_use_PrivateKey_file(ctx, key.ptr, c.SSL_FILETYPE_PEM) != 1) return error.KeyLoadFailed;
if (c.SSL_CTX_check_private_key(ctx) != 1) return error.KeyMismatch;
```

Loading a key that does not match the certificate **succeeds** in the two calls above the last one. Without `check_private_key`, the mismatch surfaces as a handshake failure on every connection and is diagnosed as a client problem. The minimum protocol version is set explicitly because the default depends on how the library was built.

## Attack: an abrupt close is accepted as a complete message

`SSL_read` returning a non-success value is not end of stream. An active attacker who injects a TCP FIN cuts a response short at a point of their choosing, and a server that treats an abrupt close as a clean end accepts the truncated version as complete.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/close-notify.svg" alt="Two exchanges. In one the client ends with close_notify and the message is complete. In the other only a TCP FIN arrives and the message is truncated. Both look identical at the socket.">
  <img class="plate-dark" src="/images/api-security/close-notify-dark.svg" alt="Two exchanges. In one the client ends with close_notify and the message is complete. In the other only a TCP FIN arrives and the message is truncated. Both look identical at the socket.">
</figure>

## Fix: only close_notify ends a stream

```zig
switch (c.SSL_get_error(self.ssl, 0)) {
    c.SSL_ERROR_ZERO_RETURN => return error.EndOfStream,   // close_notify
    c.SSL_ERROR_SYSCALL => { self.err = error.Truncated; return error.ReadFailed; },
    c.SSL_ERROR_SSL     => { self.err = error.Protocol;  return error.ReadFailed; },
    else                => { self.err = error.Syscall;   return error.ReadFailed; },
}
```

Exactly one case is a clean end. `close_notify` exists so that completion is distinguishable from interruption; collapsing the first two cases into "EOF" discards the only signal that separates them.

The `err` field carries the specific cause out of band. The vtable's error set is fixed — `stream` may return only `ReadFailed` or `EndOfStream` — so without it a truncation attack, a client hanging up, a version mismatch and a broken socket produce one indistinguishable log line, and none can be acted on differently.

## Attack: a credential sent to a plaintext port is already spent

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/plaintext-credential.svg" alt="A client sends a POST carrying an Authorization header in the clear; the server answers with a 301 redirect to HTTPS, which arrives after the credential has already crossed the network.">
  <img class="plate-dark" src="/images/api-security/plaintext-credential-dark.svg" alt="A client sends a POST carrying an Authorization header in the clear; the server answers with a 301 redirect to HTTPS, which arrives after the credential has already crossed the network.">
</figure>

A browser is redirected to HTTPS because a human typed a bare hostname. An API client has already sent its request, credential included, before any response can be written. A `301` tells it to retry securely and says nothing about the secret it just burned.

## Fix: refuse, then stop listening

The plaintext listener refused with `426`, routed nothing, and held no reference to the database, so no plaintext request could reach storage regardless of later edits.

It was then removed. A refusing socket still accepts unauthenticated connections, still runs code before any handshake, and is still something a later change can be tempted to make useful. Nothing binds the plaintext port; the kernel refuses the connection.

HSTS goes on every response, and its limit is worth being exact about: it instructs a browser never to use plaintext for this origin again, which cannot protect the *first* visit, because the instruction has to arrive somehow. Preloading closes that gap and is a decision about a public domain rather than about this code.

## Attacks still open

- A reaped connection receives no response. Unblocking a stalled read requires tearing down the socket, which destroys the SSL session, so a `408` written afterwards reaches the client as a TLS alert. Correct delivery needs non-blocking I/O.
- `Truncated` is detected and recorded but drives no policy. A peer producing it repeatedly is a signal nothing acts on.
- Certificate and key are loaded once at startup, so rotation is a restart.

Next: authentication, and the property inherited here — no code path can receive a credential in the clear.
