---
title: "CORS: Relaxing the Browser's Boundary"
description: "Phase 7 of Barbican: exact origin allowlists, credentialed preflights, cache variation, and why permission to read a response never replaces authentication or CSRF protection."
date: 2026-09-22
order: 10
tags: ["Security", "CORS", "HTTP", "CSRF", "Zig", "Caching"]
draft: false
---

CORS does not add authentication to an API. It tells a browser when JavaScript may read a response that the browser would otherwise keep outside that script's origin.

That makes Phase 7 different from the preceding stages of Barbican, the package-registry API in this series. Those stages added restrictions. This one deliberately relaxes a browser restriction so a UI on another origin can use the registry. A broad CORS policy is not a missing defence; it is permission the server chose to grant.

[Phase 6](/series/api-security/csrf-proof-belongs-to-the-session) required a session-bound CSRF proof in a custom header. Cross-origin attempts to send that header were already blocked, but not by an intentional CORS implementation. The method parser accepted four methods; `OPTIONS` was not one of them. Browser preflights failed at request-line parsing, and the mutation never followed. Phase 7 replaces that accidental refusal with an explicit sharing policy.

## A blocked request and an unreadable response are different failures

A cross-origin fetch can fail at two different points.

For a request carrying `X-CSRF-Token`, the browser first sends an `OPTIONS` preflight describing the intended method and header names. If permission is missing, it does not send the actual request. The server receives the preflight, but the protected operation does not run.

