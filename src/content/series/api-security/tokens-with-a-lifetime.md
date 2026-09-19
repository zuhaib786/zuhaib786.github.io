---
title: "Bearer Tokens: Storage, Expiry, and Revocation"
description: "Phase 5 of Barbican: high-entropy credentials, digest-only storage, separate management handles, and expiry enforced in the authentication query."
date: 2026-09-19
order: 7
tags: ["Security", "Authentication", "Tokens", "Zig", "SQLite"]
draft: false
---

A CI job that authenticates with a password must keep that password available for every request. It can end up in client configuration, environment dumps, or shell history. Replacing a leaked password then means updating every client that shares it. The credential used to administer the account has become the credential distributed to routine automation.

Phase 5 of Barbican, the package-registry API in this series, introduces independently issued bearer tokens. A client exchanges password authentication for a random credential, uses that credential for API requests, and can revoke it without changing the account password. The server stores a digest, checks both absolute and idle expiry, and exposes a separate handle for management.

The token is opaque: it carries no claims for the client to decode, and the server needs a database lookup to accept it. This stage implements a credential lifecycle, not OAuth or package-level scopes. A label such as `release-ci` helps a person identify a token; it does not restrict what the token may do.

## Generate a secret with no predictable fallback

The credential contains 32 cryptographically random bytes, encoded as unpadded base64url. That produces 43 characters while preserving 256 bits of entropy. Encoding changes how the bytes travel; it adds no entropy of its own.

The relevant Zig code is small:

```zig
var raw: [32]u8 = undefined;
try std.Io.randomSecure(io, &raw);
defer std.crypto.secureZero(u8, &raw);

var encoded: [43]u8 = undefined;
_ = std.base64.url_safe_no_pad.Encoder.encode(&encoded, &raw);
```

