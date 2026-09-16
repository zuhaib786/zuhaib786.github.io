---
title: "Memory Ownership and TLS in a Zig HTTP Server"
description: "Keeping parsed bytes valid, retaining runtime safety checks, and adapting OpenSSL to Zig's I/O interfaces without confusing transport closure with message completion."
date: 2026-09-15
order: 5
tags: ["Security", "Memory Safety", "TLS", "Zig", "OpenSSL"]
draft: false
---

A parser can validate a request correctly and still hand the router the wrong path. That happened in Barbican, the package-registry API in this series: the parsed target was a slice into the receive buffer, and a later body read reused that buffer. The slice remained in bounds while its contents changed underneath it.

This is a useful place to begin transport security because it separates two guarantees that an API needs. TLS protects bytes while they travel between endpoints. Memory ownership determines whether the application continues to use those same bytes after receiving them. Neither guarantee supplies the other.

The [previous article](/series/api-security/bounding-a-request) added request limits and parameterized database access. This stage uses Zig 0.16's reader and writer interfaces, retains runtime safety checks in release builds, and adds OpenSSL on the connection side of those interfaces.

## A slice does not own its contents

In Zig, a slice is a pointer and length. Returning a slice from a parser does not copy the bytes it names:

```zig
const raw = try reader.takeDelimiterInclusive('\n');
const target = raw[start..end];
// A later refill may overwrite the storage behind target.
```

The lifetime of the array is not the only issue. Even if the array remains on the stack for the whole request, a refill can replace its contents. If routing happens after body reading, the path used for dispatch may no longer be the path that was validated.

Increasing the buffer or relying on a particular read size is fragile. The parser instead copies the request line into bounded storage and records offsets:

```zig
const RequestLine = struct {
    storage: [4096]u8,
    target_start: u16,
    target_len: u16,

    fn target(self: *const RequestLine) []const u8 {
        return self.storage[self.target_start..][0..self.target_len];
    }
};
```

This is the relevant shape, with the method and version omitted. Parsing checks the line length before copying and ensures both offsets describe a valid range. The accessor creates a slice from the current object's storage only when it is needed.

Offsets matter because a struct containing a slice into its own array is self-referential. Returning or copying it can leave the slice pointing into the old instance. Offsets survive the copy; previously obtained slices still do not. Code must not retain a borrowed slice after moving or destroying its owner.

The same rule applies to an `Authorization` header needed later in the request. Consume it before the reader can invalidate it, or copy it into storage whose lifetime is explicit. An in-bounds pointer to overwritten bytes is enough to corrupt a security decision; no out-of-bounds access is necessary.

## What ReleaseSafe buys

Zig's `ReleaseSafe` mode combines optimization with runtime safety checks. Checked integer overflow, out-of-bounds indexing, and other detected illegal operations terminate rather than silently continuing. `ReleaseFast` omits many of those checks. The build-mode distinction is documented in the [Zig language reference](https://ziglang.org/documentation/0.16.0/#Build-Mode).

For a network parser, those checks are valuable. An overflow in length arithmetic should be rejected through checked parsing or arithmetic where possible. A remaining invalid operation should not be allowed to proceed as unchecked memory access.

But `ReleaseSafe` is not a memory-safety proof. It does not automatically detect all use-after-free errors, data races, C-library bugs, or misuse of a valid slice. The overwritten request target above can pass bounds checks because the address and length remain valid. A panic may also take down the process, so catching the mistake still leaves an availability problem.

The project selects `ReleaseSafe` as its preferred release mode. That preference is not evidence of how every binary was built: deployment has to use and verify the intended mode, and local safety overrides remain relevant.

A request arena simplifies allocation lifetimes by freeing request-owned memory together. It does not enforce a quota, allow pointers to escape safely, or erase secrets when released. Allocation-failure tests remain useful because partial construction can leak non-arena resources such as prepared statements and TLS objects.

## Put TLS below the HTTP parser

The parser accepts a reader and the response layer accepts a writer. They do not need to know whether the underlying transport is a raw socket, a test buffer, or TLS:

```text
HTTP parser and response encoder
               │
       Zig Reader / Writer
               │
         OpenSSL adapter
               │
            TCP socket
```

For a connection that has completed its handshake, the integration looks like this:

```zig
var reader = tls_conn.reader(&recv_buffer);
var writer = tls_conn.writer(&send_buffer);
```

The adapter is responsible for translating TLS reads, writes, closure, and errors into the I/O interfaces. HTTP remains responsible for message framing. Tests can still give the parser in-memory input without performing a handshake.

TLS protects confidentiality and integrity between the client and the TLS endpoint. Server authentication also depends on the client verifying the certificate chain and hostname. Merely negotiating encryption with some certificate does not establish that the client reached the registry it intended to contact.

