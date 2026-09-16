---
title: "Offline Cracking, User Enumeration, and a Timing Oracle"
description: "Phase 4 of barbican: attacks on the credential itself — a stolen password table cracked on a GPU farm, an error message that confirms which usernames exist, and the absence of hashing time saying the same thing out loud."
date: 2026-09-16
order: 6
tags: ["Security", "Authentication", "Argon2", "Zig", "Timing Attacks"]
draft: false
---

Every write in [Phase 3](/series/api-security/what-the-request-stands-on) is anonymous: a stranger can publish a package and yank someone else's version. Closing that means storing a credential, checking it, and refusing without saying anything useful — three separate attack surfaces.

## Attack: a stolen password table is cracked offline

A database breach hands an attacker every hash at once, with unlimited time and no rate limit. Against SHA-256 a modern GPU tries billions of candidates per second; salting changes the order of the work, not its cost. The whole defence is making each guess expensive.

## Fix: Argon2id, chosen by measurement

```zig
const ARGON2_PARAMS = std.crypto.pwhash.argon2.Params.interactive_2id;
```

Three presets, measured in the mode that ships. A build with safety checks disabled is roughly ten times faster, so timing this in a debug build would understate the cost by an order of magnitude and pick something far too weak.

| preset | memory | passes | verify |
|---|---|---|---|
| `owasp_2id` | 19 MiB | 2 | 17 ms |
| `interactive_2id` | 64 MiB | 2 | **68 ms** |
| `moderate_2id` | 256 MiB | 3 | 421 ms |

**Memory is the parameter that matters, not iterations.** Iterations slow the defender and the attacker by the same factor. Memory does not: a GPU has thousands of cores and nowhere near 64 MiB of fast memory for each of them, so a memory-hard function collapses the parallelism advantage that makes offline cracking cheap.

It is not set higher because 64 MiB is allocated per hash *by an unauthenticated caller*. At a 128-connection limit that is 8 GiB available on demand. Password hashing is a deliberate self-inflicted denial of service, and rate limiting is what buys the headroom to raise the cost later.

What gets stored is the full PHC string, not a digest:

```
$argon2id$v=19$m=65536,t=2,p=1$3GIW2iW13rqRuMnj0nzZAorBQ99TYBhLXD2D8O7D2H0$oBodLvr2D8srVARQj2bOdh1cd8WkLUK4HSdbueyli6o
```

The salt is in there, so two users who pick the same password store different rows and no precomputed table applies to either. The cost parameters are in there too, so raising them later leaves existing rows verifiable against their own parameters — the alternative is a migration that has to be got exactly right while people are logging in.

## Attack: a password rule shrinks the search space

"One uppercase, one digit, one symbol" is a rule an attacker reads as a hint. `Password1!` satisfies every one of them, and so do the few thousand variants that users actually produce when forced. The rule eliminates candidates the attacker was never going to try and concentrates the rest.

## Fix: length, and nothing else

```zig
pub fn password(s: []const u8) Error!void {
    if (s.len < MIN_PASSWORD) return error.PasswordTooShort;  // 12
    if (s.len > MAX_PASSWORD) return error.PasswordTooLong;   // 128
}
```

Length is the only property that reliably costs an offline attacker anything. The maximum is a resource bound rather than a security claim — Argon2 does not truncate, so a long passphrase is genuinely stronger and the cap should be generous; it exists because every byte is fed to a deliberately expensive function by an anonymous caller.

## Attack: the error message says which usernames exist

`401 unknown user` and `401 wrong password` are two different answers, and the first one is worth far more. Finding a valid username costs an attacker nothing and turns a two-dimensional guess into a one-dimensional one.

## Fix: one response, byte for byte

A malformed header, an unknown user, a syntactically impossible username and a wrong password all produce the same status, the same challenge and the same body:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Basic realm="barbican"

{"error":"authentication required"}
```

The challenge header is not decoration. Without it, `401` says the request failed and not what would make it succeed, and a client cannot tell "you are not authenticated" from "you are authenticated and refused".

## Attack: the absence of hashing time says it anyway

Identical bodies are not enough. A server that looks up the user, finds nothing, and returns immediately is measurably faster than one that found a row and verified against it. The gap is one hash — here, 68 milliseconds, which is enormous over a network.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/timing-oracle.svg" alt="Four latency bars. Without a dummy hash, 'no such user' returns early and 'wrong password' runs long, and the gap between them is marked as the answer. With a dummy hash, both run to the same length.">
  <img class="plate-dark" src="/images/api-security/timing-oracle-dark.svg" alt="Four latency bars. Without a dummy hash, 'no such user' returns early and 'wrong password' runs long, and the gap between them is marked as the answer. With a dummy hash, both run to the same length.">
</figure>

## Fix: hash a password nobody has

When the username does not resolve to a row, verify the supplied password against a fixed hash instead of returning:

```zig
const username = validate.Username.parse(basic.username) catch {
    burn(ctx, basic.password);
    return .invalid;
};

