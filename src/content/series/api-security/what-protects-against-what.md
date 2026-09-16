---
title: "A Threat Model for a Small Package Registry"
description: "Starting an API security project by defining the assets, callers, trust boundaries, and failure cases that its controls need to address."
date: 2026-09-13
order: 1
tags: ["Security", "API", "Zig", "OAuth"]
draft: true
---

Suppose a package registry accepts this request from anyone:

```http
DELETE /packages/zig-toml/versions/0.1.0 HTTP/1.1
Host: registry.example
```

The handler marks that version as yanked so it will no longer be selected for new installations. The SQL can be parameterized, the request can arrive over TLS, and the body can pass every validation rule. The operation is still a security failure if the caller has no relationship to the package.

This is the starting point for Barbican, a small package-registry API I am building in Zig. The project is a way to study how API security controls fit together. The articles use small examples and explain the relevant design locally; no access to the implementation is needed.

A registry is a useful subject because its security requirements are concrete. Publishing changes what other people install. Package ownership determines who may make that change. Public reads must remain available even when callers behave badly. Human maintainers and CI jobs need different credentials and recovery procedures.

Before choosing a token format or authentication protocol, I need to decide which failures the system must prevent and which assumptions those guarantees depend on.

## Start with assets and allowed operations

The obvious assets are passwords and tokens, but a registry also holds package names, ownership relationships, immutable release identities, artifact bytes, and availability. Losing any one of those can affect downstream users.

For the initial design, I want the following properties:

| Operation | Required property |
|---|---|
| Claim a package name | One canonical name identifies one package |
| Publish a version | The caller has publish authority for that package |
| Fetch a version | Metadata and artifact bytes identify the intended release |
| Publish the same version again | Existing release content cannot be silently replaced |
| Yank a version | Only an authorized caller can change resolution policy |
| Read public metadata | One caller cannot consume an unbounded share of capacity |

Yanking needs a precise meaning. Here it marks a release as unsuitable for future selection while preserving its identity. Whether an existing lockfile may still fetch it is a registry policy, not an automatic consequence of setting a boolean column.

The immutability requirement also needs more than a unique database key. Uniqueness prevents duplicate rows; it does not prevent an update to a checksum or replacement of an artifact. The guarantee must cover the complete write path and the storage system that serves the bytes.

## Name the attacker capabilities

The first attacker can connect to the public API and send arbitrary bytes. They can choose lengths, duplicate fields, malformed encodings, request timing, and connection counts. They do not need an account to exercise the HTTP parser, TLS handshake, or registration endpoint.

The second attacker has a valid low-privilege account. They can send correctly authenticated requests for somebody else's package. This is where object-level authorization matters: checking a token's validity cannot answer whether its subject owns the package named in the URL.

The third attacker has stolen something: a database snapshot, an API token, or a client session. Those are different capabilities. A password hash allows offline guessing. A usable bearer token permits requests until its authority is rejected or expires. A browser session may let an attacker act through the browser even when they cannot read its cookie.

A network attacker adds another case: observing or modifying traffic between the client and the registry. TLS addresses that path when certificate verification is correct. It does not protect secrets in application logs or a compromised endpoint.

Writing these capabilities separately avoids assuming that one successful defense covers all of them. A registration rate limit has no effect on offline password guessing after a database leak.

## Follow one request through its boundaries

A publish request passes through several representations:

```text
network bytes → HTTP message → route and identity
              → validated publish input → database and artifact storage
```

Each transition introduces a question. Does the body length mean the same thing to the proxy and server? Is the captured package name still valid after decoding? Does the identity outlive the buffer used to decode it? Is this identity authorized for this package? Does a description remain a bound SQL value and a JSON string?

Zig makes ownership and allocation decisions explicit, which is useful for this exercise. It also makes them the application's responsibility. Runtime safety checks help with some illegal operations, but they do not automatically prevent dangling slices, races, or unsafe C interop. Writing the server without a framework expands what I must verify; it does not inherently produce a safer server.

The first implementation supports metadata operations with SQLite. Artifact verification, scoped credentials, browser sessions, delegated login, and ownership policy are separate steps. A design goal in this introduction should not be read as a claim that all of those features already exist.

