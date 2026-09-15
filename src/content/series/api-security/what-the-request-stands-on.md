---
title: "What the Request Stands On"
description: "Phases 2 and 3 of barbican: the memory a request borrows and the transport it arrives on. A lifetime bug that lets a client choose its own route, and three mitigations that were worse than the gaps they closed."
date: 2026-09-15
order: 5
tags: ["Security", "Memory Safety", "TLS", "Zig", "OpenSSL"]
draft: false
---

The controls so far act on a request's contents. [Phase 1](/series/api-security/bounding-a-request) caps what a request may consume and stops its values becoming syntax. Both assume the request itself is what the client sent.

Two things underneath that assumption can break it: the memory the request borrows, and the transport it arrives over. Neither appears in a handler, and a defect in either invalidates every control above it.

## A slice is a promise about a lifetime

Parsing a request line produced slices into the connection's receive buffer:

```zig
pub const RequestLine = struct {
    method: Method,
    target: []const u8,   // points into recv_buffer
    version: []const u8,
};
```

Cheap, and correct while nothing else touches that buffer. Reading a body touches that buffer.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/borrowed-target.svg" alt="Two versions of the same three steps. When the target borrows the receive buffer, reading a body larger than one chunk refills that buffer and dispatch reads whatever the body placed there. When the parser copies the line into its own storage, the buffer is refilled but the target still reads as sent.">
  <img class="plate-dark" src="/images/api-security/borrowed-target-dark.svg" alt="Two versions of the same three steps. When the target borrows the receive buffer, reading a body larger than one chunk refills that buffer and dispatch reads whatever the body placed there. When the parser copies the line into its own storage, the buffer is refilled but the target still reads as sent.">
  <figcaption>The bug is not in the parser or the router. It is in the gap between them.</figcaption>
</figure>

The failure has a precise threshold. Bodies are read in 16 KiB chunks, and a body needing a second chunk refills the buffer the target points into:

```
body 16347  ->  400 Bad Request     (one chunk)
body 16447  ->  404 Not Found       (two chunks -- route lost)
```

A 404 understates it. The target is not merely invalid; it is **whatever the client put in the body at that offset**. Sending a crafted payload turned the 404 into a 400 — the target had become a different path, one that matched a route and then failed name validation.

Today this is close to harmless, because every route is anonymous. From the next phase it is an authorization bypass: the path an authorization check reads and the path the handler acts on would be different strings, with the client choosing the second. That is a time-of-check-to-time-of-use bug where the "value" being checked is the request itself.

### The fix belongs in the parser

The narrow repair is to copy the target before reading the body. It works, and it is the wrong shape: it puts the invariant in the caller, where every future caller has to know about it.

Copying the whole line into storage the parser owns removes the question instead:

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

Every field is owned, so there is no per-field judgement about which ones are safe to keep — `version` was a latent instance of the identical bug waiting for someone to use it.

**The spans are offsets rather than slices, and that is not stylistic.** A struct holding slices into its own array is self-referential, and Zig moves structs by copying:

```zig
var a = S.make();          // s.slice points into s.storage
var b = a;                 // plain copy
@memset(&a.storage, 'X');  // clobber the ORIGINAL

b.slice    // garbage -- still aimed at a.storage
b.storage  // "hello" -- the copy itself is fine
```

Offsets mean nothing until combined with the storage they are read from, so they survive a move. This is a Zig-shaped hazard with no equivalent in the managed-runtime material most API security writing assumes.

While the bound was being written down, it also became a real one: `MAX_TARGET` is 2048 and returns `414`, rather than 4096 inherited by accident from the read buffer's size.

## The transport is a layer, not a feature

Terminating TLS before authentication is deliberate: it means no line of code ever sends a credential in the clear, not even temporarily during development.

Zig's standard library ships `std.crypto.tls.Client` and no server, so the server side is OpenSSL through `@cImport` — the third C boundary in this project, after SQLite and POSIX regex.

The integration was two lines:

```zig
var reader = tls_conn.reader(&recv_buffer);
var writer = tls_conn.writer(&send_buffer);
```

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/tls-underneath.svg" alt="A layer diagram. Handlers, router and parser are unchanged. The seam is the std.Io.Reader and std.Io.Writer interfaces, below which the net.Stream adapter is replaced by an SSL-backed adapter.">
  <img class="plate-dark" src="/images/api-security/tls-underneath-dark.svg" alt="A layer diagram. Handlers, router and parser are unchanged. The seam is the std.Io.Reader and std.Io.Writer interfaces, below which the net.Stream adapter is replaced by an SSL-backed adapter.">
  <figcaption>The parser takes a Reader and a Writer, not a socket. That is what made the transport replaceable.</figcaption>
</figure>

The interface split was introduced two phases earlier for an unrelated reason — routing every failure through one error-response point. Designing to an interface pays in places the interface was not designed for.

Writing the adapter means implementing two functions: `stream` on the Reader and `drain` on the Writer. Everything else in both interfaces is built on those.

### close_notify is not a formality

The security-relevant decision in the whole adapter is four lines:

```zig
switch (c.SSL_get_error(self.ssl, 0)) {
    c.SSL_ERROR_ZERO_RETURN => return error.EndOfStream,   // peer sent close_notify
    c.SSL_ERROR_SYSCALL => { self.err = error.Truncated; return error.ReadFailed; },
    c.SSL_ERROR_SSL     => { self.err = error.Protocol;  return error.ReadFailed; },
    else                => { self.err = error.Syscall;   return error.ReadFailed; },
}
```

