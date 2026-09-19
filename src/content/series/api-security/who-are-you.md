---
title: "Password Authentication: Hashing, Timing, and Request Identity"
description: "Adding Argon2id and HTTP Basic authentication to a Zig API, with explicit hashing budgets, uniform failures, and a clear separation between identity and permission."
date: 2026-09-16
order: 6
tags: ["Security", "Authentication", "Argon2", "Zig", "Timing Attacks"]
draft: false
---

Until this point, anyone who could reach Barbican could publish or yank a package version. The registry could parse a request, validate its fields, and store it safely, but it had no identity to attach to the operation.

This stage adds registration and HTTP Basic authentication. Basic sends a base64 encoding of `username:password` on each authenticated request. Base64 provides no secrecy, so it depends on the [TLS connection established previously](/series/api-security/what-the-request-stands-on). It is an intermediate design: verifying a password on every request is expensive, and a password is a poor credential for an unattended publishing job.

Authentication also leaves an important question unresolved. Knowing that Alice sent a request does not establish that Alice may modify Bob's package. The first access rule distinguishes public routes from routes requiring an authenticated user. Package ownership still needs its own authorization model.

## The password table is an offline attack surface

If an attacker obtains stored password hashes, the API's rate limit no longer controls their guesses. They can test candidates on their own hardware. A fast general-purpose hash makes each test cheap; a unique salt prevents reuse of precomputed work across accounts but does not make a single guess expensive enough.

