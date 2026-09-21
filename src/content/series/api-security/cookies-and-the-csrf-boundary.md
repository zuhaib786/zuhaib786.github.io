---
title: "From Bearer Tokens to Cookies: The CSRF Boundary"
description: "Phase 6, Part I: cookie authentication, transport-bound credentials, header precedence, and safe Set-Cookie serialization—the deliberately vulnerable checkpoint before double-submit CSRF protection."
date: 2026-09-20
order: 8
tags: ["Security", "Cookies", "CSRF", "Authentication", "Zig"]
draft: false
---

A browser can submit an authenticated request without the page initiating it knowing the credential. That is the convenience of cookie authentication, and the condition that makes cross-site request forgery possible.

In [Phase 5](/series/api-security/tokens-with-a-lifetime), Barbican's clients explicitly supplied a bearer token. Moving browser authentication into a cookie gives up that property: the browser can now attach authority that the requesting page never possessed. The server must distinguish a valid session from an authorized use of that session.

> **Deliberately vulnerable checkpoint.** This article covers Phase 6, Part I, the first commit of a two-commit demonstration. At this checkpoint, cookie authentication works but there is no server-side CSRF defence. The double-submit check, its cookie-injection attack, and the session-bound fix are not implemented here. Do not use this intermediate state as the completed security feature. Phase 6 is now complete; [Part II covers the implemented protection and its tests](/series/api-security/csrf-proof-belongs-to-the-session).

## Who attaches the credential?

With an explicitly supplied bearer header, client code needs the token before it can authenticate a request. A hostile page does not gain that token merely by causing the browser to contact the API. With a session cookie, the browser consults its cookie jar and delivery rules; the page need not read the value.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/cookie-ambient-authority.svg" width="700" height="340" style="min-width: 600px" alt="Two credential paths into an API request. Application code explicitly supplies the bearer token. The browser automatically supplies an eligible session cookie, without the initiating page knowing its value.">
  <img class="plate-dark" src="/images/api-security/cookie-ambient-authority-dark.svg" width="700" height="340" style="min-width: 600px" alt="Two credential paths into an API request. Application code explicitly supplies the bearer token. The browser automatically supplies an eligible session cookie, without the initiating page knowing its value.">
  <figcaption>The difference is who supplies the authority, not whether the credential travels inside an HTTP header. Cookie is a header too.</figcaption>
</figure>

Delivery is not unconditional: `SameSite`, the destination, request context, and credentials mode all matter. But when those rules permit a cookie, its presence proves neither that the initiating page knew the secret nor that the user intended the action. CSRF exploits that distinction without first stealing the session.