`SSL_read` returning a non-success value is not end of stream. Exactly one of those cases is a clean end: the peer sent `close_notify`. An abrupt close is different, and an active attacker can produce one by injecting a TCP FIN. A server that treats the two alike accepts a response cut short at a point the attacker chose — a **truncation attack**, and the reason TLS has an explicit end-of-stream marker at all.

The `err` field beside the return is not decoration either. The vtable's error set is fixed and narrow — `stream` may return only `ReadFailed` or `EndOfStream` — so every specific cause collapses on the way out. Stashing it means a truncation attack, a client hanging up, a version mismatch and a broken socket produce four distinguishable log lines instead of one useless one.

### Refuse, do not redirect

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/refuse-not-redirect.svg" alt="Two sequences. Redirecting: the client sends its request with an Authorization header, the server replies 301, the client retries over TLS — but the token already crossed the network in the first step. Refusing: the same first step, then a 426 Upgrade Required.">
  <img class="plate-dark" src="/images/api-security/refuse-not-redirect-dark.svg" alt="Two sequences. Redirecting: the client sends its request with an Authorization header, the server replies 301, the client retries over TLS — but the token already crossed the network in the first step. Refusing: the same first step, then a 426 Upgrade Required.">
  <figcaption>A redirect is advice that arrives after the secret does.</figcaption>
</figure>

A browser is redirected to HTTPS because a human typed a bare hostname and the alternative is a broken page. An API client has **already sent its request**, credential included. By the time a `301 Location: https://…` can be written, the token has crossed the network in plaintext. The redirect tells the client to retry securely and says nothing about the secret it just burned.

So the plaintext listener refused with `426`, never routed anything, and never held a reference to the database — a plaintext request could not reach storage regardless of later edits.

Then it was removed entirely. A refusing socket is still a socket accepting unauthenticated connections, still code running before any handshake, and still something a future change can be tempted to make useful. Nothing binds the plaintext port now; the kernel refuses the connection.

HSTS is sent on every response, and it is worth being precise about what it does: it instructs a browser never to speak plaintext to this origin again. It cannot protect the *first* visit, because that instruction has to arrive somehow. Closing that gap requires preloading, which is a decision about a public domain rather than about this code.

## Three mitigations that were worse than the gaps

This is the pattern these two phases kept producing, and it is the transferable part.

**`SO_RCVTIMEO` panicked the process.** The textbook read deadline makes `read()` return `EAGAIN`. The I/O runtime assumes blocking sockets, treats `EAGAIN` as impossible, and panics. A slow-client hang became a remote crash — strictly worse, and it compiled, and it is the standard answer.

**One SQLite handle across tasks was memory corruption.** Making the server concurrent introduced a defect in a file that did not change: the system library is built in multi-thread mode, where a single connection used by two threads at once is undefined behaviour. Reduced to eight threads, it segfaults. No signature changed, no test failed, and the type system has no opinion about how many threads reach a pointer.

**A `408` for a timed-out TLS connection arrives as a protocol error.** The deadline is enforced by a second task that tears down the socket's read side to unblock a stalled read. Underneath OpenSSL that destroys the session, so the status written next is not decodable and the client receives `TLSV1_ALERT_DECODE_ERROR` — worse than silence, because a timeout now looks like a broken server. The mapping is correct and undeliverable until the transport uses non-blocking I/O. That limitation is recorded in the code rather than papered over.

None of the three is visible in a diff. All three required running the mitigation against a live process, which makes *"has this control been executed?"* a different question from *"has this control been written?"*.

## Fault ownership applies to logs too

Status codes were made to follow fault in Phase 1: a malformed request is `4xx`, a broken socket is `5xx`, because an attacker-triggerable `5xx` fires the alert that is supposed to mean the server is broken.

The same argument applies one channel over. Clients that stalled or hung up mid-body were writing `error:` lines — the identical problem relocated from the response into the log, where it degrades the signal just as effectively. Those are warnings now. A client abandoning a request is not a server error.

## The tests keep being wrong in the same way

Two more smoke checks turned out to assert something other than what they claimed.

`Content-Length:  5` — extra whitespace after the colon — was in a list of headers that "must be refused". RFC 9112 permits that whitespace, so accepting it is correct. The check passed because `nc` closed the connection, the server hit end-of-stream and returned `400`. It was testing the harness.

The truncated-body check had the same dependency, and both broke the moment the transport changed. That makes six checks across this project found to pass for a reason unrelated to the property under test. The recurring shape is a test that observes a *symptom* reachable by more than one path.

And one failure was mine alone: the TLS 1.0 check reported "accepted" for half an hour because the suite runs with `set -o pipefail`, `grep -q` exits on its first match, `openssl` takes `SIGPIPE`, and the pipeline reports failure. The assertion was inverted by a shell option, not by anything about TLS.

## Where this leaves the boundary

```text
memory      request metadata is owned, not borrowed from a reusable buffer
            spans are offsets, so a struct survives being moved
            one arena per request; allocation failure and leaks covered in tests
build       ReleaseSafe preferred -- bounds checks are what keep a parser bug a panic
transport   TLS 1.2 minimum, verified against a local CA, HSTS on every response
            no plaintext port is bound at all
            close_notify distinguished from an abrupt close
```

Still open, stated rather than implied:

- a reaped connection gets no response, because the deadline destroys the transport it would answer over;
- `Truncated` is detected and recorded but drives no policy — a peer producing it repeatedly is a signal nothing acts on;
- the certificate and key are loaded once at startup, so rotation is a restart.

Next: authentication. Every phase so far has treated a request as anonymous and asked only what it may cost and what it may say. The next question is who sent it — and the useful property inherited here is that there is no longer any code path capable of receiving a credential in the clear.