Barbican uses Argon2id, which takes memory and time parameters as well as the password and salt. Memory hardness makes large numbers of parallel guesses more expensive. Iteration count and parallelism still matter; memory is not the only meaningful parameter. [RFC 9106](https://www.rfc-editor.org/rfc/rfc9106.html) describes the algorithm and the tradeoffs in choosing its parameters.

The selected Zig preset uses 64 MiB, two passes, and one lane. Development notes record approximately 68 ms for a verification in `ReleaseSafe` on the development machine. That is a local observation, not a throughput promise. Hardware, allocator behavior, concurrent load, and build configuration all affect it.

The practical budget is concurrent hashing:

```text
64 MiB per verification × 32 active verifications = 2 GiB
64 MiB per verification × 128 active verifications = 8 GiB
```

Those are working-memory estimates before the rest of the process. A connection limit alone can leave an unauthenticated caller able to trigger far too much hashing. A dedicated limit on active verifications, a bounded queue or immediate rejection, and rate limits are distinct controls. Registration needs the same protection because it also computes a password hash.

The implementation does not yet provide that complete admission policy. Raising hash cost without measuring aggregate demand would improve offline resistance while making the live service easier to exhaust.

## Store enough information to verify and migrate

A stored Argon2 value uses PHC string encoding:

```text
$argon2id$v=19$m=65536,t=2,p=1$<salt>$<digest>
```

The angle-bracketed fields are placeholders. The real value carries the algorithm, version, memory cost, pass count, parallelism, salt, and result. Two registrations with the same password receive different salts and therefore different stored strings.

Including parameters makes gradual upgrades possible. On successful login, the server can verify with the row's existing parameters, compare them with the current policy, and rehash if needed. Raising the default does not require knowing everyone's plaintext password or invalidating all existing rows. [OWASP's password-storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) discusses work-factor upgrades and benchmarking.

The hash itself remains sensitive: it is the material an offline attacker needs. Neither the plaintext password nor its PHC string belongs in response objects or logs. Releasing the request arena ends allocation lifetime but does not securely erase every copy of a password from memory.

## Length limits are a policy, not a strength measurement

The current registration rule accepts passwords from 12 to 128 bytes and does not require a particular mixture of uppercase letters, digits, and symbols. That avoids encouraging predictable transformations such as appending `1!` to a familiar word.

It does not establish that every accepted password is strong. Twelve repeated letters pass this rule. Length helps when it represents additional unpredictability; a long, common phrase can still be guessed early.

There are two limitations to state explicitly. First, the code measures bytes, so non-ASCII characters may consume several units of the limit. Second, the policy does not yet check a blocklist of common or compromised passwords. As a reference point, current NIST guidance requires a minimum of 15 characters for a password used as a single authentication factor, permits a lower minimum when it is part of MFA, and requires blocklist checking. This implementation's 12-byte rule is therefore not a claim of conformance. See [NIST SP 800-63B's password requirements](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/#passwordver).

The upper bound is a resource policy. It should be generous enough for passphrases, enforced without silent truncation, and consistent between registration and authentication.

## Parse Basic credentials without changing their meaning

Basic authentication has several small parsing rules. The scheme name compares case-insensitively. The value must decode as base64 within a fixed buffer. The decoded string is split at its first colon, because a password can itself contain colons.

The server copies the header into owned, bounded storage before later reads can reuse the receive buffer. It also rejects duplicate `Authorization` fields instead of arbitrarily choosing one. Otherwise, the application and an intermediary could authenticate different credentials from the same request.

The lifetime requirement extends beyond the raw header. A decoded username may be a slice into a temporary decoding buffer. If it becomes the request's authenticated identity, it must be copied into request-lifetime storage before that buffer disappears. A small parser returning a valid slice is not enough if its caller retains the slice too long.

These rules follow from the wire format and memory model, not from password hashing. [RFC 7617](https://www.rfc-editor.org/rfc/rfc7617.html) defines the Basic scheme.

## Uniform responses still leave timing differences

On a protected route, an unknown username and a wrong password produce the same authentication response:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Basic realm="barbican"
Content-Type: application/json

{"error":"authentication required"}
```

This is a response excerpt; framing headers are omitted. The challenge identifies the supported authentication scheme. The body does not reveal whether the username exists.

But identical bytes do not imply identical observations. If a missing user returns immediately while an existing user runs Argon2, the difference is roughly one hash computation. Repeated measurements can make that difference useful even across a noisy network.

The usual mitigation verifies against a fixed dummy PHC value when no account exists. That puts both paths through the same expensive operation. The dummy must use parameters comparable to current real hashes.

The intended control flow can be expressed as pseudocode:

```text
stored = lookup(username)
verification = verify(stored or dummy_hash, supplied_password)

if stored is missing or verification failed:
    return invalid
return authenticated(username)
```

The existence check after verification is essential. Dummy verification performs work; it must never create an identity, even if someone supplies a password that matches the dummy. The current fallback design needs that explicit guard rather than relying on the dummy password being unknown. Similarly, a storage failure must not fall through to successful authentication after dummy work.

This is a good example of a property a regression test should assert directly: no missing account can authenticate, independently of the dummy value used in the test.

## Which failures should be cheap?

A malformed base64 string can be rejected before hashing. So can a username outside the published grammar. These outcomes depend only on input the caller already knows. Making them expensive does not conceal account state.

| Input or lookup result | Appropriate work |
|---|---|
| No credential | Return an anonymous caller |
| Malformed encoding or invalid username syntax | Reject before hashing |
| Valid username syntax, no account | Verify against the dummy, then reject |
| Existing account, wrong password | Verify against the stored hash, then reject |
| Existing account, correct password | Verify, then construct an owned identity |

This policy removes the largest intentional timing difference; it does not make the whole endpoint constant-time. Database lookup, scheduling, caches, and mixed historical hash parameters can still produce differences. A single dummy cost cannot exactly match every account during a work-factor migration.

Timing tests should therefore compare distributions under realistic load, not declare success because two sample medians happen to be close. Password verification should use the library's comparison logic rather than adding a second ad hoc comparison around it.

## Make access a required route decision

Each route must explicitly say whether it is public or requires authentication:

```zig
const Access = enum { public, authenticated };

const Route = struct {
    method: Method,
    path: []const u8,
    access: Access,
    handler: Handler,
};
```

This simplified type has no default for `access`. Omitting the field is a compile error. That prevents a newly registered route from silently inheriting an accidental access policy, although choosing the wrong explicit policy is still possible.

The request identity distinguishes three states: no credential, invalid credential, and authenticated user. On a protected route, the first two become the same `401`. On public routes, the application must deliberately decide whether a bad supplied credential is rejected or treated as an unauthenticated view; carrying the distinction makes that decision possible.

In the current pipeline, identity resolution happens after the body has been read and before route dispatch. It is not an early header-only check. This means even a public route or unmatched URL can trigger verification when a caller supplies a well-formed credential. That gives every handler consistent identity information but increases unauthenticated work. Admission checks must run before expensive resolution.

For protected routes, the access gate runs before the handler's resource lookup. That prevents a `404` versus `401` difference from exposing resource existence to an anonymous caller. Whether authenticated callers should be able to distinguish forbidden from nonexistent objects is a separate authorization policy.

## What authentication has established

This stage identifies callers and can require identity before a write. It does not check package ownership. Any authenticated user can still reach operations that eventually need a per-package permission check.

It also sends a password and computes a password hash on every authenticated request. A later token design should let a client use a random, revocable credential with restricted authority while keeping the password out of normal API traffic. Before that transition, hashing admission, identity lifetimes, and the dummy-verification guard are concrete correctness requirements, not details that token support can retroactively fix.

Next: [bearer tokens, expiry, and revocation](/series/api-security/tokens-with-a-lifetime).