const phc = stored orelse {
    burn(ctx, basic.password);
    return .invalid;
};
```

The dummy must be generated with the **same parameters** the server hashes with. One at a different cost takes a different amount of time and reopens the oracle it exists to close. Measured across twelve requests each:

```
existing user, wrong password    149.4 ms
no such user                     147.1 ms
invalid username syntax          148.6 ms
existing user, wrong password    148.2 ms   <- repeat of the first
```

The spread between the three cases is smaller than the spread between two runs of the same input.

One path deliberately does *not* hash: a header that fails to base64-decode is rejected immediately. It leaks nothing, because the caller wrote the header and already knows it is malformed, and the answer depends on no stored secret. Hashing it anyway would sell a 64 MiB, 68 ms operation for the price of sending `Authorization: Basic x`.

## Attack: a new route defaults to anonymous

Access declared as an opt-in flag fails open. A route added without it is unauthenticated, it compiles, it works, and nothing in review draws the eye to a line that is not there.

## Fix: make the absence of a decision unrepresentable

```zig
pub const Access = union(enum) { public, authenticated };

pub const Route = struct {
    method: Method,
    path: []const u8,
    access: Access,        // no default
    handler: Handler,
};
```

No default value, so registering a route without deciding is `error: missing struct field: access`. Opt-out would not have fixed it — it moves which mistake is silent. The question is never opt-in versus opt-out, it is whether a missing decision can exist at all.

Declaring access on the route also beats matching a path prefix. Prefix rules are where bypasses live: `/admin` guarded while `/admin/` or `/Admin` is not. On the route, the routing decision and the access decision are the same lookup and cannot disagree.

## Attack: checking after a lookup is an existence oracle

A handler that fetches the resource, returns `404` when it is missing, and *then* checks the credential answers two different statuses to an anonymous caller — `404` for a version that does not exist, `401` for one that does. That enumerates private resources without ever authenticating.

## Fix: resolve identity before routing, enforce before any lookup

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/identity-before-route.svg" alt="A left-to-right chain: headers with the credential copied, resolve producing one hash or none, match route on method and path, then an access gate marked public or authenticated. An arrow underneath spans the whole chain, noting the caller is known on every route including a 404.">
  <img class="plate-dark" src="/images/api-security/identity-before-route-dark.svg" alt="A left-to-right chain: headers with the credential copied, resolve producing one hash or none, match route on method and path, then an access gate marked public or authenticated. An arrow underneath spans the whole chain, noting the caller is known on every route including a 404.">
</figure>

Resolution runs once, as soon as the headers are complete, before the route is known. Identity becomes a property of the request rather than of which route matched — so a public route still knows who is calling, which is what audit logging and per-principal rate limiting need, and what any route that varies its response by caller needs.

Resolution never fails. It returns a caller, and refusal belongs to the route's access rule:

```zig
pub const Caller = union(enum) {
    anonymous,   // no credential presented
    invalid,     // presented and rejected
    user: Username,
};
```

Three states, not two. Collapsing `invalid` into `anonymous` loses the difference between a client that never meant to authenticate and one whose credential is broken, and a public route that silently serves the anonymous view to the second is how a caller who believes they are authenticated is quietly not. Both return the same error to `require`, so the distinction never reaches the client.

## Attack: the credential is overwritten before it is checked

A parsed header value is a slice into the connection's receive buffer. The body is read into that same buffer. A body larger than one read chunk therefore rewrites the bytes the header points at — so the credential *verified* and the credential *sent* are different strings, chosen by whoever wrote the body.

## Fix: whatever holds a credential owns its bytes

Copied at parse time, into storage the credential itself owns. The same defect one level down produced request-target confusion in an earlier phase; here it is an authentication bypass, which is why the fix cannot be a copy the caller has to remember to make.

Two `Authorization` headers are refused rather than merged. If this server reads one and a proxy ahead of it reads the other, they disagree about who is making the request — the same class as a duplicate `Content-Length`, where they disagree about where the request ends.

## Attacks still open

- **Identity is not permission.** Any authenticated user can yank any package. The anonymous half of that finding is closed; the rest is an ownership model.
- **A password crosses the wire on every request.** Basic sends the credential itself, base64-encoded, which is encoding and not encryption. It is survivable only because nothing is reachable without TLS, and it is why the next step is a token that can be scoped and revoked.
- **Hashing is unauthenticated work.** Any caller who presents a well-formed credential buys 64 MiB and 68 ms. Rate limiting is the control, and it does not exist yet.
- **A duplicate registration still discloses that a username is taken.** Accepted deliberately: a registry publishes usernames on every package page, so the read API already gives this away. The same status code on a bank is a customer list — the verdict belongs to the system, not to the status code.