The choice of random API is consequential. In the Zig I/O API used here, `random` permits weaker seeding if secure entropy fails. `randomSecure` obtains entropy from outside the process and returns an error rather than degrading to a weaker source. Token issuance must fail with a server error if that source fails. The contract is documented in [Zig's I/O API](https://github.com/ziglang/zig/blob/master/lib/std/Io.zig).

Clearing `raw` removes that temporary binary copy. It does not erase the encoded value, response buffers, or copies made by the client. The encoded token must remain available long enough to return it, over TLS, in the creation response.

Only the scheme name in `Authorization: Bearer …` is case-insensitive. The credential itself is an exact byte string. Lowercasing it, decoding and re-encoding it inconsistently, or hashing different representations at issuance and verification would change its identity.

## Store a fast hash of a high-entropy token

The database stores SHA-256 of the encoded token, represented as 64 lowercase hexadecimal characters. Authentication applies the same transformation to the received credential and looks up that digest.

```zig
var digest: [32]u8 = undefined;
std.crypto.hash.sha2.Sha256.hash(presented_token, &digest, .{});
const lookup_key = std.fmt.bytesToHex(digest, .lower);
```

This differs from the [Argon2id password verifier](/series/api-security/who-are-you) for a reason:

| Property | Human-chosen password | Random 32-byte token |
|---|---|---|
| Candidate distribution | Uneven; common choices are tried first | Uniform, assuming a sound generator |
| Search strategy | Dictionaries, reuse, and ranked guesses | Search a space of 2²⁵⁶ possibilities |
| Stored verifier | Salted, deliberately expensive password hash | Fast cryptographic digest |
| Cost paid by the API | Argon2 memory and computation | SHA-256 plus an indexed lookup |

There is no universal count of “realistic passwords.” The practical weakness is their highly uneven distribution: an attacker can try likely choices before unlikely ones. Argon2 raises the cost of those useful guesses. A uniformly generated token has no comparable shortlist. Adding an expensive password hash would impose substantial work on every API request without addressing a feasible guessing attack against a 256-bit secret.

The digest is deliberately unsalted. Precomputing a useful table over uniformly random 256-bit tokens is already infeasible, and a deterministic digest allows one indexed lookup. A per-row salt is awkward for this particular token-only lookup because the server has no row selector until it identifies the token. Other designs can send a public selector alongside a secret and use a salt; unsalted storage is a design choice here, not a universal requirement for API keys.

A read-only leak of this token table does not reveal directly usable bearer credentials. Presenting the stored hexadecimal digest causes the server to hash those characters again; that result does not match the stored digest. A regression should test the actual authentication path:

```text
present original token           → authenticated
present stored digest as token   → invalid
present one-character mutation   → invalid
```

This protects against read-only exposure of the token table. Database write access is a different capability: an attacker able to insert a chosen digest and owner can create authority without recovering an existing secret.

## Separate authentication from token management

A client needs to name a token when listing or revoking it. Using the raw credential in `DELETE /tokens/{id}` would place the secret in a request target, where access logs and tracing systems commonly record it. It would also make a lost credential difficult to revoke: the user would need the secret merely to identify the row.

The record therefore has two identifiers. The digest is an internal authentication lookup key. An independently generated handle is the identifier returned by listing and accepted by revocation. The handle uses 16 random bytes, yielding 22 unpadded base64url characters.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/token-identifiers.svg" width="700" height="380" style="min-width: 600px" alt="Two separate paths. A raw bearer token is hashed with SHA-256 into a private database digest used for authentication. An independently random handle identifies the same record in list and revoke operations. The handle is not derived from the secret.">
  <img class="plate-dark" src="/images/api-security/token-identifiers-dark.svg" width="700" height="380" style="min-width: 600px" alt="Two separate paths. A raw bearer token is hashed with SHA-256 into a private database digest used for authentication. An independently random handle identifies the same record in list and revoke operations. The handle is not derived from the secret.">
  <figcaption>One record, two purposes. The credential proves possession; the handle names something the caller may manage.</figcaption>
</figure>

Random handles avoid exposing sequence counts and make neighboring identifiers difficult to guess. They are not an authorization check. A disclosed handle must remain insufficient to revoke someone else's token.

The digest has a uniqueness constraint as well. An authentication lookup must resolve to at most one token record; accepting two owners for the same digest would leave identity dependent on row selection.

## Record what the caller proved

Token creation requires password authentication. Otherwise a stolen token could mint replacements before it was revoked, leaving the attacker with fresh credentials after the owner deleted the original.

The parser selects a mechanism from the scheme token once. Basic decodes a username and password; Bearer treats its credential as an opaque value. An unsupported scheme is refused, and a failure in one parser never falls through to the other.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/token-scheme-dispatch.svg" width="700" height="300" style="min-width: 600px" alt="The Authorization scheme branches once: Basic goes to password verification, Bearer goes to digest lookup, and any other scheme is refused. There are no fallback paths between verifiers.">
  <img class="plate-dark" src="/images/api-security/token-scheme-dispatch-dark.svg" width="700" height="300" style="min-width: 600px" alt="The Authorization scheme branches once: Basic goes to password verification, Bearer goes to digest lookup, and any other scheme is refused. There are no fallback paths between verifiers.">
  <figcaption>The header selects one parser. Only successful verification establishes the mechanism recorded on the caller.</figcaption>
</figure>

After verification, the request context records the evidence behind the identity:

```zig
pub const Mechanism = enum { password, token };

const Authenticated = struct {
    user_id: i64,
    via: Mechanism,
};
```

This simplified type separates identity from mechanism. `Basic` and `Bearer` describe wire formats; `.password` means password verification succeeded. A handler must not manufacture that evidence merely because it saw a Basic header.

The routes then have explicit requirements:

| Operation | Required evidence |
|---|---|
| `POST /tokens` | Password verification |
| `GET /tokens` | Password or valid token |
| `DELETE /tokens/{id}` | Password or valid token, with owner-scoped lookup |

A token presented to the minting route receives the same authentication error as other insufficient credentials. Uniform failure avoids an unnecessary distinction in the response; the password-only rule itself is not a secret. An invalid token cannot become valid by guessing a different header spelling or switching parsers.

Allowing token-authenticated revocation makes damage control possible without sending the password again. It also grants a stolen token the ability to list and revoke other tokens belonging to that account. Phase 5 accepts that authority; finer management scopes would be a separate policy.

## Return the credential once

Creation accepts a label and optional lifetime:

```zig
const CreateToken = struct {
    label: []const u8,
    expires_in: ?i64 = null,
};
```

The input type contains no owner, token value, or digest. Strict JSON parsing rejects those unknown fields with `400`; the owner comes from the authenticated caller and both random values come from the server. A caller cannot mint a token for another user by adding a `user_id` member.

Labels are bounded to 64 bytes and reject control characters. The default lifetime is one day; an explicit value must be between one second and 30 days. An out-of-range value is rejected rather than silently shortened. The creation response includes the actual absolute expiry, so the client can schedule replacement against the issued credential's lifetime.

The response returns `token`, `token_id`, and `expires_at`. Subsequent listing selects only management metadata:

```sql
SELECT token_id, label, created_at, expires_at, last_used_at
FROM tokens
WHERE user_id = ?
ORDER BY created_at DESC
LIMIT ?;
```

The raw value cannot be selected because it is not stored. The digest is excluded at the query boundary, rather than passed into a response object and removed later. Losing the creation response means issuing a replacement; listing cannot recover the original secret. The handle still allows the unused record to be identified and revoked.

“Returned once” describes the API lifecycle, not a guarantee against copies. Clients, diagnostic middleware, or response logs can still retain the creation response. Its secret needs the same transport, redaction, and client-storage discipline as any bearer credential. Token-creation responses should also be excluded from caches.

## Enforce both clocks in the lookup

Tokens have an absolute expiry and a two-hour idle window. Absolute expiry bounds total lifetime even under continuous use. Idle expiry removes a credential that has stopped being used, without waiting for its absolute deadline.

Both predicates are part of the authentication query:

```sql
SELECT user_id, token_id
FROM tokens
WHERE token_hash = ?
  AND expires_at > ?
  AND last_used_at > ?;
```

The bound arguments are the candidate digest, `now`, and `now - idle_window`. Identity construction only receives a row that passed all three conditions. Unknown, expired, and idle tokens produce the same empty result instead of returning a row that every caller must remember to validate.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/token-expiry-query.svg" width="700" height="340" style="min-width: 600px" alt="An authentication lookup includes three predicates: matching digest, absolute expiry after now, and last use after the idle cutoff. All three passing yields identity. Any failure yields an empty result. Timestamp refresh happens only after acceptance.">
  <img class="plate-dark" src="/images/api-security/token-expiry-query-dark.svg" width="700" height="340" style="min-width: 600px" alt="An authentication lookup includes three predicates: matching digest, absolute expiry after now, and last use after the idle cutoff. All three passing yields identity. Any failure yields an empty result. Timestamp refresh happens only after acceptance.">
  <figcaption>The clock is part of accepting the credential. Refreshing its last-use timestamp happens afterward.</figcaption>
</figure>

At creation, `last_used_at` starts at `created_at`, so a new token gets a full initial idle window. After successful lookup, the server updates `last_used_at` using the returned handle. Updating first would let presentation revive an already-idle token.

The inequalities make the boundaries explicit: equality with either cutoff means rejection. A token created at 10:00 and never used is idle at 12:00 even if its absolute expiry is tomorrow. Using it at 11:30 moves the idle deadline to 13:30, but never moves the absolute expiry.

In this implementation, a failed last-use update is logged while the already-validated request continues. The consequence is earlier-than-expected idle expiry if failures persist. The update also puts a write on the authentication path, including authenticated reads. Batching touches could reduce contention but would change the effective idle policy and needs an explicit tolerance.

The timestamps are persisted wall-clock values. Clock corrections and concurrent updates therefore deserve tests; the SQL predicate is a centralized policy, not a replacement for clock and transaction semantics.

## Revoke through the authenticated owner

Revocation deletes the credential row:

```sql
DELETE FROM tokens
WHERE token_id = ? AND user_id = ?;
```

The first parameter comes from the path. The second comes exclusively from the authenticated caller. The existence check uses the same owner filter, so a foreign handle and a never-issued handle both return `404`. A separate unscoped lookup followed by `403` would disclose which handles exist.

Deletion removes the row from future authentication queries. A soft-delete flag could work, but it would require every accepting query to include its revocation predicate. Token history, if needed for audit, can be recorded separately from the table that grants access. A package yank has different semantics: it preserves a release for existing references. Revoked credentials have no equivalent need to keep authenticating.

Deletion does not cancel a request that already resolved the token to an identity. There is a race between authentication and the eventual protected action, and a future cache or replica would add its own revocation delay. The guarantee here is that a new lookup after the deletion commits cannot find that token. Stronger synchronization would need to include the protected operation.

## Three HTTP details affect the lifecycle

### Advertise a usable authentication scheme

The shared `401` response includes both supported schemes:

```http
WWW-Authenticate: Basic realm="barbican", Bearer
```

Basic remains discoverable for password-authenticated minting. HTTP permits multiple challenges; placing a widely supported scheme first helps interoperability. Commas also separate authentication parameters, so clients need a real challenge parser. This ordering is not a universal grammar requirement, and Bearer parameters are not inherently invalid. See [RFC 9110, section 11.6.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-11.6.1).

The shared formatter omits Bearer error details because it also handles requests with no credential. RFC 6750 advises omitting those details when authentication information is absent; `invalid_token` remains meaningful for a presented token that failed. A route-aware formatter could advertise only Basic where password proof is required. [RFC 6750, section 3](https://www.rfc-editor.org/rfc/rfc6750.html#section-3) defines the challenge behavior.

### Reject duplicate query keys

`GET /tokens?limit=10&limit=40` has no useful meaning in this API. Choosing the first or last value makes behavior depend on parser conventions. The query parser rejects duplicates instead.

This is HTTP parameter pollution: a disagreement about parameter meaning, rather than HTTP message boundaries. It can cause a policy bypass when an intermediary checks one value and the handler uses another. The list limit is also parsed as an unsigned, bounded value so a negative SQLite `LIMIT` cannot turn into an unbounded result.

### A 204 has no content length

Successful revocation returns `204 No Content`, with no body and no `Content-Length`, including `Content-Length: 0`. That prohibition is in [RFC 9110, section 8.6](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.6); [RFC 9112, section 6.3](https://www.rfc-editor.org/rfc/rfc9112.html#section-6.3) makes the end of the header section the message boundary.

The response writer must account for status semantics before applying its ordinary body-length logic. An illegal length header is a protocol defect; it is not by itself evidence of an exploitable response-splitting attack.

## What the measurements establish

The reported end-to-end medians, measured in `ReleaseSafe`, are:

| Credential | Median response time |
|---|---:|
| Correct Basic password | 148.3 ms |
| Valid bearer token | 2.4 ms |
| Forged bearer token | 2.4 ms |
| No credential | 2.3 ms |

The valid-token request is approximately 62 times faster in this measurement. These are request latencies, including transport and application work, not isolated SHA-256 or database benchmarks. Hardware and sample-count details are not supplied, so the figures should not be treated as a portable capacity estimate.

The password path needed a dummy Argon2 verification because skipping that expensive operation disclosed whether a supplied username existed. Bearer verification has no analogous skipped password hash. Both accepted and rejected candidates take a short digest-lookup path, and the attacker must supply a high-entropy credential rather than a guessable username.

That removes the reason for the dummy password hash. It does not prove the entire token endpoint is constant-time: successful lookup also fetches identity and updates last use, and caches or database load can affect latency. Close medians show the large password-verification gap is gone, not that every timing side channel has been excluded.

A separate sample produced 50 distinct, 43-character tokens, with no repeated 12-character prefixes and no raw token values in the database. These are useful wiring and storage checks. They cannot certify entropy or detect every predictable generator. Security comes from the random source's contract; tests catch mistakes in how that source is used.

Lifecycle regressions carry more direct guarantees: a digest cannot authenticate, a token cannot mint another token, expiry and idle boundaries reject at equality, revocation prevents later lookup, and a foreign handle cannot select or delete another owner's row. Listing must never return either credential material or its digest.

The remaining limits are concrete. Labels do not enforce scopes, Basic still needs hashing admission controls, and token listing currently returns at most 40 records without pagination. Older records can therefore disappear from the management view until that API is extended. Phase 5 makes credentials independently issuable and revocable; per-package authority and complete operational management remain separate work.