A request that needs no preflight behaves differently. A plain `GET` can reach the server, pass through routing, and produce a response. Without a matching CORS grant, the browser refuses to expose that response to the calling script. The request has already happened. This distinction is documented in [MDN's CORS guide](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS).

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/cors-two-failure-shapes.svg" width="700" height="460" style="min-width: 620px" alt="Two cross-origin failure paths. On the left, an OPTIONS preflight reaches the API and is refused; the browser never sends the mutation. On the right, a request requiring no preflight reaches the API and runs through its checks; the response returns, but the browser blocks script access. Blocking a response does not undo a request.">
  <img class="plate-dark" src="/images/api-security/cors-two-failure-shapes-dark.svg" width="700" height="460" style="min-width: 620px" alt="Two cross-origin failure paths. On the left, an OPTIONS preflight reaches the API and is refused; the browser never sends the mutation. On the right, a request requiring no preflight reaches the API and runs through its checks; the response returns, but the browser blocks script access. Blocking a response does not undo a request.">
  <figcaption>The preflight itself reaches the server. Only the actual request is withheld. Without preflight, a browser can block access to a response after the server has acted.</figcaption>
</figure>

The second path explains why the same-origin policy is not a general CSRF defence. A form-compatible POST to an unprotected endpoint can change state even if the attacker cannot read the reply. It still needs credentials to be delivered and the server to accept the action; cookie policy, authentication, and CSRF checks remain separate barriers. A CORS error proves none of those checks ran or succeeded.

## Match an origin, not a convenient substring

Credentialed origin reflection is dangerous:

```http
Access-Control-Allow-Origin: <whatever Origin contained>
Access-Control-Allow-Credentials: true
```

When the browser permits credentials to accompany the request, this configuration lets an arbitrary requesting origin read the authenticated response. The browser cannot distinguish deliberate trust from a server copying an untrusted header.

The implemented alternative is an exact allowlist. For the development UI, the permitted origin is `https://localhost:3000`. Scheme, host, and port are all part of the decision. Representative negative cases are:

| Candidate origin | Why it is not the configured origin |
|---|---|
| `https://localhost.evil.example:3000` | A hostname prefix is not a host match |
| `https://evil-localhost:3000` | Containing the trusted hostname is insufficient |
| `https://evillocalhost:3000` | A hostname suffix is not equality |
| `http://localhost:3000` | Different scheme |
| `https://localhost:3001` | Different port |

Configured values should use serialized origins, not page URLs with paths or trailing slashes. Exact comparison is deliberately narrow: a spelling mismatch denies sharing rather than expanding trust. Configuration validation should catch mistakes before they become browser failures.

For a disallowed origin, the ordinary API response has no `Access-Control-Allow-Origin`. The CORS decision does not itself replace the route's result with an error status. Authentication and authorization still determine whether an ordinary request succeeds; the absent grant prevents the browser from handing its response to that origin's script.

This does not mean the caller learns nothing. Requests may have effects, side channels remain, and non-browser clients can read responses directly. CORS refusal is a browser response-access decision, not a promise of endpoint secrecy.

### `null` is an origin value, not a missing header

Some opaque origins serialize as `null`, including suitably sandboxed documents and some non-HTTP document contexts. An attacker can create such a context; the string does not identify one trusted local file or one particular application. Allowlisting it groups unrelated opaque origins under the same grant. [MDN explicitly warns against allowing `null`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Allow-Origin#null).

Barbican does not grant it permission. A missing `Origin` takes the non-CORS request path; a present `Origin: null` is an untrusted value. Neither grants a browser exception merely because the parser represents it as empty or unusual.

## Make wildcard and credentialed policies different types

`Access-Control-Allow-Origin: *` can expose non-credentialed responses to any origin. It cannot authorize response access when the fetch credentials mode is `include`. Browsers reject that combination even when `Access-Control-Allow-Credentials: true` is also present. The invalid pair fails closed; unrestricted **reflection of a concrete origin** is the disclosure risk, not a browser treating credentialed `*` as universal permission. The [Fetch standard's credentials table](https://fetch.spec.whatwg.org/#cors-protocol-and-credentials) makes the distinction explicit.

The policy type separates those modes. A simplified Zig representation is:

```zig
const CorsPolicy = union(enum) {
    disabled,
    wildcard,
    exact: struct {
        origins: []const []const u8,
        credentials: bool,
    },
};
```

There is no credentials field on the wildcard arm. The formatter derives headers from the selected arm instead of accepting independent `allow_origin` and `allow_credentials` switches. Exact-list entries still need configuration validation: `*`, `null`, and malformed origins do not belong in that list.

This is the same design technique as deriving CSRF requirements from the authentication mechanism and method. Remove an invalid combination from routine configuration rather than relying on every future caller to remember the exception.

## A 204 is not permission by itself

An allowed preflight needs response headers that cover the requesting origin, intended method, and requested non-safelisted headers. For example, this is a representative exchange for a JSON creation request:

```http
OPTIONS /packages HTTP/1.1
Origin: https://localhost:3000
Access-Control-Request-Method: POST
Access-Control-Request-Headers: content-type, x-csrf-token
```

```http
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://localhost:3000
Access-Control-Allow-Credentials: true
Access-Control-Allow-Methods: POST
Access-Control-Allow-Headers: Content-Type, X-CSRF-Token
Vary: Origin
```

The preflight carries header **names**, not the CSRF secret. Cross-origin preflights also do not carry the session cookie; they ask whether the subsequent request is permitted, not whether a user is authenticated. Successful negotiation therefore cannot stand in for authenticating the real request. These are [Fetch's preflight semantics](https://fetch.spec.whatwg.org/#cors-preflight-fetch).

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/cors-preflight-and-action.svg" width="700" height="400" style="min-width: 620px" alt="A browser sends OPTIONS with origin, intended method, and header names. The API replies with 204 and matching CORS policy. Only then does the browser send the real POST with its session and CSRF proof. The server separately checks identity, proof, and permission before returning a response with CORS headers for browser readability.">
  <img class="plate-dark" src="/images/api-security/cors-preflight-and-action-dark.svg" width="700" height="400" style="min-width: 620px" alt="A browser sends OPTIONS with origin, intended method, and header names. The API replies with 204 and matching CORS policy. Only then does the browser send the real POST with its session and CSRF proof. The server separately checks identity, proof, and permission before returning a response with CORS headers for browser readability.">
  <figcaption>The preflight permits a request shape. The actual request must still establish identity, CSRF proof, and permission to perform the operation.</figcaption>
</figure>

The implemented preflight handler returns `204` whether or not the origin is permitted. It emits method information only after the origin matches the allowlist. Without the required grant headers, a successful HTTP status is still a failed CORS negotiation. This also avoids making the status a second signal about which paths accept which methods.

The uniform status does not make route discovery impossible. A non-browser client can forge an allowlisted `Origin`, and the allowlist is not a secret. Gating `Access-Control-Allow-Methods` avoids unsolicited method disclosure, but it is not authentication and cannot guarantee confidentiality of the route map. Malformed HTTP remains subject to the ordinary parser rules; `204` describes handled preflight outcomes, not every possible input.

The actual response needs its CORS headers too, including when the application refuses the operation. An allowed UI should be able to read its `401` response instead of receiving an indistinguishable browser CORS failure. None of these `204` responses has a body or `Content-Length`, preserving the framing rule established in Phase 5.

## Cache the origin-dependent response as an origin-dependent response

The origin matcher can be correct while a shared cache serves the wrong policy. If a response varies with `Origin`, caching only by URL loses an input to the server's decision.

Barbican emits `Vary: Origin` on every response, including those with no allow-origin grant and those requested without an `Origin`. The omission case matters: a cache must not treat a no-grant response as the universal variant and later serve it to an allowed UI. `Vary` communicates which request fields select a representation; [RFC 9110 defines that contract](https://www.rfc-editor.org/rfc/rfc9110.html#section-12.5.5), and [RFC 9111 defines matching cached variants](https://www.rfc-editor.org/rfc/rfc9111.html#section-4.1).

The failure is not automatically an allowlist bypass. If a cache gives origin B a response with `Access-Control-Allow-Origin: A`, the browser still sees a mismatch and blocks B. Wrong variants can break legitimate access; disclosure requires additional conditions, such as incorrectly shared personalized data or policy rewriting. The cache problem is real without assuming that the browser stops comparing origins.

`Vary: Origin` also does not separate users at one origin or make authenticated content safe for a shared cache. Sensitive responses still need an appropriate cache policy, and the intermediary must honour it. Any existing `Vary` dimensions must be preserved rather than overwritten by the CORS formatter.

Emitting the header everywhere is a conservative implementation rule, not a claim that an invariant wildcard response inherently varies by origin. It trades some cache reuse for a simpler guarantee that no origin-dependent response path forgets the dimension.

## Origin and site answer different questions

The CORS matcher uses origins: scheme, host, and port. Cookie `SameSite` uses sites: for ordinary domains, scheme and registrable domain; for localhost, the host itself. Ports do not distinguish sites. The [HTML standard defines these separate relationships](https://html.spec.whatwg.org/multipage/browsers.html#same-site).

For a UI fetching `https://localhost:8443`, the distinction is:

| UI origin | Same origin? | Same site? | Session cookie with `SameSite=Lax` on a fetch using `include` |
|---|---|---|---|
| `https://localhost:8443` | Yes | Yes | Eligible |
| `https://localhost:3000` | No | Yes | Eligible; CORS still applies |
| `http://localhost:3000` | No | No: scheme differs | Withheld for this cross-site fetch |

“Eligible” assumes the cookie exists, matches the target host and path, has not expired, and is not blocked by another browser policy. The table concerns fetches, not Lax's separate exception for safe top-level navigations. [Cookie delivery rules](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#samesitesamesite-value) remain independent of CORS permission.

Serving the UI over HTTP therefore introduces a second reason the authenticated call can fail. Granting that origin CORS access cannot override SameSite. Using HTTPS on both ports isolates the intended experiment: different origins, the same site, and an otherwise eligible session cookie.

There is one more independent switch. Fetch defaults to `credentials: "same-origin"`, so it does not send cookies to the other port even though the request is same-site. Cross-origin session calls need `include`:

```javascript
await fetch("https://localhost:8443/packages", {
  method: "POST",
  credentials: "include",
  headers: {
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken,
  },
  body: JSON.stringify(packagePayload),
});
```

Here `csrfToken` is the proof issued for the session, and `packagePayload` is a valid creation payload. `include` asks the browser to use eligible credentials; it neither overrides cookie restrictions nor supplies the server's CORS grant. [The Request credentials documentation](https://developer.mozilla.org/en-US/docs/Web/API/Request/credentials) describes that client-side setting.

## Allowing an origin must not waive the request proof

Once the development UI is allowlisted, its preflight can succeed. That intentionally removes the refusal that previously happened before a custom-header mutation left the browser. The session-bound verifier must now demonstrate its independent decision.

The reported creation requests produce:

```text
allowlisted origin + valid session + genuine CSRF header  → 201
allowlisted origin + valid session + header omitted       → 401
```

The first establishes that the cross-origin integration works. The second establishes that CORS permission has not become permission to mutate. If the remaining content type still requires preflight, that preflight can succeed too; the server rejects the actual request because the session proof is missing. The reported `401` is preserved here, along with the [status-code distinction discussed in Phase 6](/series/api-security/csrf-proof-belongs-to-the-session#three-rejected-requests-only-one-isolated-control).

CORS does participate in deciding whether a browser may send a preflighted request; saying it only ever controls reading would miss half of the protocol. But it never decides whether an authenticated account owns a package or whether a session-bound CSRF proof matches. Those remain application decisions after negotiation.

An allowlisted UI is trusted code, not an adversary neutralized by CSRF. If that UI is compromised and can obtain the genuine proof, it can make valid requests. The negative test demonstrates the missing-proof gate, not safety against arbitrary script execution inside a trusted frontend.

## A command-line client does not negotiate browser permission

The non-browser path remains unchanged:

```sh
curl -H "Authorization: Bearer $TOKEN" "$BASE/packages/x"
```

No `Origin`, no preflight, and no CORS permission are required. With a valid token and sufficient application permission, the request works. This is not a bypass: curl is not executing an untrusted page inside a user's browser, so there is no browser response-isolation policy for it to enforce.

Phase 7 opens a specific browser integration while leaving the API's actual security decisions in place. The origin allowlist controls sharing, the cookie rules control credential delivery, the session-bound proof controls cookie-authenticated mutations, and authorization controls the operation. A request succeeding at one boundary does not supply evidence for the next.