This comparison is specifically about application-supplied bearer tokens. It is not a claim that every `Authorization` header is deliberate: browser-managed HTTP authentication can also supply credentials automatically. The [Fetch standard's credentials model](https://fetch.spec.whatwg.org/#credentials) includes both cookies and HTTP authentication entries.

Cookies offer a useful trade: an `HttpOnly` session can be unavailable to page JavaScript while still authenticating browser requests. Preventing direct extraction reduces one consequence of XSS, but injected script can still issue requests as the user. Moving the secret out of JavaScript does not move the application's authority out of JavaScript's reach.

## Attributes constrain the browser, not the credential

The server issues attributes in a response:

```http
Set-Cookie: session=<opaque-value>; Path=/; HttpOnly; Secure; SameSite=Lax
```

The request returns only the cookie pair:

```http
Cookie: session=<opaque-value>
```

There is no returned `HttpOnly` bit, path, or expiry for the handler to verify. Attributes are genuine browser-enforced controls, but they are not cryptographic properties of the received value. [RFC 6265, section 4.2.2](https://www.rfc-editor.org/rfc/rfc6265.html#section-4.2.2) specifies this omission.

| Attribute | Browser-side effect | What it does not establish |
|---|---|---|
| `HttpOnly` | Hides the cookie from script cookie APIs | That script cannot make authenticated requests |
| `Secure` | Restricts delivery to secure transport, subject to localhost exceptions | That the value cannot be copied or replayed |
| `SameSite=Lax` | Withholds the cookie on ordinary cross-site POSTs; allows safe top-level navigations | Protection from same-site hostile pages |
| `Path=/` | Makes the cookie eligible across the host's paths | Isolation between applications on those paths |
| No `Domain` | Keeps the cookie host-only | Isolation between ports on that host |
| `Max-Age` | Limits retention in the browser | Expiry of the server-side session |

These browser behaviours are described in [MDN's Set-Cookie reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie). Adding a valid `Domain` broadens delivery to include subdomains; omitting it is the narrower choice.

Server-side acceptance must still consult the session row's `expires_at`. A copied value does not become invalid because a browser discarded its cookie. Likewise, deleting a cookie is not sufficient server-side revocation. The distinction is between removing one client's copy and removing the authority that copy represents.

## Bind each credential to one authentication path

Suppose bearer tokens and browser sessions share a digest lookup with no credential-type restriction. A session value copied from a cookie could then be submitted as:

```http
Authorization: Bearer <session-value>
```

If that authenticates, any policy applied only to cookie-authenticated requests can be escaped by changing the transport. This becomes especially important when CSRF validation is added: credential classification must not depend solely on where an otherwise interchangeable value happened to arrive.

Barbican uses separate tables. The bearer verifier queries tokens; the cookie verifier queries sessions. Neither verifier searches the other store after a miss. The implementation verifies both cross-presentations:

```text
session value presented as Bearer token  → 401
bearer token placed in session cookie    → 401
```

This is structural separation, not a requirement that all systems use two tables. A shared table could enforce an equivalent credential-type predicate, but omitting that predicate would join two security domains. Separate stores remove that particular omission from the accepting queries.

Transport binding is not theft resistance. An attacker who possesses a valid session value can still replay it through the cookie path using a non-browser client. Cookie attributes do not prevent that, and CSRF protection is not a general defence against stolen credentials. The guarantee is narrower: a browser session cannot turn into an API token by changing a header.

## Select the credential before attempting authentication

A browser request can contain both a session cookie and an `Authorization` header. The application needs a single answer to which identity controls the request.

The header takes precedence. For the clients in this design, it represents a selected credential; the cookie is ambient. Giving the cookie priority would let a planted session replace the identity the client selected. A planted cookie might identify the attacker's account rather than the victim's, but silently changing accounts is already a security failure.

The decision is based on header **presence**, not successful verification:

```text
Authorization present → return that verifier's result
Authorization absent  → consult the session cookie
```

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/cookie-auth-precedence.svg" width="700" height="350" style="min-width: 600px" alt="Authorization presence selects a single path. Present goes to header verification and a final success or failure. Only absent goes to session-cookie verification. No failure-to-cookie fallback exists.">
  <img class="plate-dark" src="/images/api-security/cookie-auth-precedence-dark.svg" width="700" height="350" style="min-width: 600px" alt="Authorization presence selects a single path. Present goes to header verification and a final success or failure. Only absent goes to session-cookie verification. No failure-to-cookie fallback exists.">
  <figcaption>A rejected explicit credential must stay rejected. Failure is not permission to try the browser's identity instead.</figcaption>
</figure>

| Header | Session cookie | Required result |
|---|---|---|
| Valid, user A | Valid, user B | Authenticate A |
| Valid | Invalid | Use the header result |
| Invalid or unsupported | Valid | Reject; no cookie fallback |
| Present but empty | Valid | Reject; do not treat it as absent |
| Absent | Valid | Authenticate the session |
| Absent | Invalid or absent | Unauthenticated |

Fallback would hide broken clients as well as create an identity-confusion path. An expired CI token could appear to work in a browser because a different session rescued it. Exactly one verifier must own the outcome, just as Phase 5 selects exactly one parser from the authorization scheme.

## Keep cookie data out of response syntax

Dynamic `Set-Cookie` output introduces a serialization boundary. A cookie value is data; carriage return and line feed are HTTP/1 response syntax. A formatter that inserts an unchecked value can turn one into the other.

For the input `abc\r\nX-Admin:true`, naive concatenation produces:

```http
Set-Cookie: session=abc
X-Admin:true; Path=/; HttpOnly
```

That is header injection. Additional response delimiters can lead to response splitting. The receiving infrastructure determines the impact; the defect is already present when a value can create a new header.

A printable-character denylist is insufficient. A test using `abc\r\nX-Admin: true` might pass because the validator rejects the space, leaving CR and LF unchecked. Removing that space exposes the actual hole.

The writer instead accepts only RFC 6265's `cookie-octet` ranges. An equivalent Zig predicate is:

```zig
fn isCookieOctet(byte: u8) bool {
    return switch (byte) {
        0x21, 0x23...0x2b, 0x2d...0x3a,
        0x3c...0x5b, 0x5d...0x7e => true,
        else => false,
    };
}
```

These ranges reject controls, whitespace, double quotes, commas, semicolons, backslashes, and non-ASCII bytes. They implement the value grammar in [RFC 6265, section 4.1.1](https://www.rfc-editor.org/rfc/rfc6265.html#section-4.1.1), not the separate grammar for cookie names. Validate the entire value before emitting any part of the header.

Semicolon exclusion matters independently of CRLF. On `api.example.com`, an unchecked value containing `abc; Domain=example.com` can inject a domain attribute and widen scope. An unrelated domain such as `evil.example` would instead fail the browser's domain check; attribute injection cannot override that check.

Regression inputs should isolate each forbidden byte: CR, LF, tab, NUL, DEL, and every excluded printable delimiter. Test the no-space CRLF payload explicitly. The formatter should reject these inputs even if today's caller only supplies base64url: a narrow generator does not excuse an unsafe reusable serializer.

## Make exceptions visible at the call site

The cookie writer defaults to `HttpOnly`, `Secure`, `SameSite=Lax`, and `Path=/`. Its API does not expose a `Domain` field. The application has no need to share these credentials across subdomains, so it does not offer that expansion as a routine option.

The JavaScript-readable CSRF cookie is the explicit exception:

```zig
.{ .name = "csrf", .value = &csrf, .http_only = false }
```

This is the reported implementation's only `HttpOnly` opt-out. It prepares a value that browser code can later submit independently of the cookie. It does **not** protect a request merely by existing: there is no double-submit comparison yet. The session credential remains `HttpOnly`.

These are defensive defaults for this application, not the most restrictive possible settings. `Strict` withholds cookies in more situations than `Lax`; `Path=/` deliberately covers the whole host. The design benefit is that a sensitive omission cannot silently disable `HttpOnly` or `Secure`, while an intentional exception is visible in a small initializer.

## Cookie scope is not an origin boundary

An origin includes scheme, host, and port. A cookie's host/path scope does not include a port. `https://registry.example:8443` and `https://registry.example:9443` are distinct origins but share the same host's cookie scope. RFC 6265 explicitly documents the lack of [port isolation](https://www.rfc-editor.org/rfc/rfc6265.html#section-8.5).

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/cookie-scope-vs-origin.svg" width="700" height="360" style="min-width: 600px" alt="Two separate HTTPS origins, registry.example on ports 8443 and 9443, sit inside one host boundary. A host-only cookie jar connects to both. Different origins do not imply separate cookie jars, even with the Host prefix.">
  <img class="plate-dark" src="/images/api-security/cookie-scope-vs-origin-dark.svg" width="700" height="360" style="min-width: 600px" alt="Two separate HTTPS origins, registry.example on ports 8443 and 9443, sit inside one host boundary. A host-only cookie jar connects to both. Different origins do not imply separate cookie jars, even with the Host prefix.">
  <figcaption>A host-only cookie is narrower than a domain cookie, but it still does not belong to one port.</figcaption>
</figure>

“Same-site” is broader than “same-origin” too. For ordinary HTTPS domains, sibling subdomains under one registrable domain are same-site, and changing only the port does not change the site. Changing the scheme can. Consequently, `SameSite=Lax` does not exclude a hostile HTTPS sibling merely because that sibling is cross-origin. These relationships follow the [HTML standard's site definition](https://html.spec.whatwg.org/multipage/browsers.html#same-site).

This is where the planned `__Host-` prefix matters. Supporting browsers require a cookie with that prefix to be set from a secure origin, with `Secure`, `Path=/`, and no `Domain`. A sibling cannot plant a parent-domain cookie under that name. The prefix constrains cookie creation as well as delivery; its requirements and remaining lack of port isolation are explicit in the [6265bis cookie specification](https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html#section-4.1.3.2).

The prefix is not implemented in this checkpoint. Nor should the next demonstration promise that it isolates arbitrary localhost services: browsers have special handling for secure cookies on localhost, and another HTTPS service on the same host still shares the port-independent scope. A plaintext-localhost injection test needs browser-specific evidence, not just an HTTP/HTTPS label on the diagram.

## What the successful hostile-origin request proves

The reported server probe supplied a saved session and an unrelated `Origin`, then created a package with `201`. With `VALID_PACKAGE_JSON` standing for a complete valid creation payload, the request shape is:

```sh
curl -i -b jar.txt \
  -H 'Origin: https://evil.example' \
  -X POST "$BASE/packages" \
  --data "$VALID_PACKAGE_JSON"
```

```text
HTTP/1.1 201 Created
```

That result establishes the missing application check: a cookie-authenticated mutation reached the handler despite an untrusted origin and no CSRF proof. It is an expected failure at this demonstration checkpoint, not a passing security test.

It is not, by itself, a complete browser reproduction. `curl` can supply `Origin` and cookies without following browser same-site or CORS rules. A browser proof must show that the cookie is actually sent and that the endpoint accepts the resulting request format. Explicit `SameSite=Lax` normally blocks an unrelated site's POST from carrying the session. A same-site attacker exercises a different boundary.

CORS also needs precise treatment. It can prevent a preflighted request from being sent, but many form-compatible requests need no preflight; blocking access to their responses does not undo their effects. A JSON content type or custom header changes that analysis. The [Fetch standard's CORS protocol](https://fetch.spec.whatwg.org/#http-cors-protocol) defines these distinctions. The eventual exploit should document the method, content type, origins, and observed cookies, rather than infer browser behaviour from a command-line request.

## The remaining double-submit boundary

Double submission will require a CSRF value in two places: a cookie and a separately supplied request field or header. The browser attaches the first; application code supplies the second. Checking only the cookie would add another ambient credential without proving anything new.

Plain equality has a further assumption: the attacker cannot choose the cookie. If an attacker can plant a known value and submit a matching request value through an allowed channel, both copies agree without belonging to the victim's session. The planned fix must bind the proof to that authenticated session, rather than merely establish that two attacker-controlled strings match. [OWASP's double-submit guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#signed-double-submit-cookie-recommended) recommends session-bound signed tokens and explains the cookie-injection weakness of the naive variant.

Part I establishes safe cookie serialization, separate credential stores, and deterministic authentication precedence. None supplies the missing proof for a state-changing browser request. At this checkpoint, a valid session remains enough for the demonstrated mutation. Continue with [Part II: the proof belongs to the session](/series/api-security/csrf-proof-belongs-to-the-session) for the completed verification, the cookie-injection tests, and the session lifecycle.