For local tests, the client trusts a generated development CA explicitly. Disabling certificate verification would make a connection succeed against the wrong certificate and invalidate that part of the test. If TLS later terminates at a reverse proxy, the proxy-to-application path becomes a separate trust boundary.

## Fail configuration errors before accepting traffic

The server uses OpenSSL 3 and explicitly sets a minimum TLS version of 1.2. It loads a certificate chain and private key, then checks that they correspond:

```zig
if (c.SSL_CTX_set_min_proto_version(ctx, c.TLS1_2_VERSION) != 1)
    return error.TlsInitFailed;
if (c.SSL_CTX_check_private_key(ctx) != 1)
    return error.KeyMismatch;
```

Certificate and key loading occur between these operations. Each return value is checked. A successful file load is not sufficient evidence that the overall configuration can complete a handshake; the point is to detect incompatible configuration at startup.

The receive deadline starts before the handshake. Otherwise, a client can reserve a connection by opening TCP and withholding its TLS handshake bytes. Encryption does not make unauthenticated work free: handshake computation, certificate parsing, buffers, and task slots all belong in the resource model.

This version loads credentials once at startup, so certificate rotation requires restarting the process. A reload mechanism would need to validate a replacement context before using it for new connections and keep old contexts alive while existing connections still reference them.

## TLS closure and HTTP completion are different facts

A TCP close does not authenticate why the stream ended. TLS has a `close_notify` alert to indicate an orderly end to the peer's sending direction. OpenSSL distinguishes that from an unexpected transport EOF.

An adapter must pass the actual result of the failed I/O operation to `SSL_get_error`, on the same thread and before unrelated OpenSSL calls. Its error queue must be in the expected state. Conceptually:

```zig
const rc = c.SSL_read_ex(ssl, dest.ptr, dest.len, &n);
if (rc != 1) {
    const reason = c.SSL_get_error(ssl, rc);
    // Classify reason before consuming diagnostic errors.
}
```

`SSL_ERROR_ZERO_RETURN` normally indicates `close_notify`. With OpenSSL 3, unexpected EOF is generally reported through `SSL_ERROR_SSL` with a specific reason in the error queue; older releases reported it differently. `WANT_READ` and `WANT_WRITE` describe retry conditions, not successful completion or an arbitrary syscall failure. These details are specified by [OpenSSL's SSL_get_error documentation](https://docs.openssl.org/3.5/man3/SSL_get_error/).

The current adapter refuses abnormal read termination, but its coarse error categories do not preserve every OpenSSL reason. That limits diagnosis: a label such as “protocol error” does not establish that a malicious peer truncated the stream. Ordinary network failures and client behavior can also produce abnormal closure.

HTTP still has to decide whether its message is complete. If a request declares 100 body bytes and only 60 arrive, even a clean TLS shutdown does not make the request valid. Conversely, receiving the complete framed message establishes a fact that is separate from whether the peer later shuts down TLS cleanly. Closure must not be used as a substitute for counting the required body bytes.

This matters especially for future artifact transfers. Completion should be determined by explicit framing and verified content, not by the assumption that any end-of-stream means the intended file arrived.

## Why the API does not redirect plaintext credentials

Suppose an API client sends:

```http
POST /packages HTTP/1.1
Host: registry.example
Authorization: Basic <encoded-credentials>
```

If that request used plaintext HTTP, the credential has already crossed the network before the server can issue a redirect. An HTTPS redirect improves the next request; it cannot undo the first disclosure.

Barbican therefore exposes only its TLS listener. Clients must use an HTTPS URL and verify the server. Removing the application's plaintext listener prevents it from processing plaintext requests, though a misconfigured client can still send secrets to the wrong destination or through an attacker-controlled endpoint.

The server also sends HSTS on HTTPS responses. Browsers that learn the policy upgrade future HTTP attempts; preloading can cover the first visit for participating browsers. HSTS behavior does not extend automatically to every CLI or API client. The client configuration remains part of the transport contract.

## Timeouts expose the limits of the adapter

The current deadline worker interrupts a stalled read by shutting down receiving on the socket. That causes the connection to close without a guaranteed HTTP `408` response. Once the TLS operation has failed, trying to append an error response is not a reliable recovery strategy.

A design with nonblocking I/O can coordinate socket readiness, TLS retry states, and deadlines without using receive shutdown as the cancellation mechanism. That is more work than attaching a timer to a blocking read, but it provides clearer control over handshake, read, and write progress.

At this point the server owns the bytes it needs after parsing, retains runtime checks, and carries requests over TLS. It still has incomplete HTTP support and limited timeout behavior. The next step is [password authentication](/series/api-security/who-are-you), where memory cost, credential lifetime, and failure behavior become part of every request.