## Match a control to a failure

A useful control description includes both what it changes and the assumption it leaves behind:

| Control | Failure it addresses | Remaining requirement |
|---|---|---|
| Framing validation | Two parsers assign different request boundaries | Test the actual proxy and origin combination |
| Body and header limits | Unbounded input buffering | Bound concurrency, execution time, and outputs too |
| Prepared SQL parameters | A value changes SQL structure | Map dynamic identifiers and enforce authorization |
| Context-specific output encoding | Data changes the surrounding output syntax | Apply it again when data enters another context |
| TLS with certificate validation | Traffic interception and network impersonation | Protect endpoints and any post-termination hop |
| Password hashing | Cheap offline guesses against a stolen table | Control online attempts and hashing concurrency |
| Resource ownership checks | A valid caller modifies another account's objects | Define and maintain ownership correctly |
| Scoped, revocable tokens | A credential grants excessive or lasting authority | Protect the token and check its current validity |
| Audit records | Security-relevant actions leave no usable evidence | Protect logs and arrange detection and response |

Some controls change probability or cost rather than forbidding an operation. Password hashing raises the price of a guess. A rate limit reduces how many attempts a caller can make through one identity or network path. Neither guarantees that a weak password will remain unknown.

Other controls establish a narrower structural property. Binding a string parameter prevents that string from becoming SQL syntax in that statement. It says nothing about whether the statement should have been executed for this caller.

## Browser controls have a different scope

CORS is often described as though it were an API access list. Its actual scope is browser enforcement of cross-origin interactions. A server's CORS policy can allow another origin's JavaScript to read a response that would otherwise be unavailable to it. It does not authenticate a `curl` client or prevent all cross-origin requests from being sent. The protocol is defined in the [Fetch standard](https://fetch.spec.whatwg.org/#http-cors-protocol).

That distinction matters when an API uses cookies. A browser can attach a credential to some cross-site requests even when the initiating page cannot read the response. A state-changing endpoint therefore needs a CSRF policy based on its actual credential and request behavior. An unreadable response does not undo a successful write.

Cookie attributes solve narrower problems too. `HttpOnly` prevents ordinary page JavaScript from reading the cookie, but injected script can still issue same-origin requests with it. `Secure` restricts cookie transmission to secure transport. `SameSite` influences cross-site sending, with behavior that depends on its setting and the request context. These settings complement application checks rather than establishing package ownership.

The registry's CLI and CI clients do not inherit those browser protections. Their tokens need direct authentication, scope checks, and revocation behavior at the API.

## Credential format does not decide authorization

An opaque token usually leads to a server-side lookup. A signed token can carry claims that the API validates locally. Either can represent excessive authority, and either can be stolen.

For a locally validated signed token, early revocation requires additional state or a change to what the API accepts. Short expiry limits the duration of exposure but does not stop misuse during the accepted interval. An opaque token makes centralized revocation straightforward, at the cost of a lookup and a dependency on that store. These are architecture choices, not a ranking where the more elaborate format is more secure.

The same applies to permission models. A package may initially need only an owner relation and a publish permission. Roles can simplify a larger organization, but adding roles before defining object-level rules does not solve the central question: may this principal perform this action on this package now?

## Make each claim testable

For each control, I want an example that failed before the change and a regression that exercises the resulting guarantee. A duplicate length should be rejected without invoking a handler. A quote in a description should survive storage and retrieval as data. A non-owner should be denied even when their credential is valid. A failed allocation should unwind without leaking a socket or database statement.

Tests also need to preserve legitimate behavior. Rejecting every publish request would prevent unauthorized publishing but would not implement a registry. A useful regression pairs the denied case with the authorized operation that must still work.

The implementation articles begin with [the HTTP boundary](/series/api-security/the-http-layer), then add [resource limits and injection defenses](/series/api-security/bounding-a-request), [memory ownership and TLS](/series/api-security/what-the-request-stands-on), and [password authentication](/series/api-security/who-are-you). A separate article explains [OAuth's front and back channels](/series/api-security/front-channel-back-channel), because delegated authorization introduces another set of actors and transaction-binding requirements.
