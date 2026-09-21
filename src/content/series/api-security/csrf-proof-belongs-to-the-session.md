---
title: "CSRF Protection: The Proof Belongs to the Session"
description: "Phase 6, Part II: replacing naive double-submit equality with a session-bound verifier, preserving reloads, deriving CSRF policy, and testing the control independently of SameSite and CORS."
date: 2026-09-20
order: 9
tags: ["Security", "CSRF", "Cookies", "Sessions", "Zig", "Testing"]
draft: false
---

Comparing a request header with a cookie proves that two client-supplied values agree. It does not prove that either value belongs to the authenticated session.

That is the boundary the completed Phase 6 changes. Barbican, the package-registry API in this series, starts with naive double-submit validation, demonstrates its cookie-injection weakness, and replaces it with a digest stored in the session record. The JavaScript-readable cookie remains, but only to carry the token across page reloads. It no longer supplies the expected answer to the server's comparison.

[Part I](/series/api-security/cookies-and-the-csrf-boundary) deliberately stopped with cookie authentication and no server-side CSRF check. This part completes the request check and session lifecycle. The important change is not another cookie attribute: one side of the verification now comes from server-controlled state.

## Require something the browser does not attach for the page

An explicitly supplied bearer token requires client code to possess the credential. A session cookie does not: when delivery rules permit it, the browser supplies the value based on the destination and request context. A page can therefore cause an authenticated request without knowing the session secret.

The first defence requires a custom request header on session-authenticated mutations. Ordinary HTML forms cannot set that header. A cross-origin `fetch` that adds it requires a successful CORS preflight before the browser sends the mutation. This is the relevant distinction between a form-compatible request and one carrying a non-safelisted header in the [Fetch standard](https://fetch.spec.whatwg.org/#cors-preflight-fetch).

In this server, preflight refusal is a consequence of a narrow implementation: `OPTIONS` is not supported and is rejected during request-line parsing. There is no CORS permission for the browser to obtain. The mutation is not sent; the preflight itself is.

This is useful defence in depth, but an incidental parser restriction is not a policy worth depending on indefinitely. Adding `OPTIONS` later must not accidentally grant cross-origin permission. Conversely, omitting CORS response headers does not prevent every cross-origin request: forms can still send requests whose responses they cannot read. The application check must reject a missing CSRF header regardless of how the request arrived.

## Equality is not session binding

The initial check has this shape:

```text
request.csrf_header == request.csrf_cookie
```

A page unable to read the legitimate cookie cannot simply copy its value into a request. But cookie injection changes the problem. If the attacker can plant a known CSRF cookie and supply a matching header, neither side of the equality has to originate with the server.

Cookies do not have the same isolation boundary as browser origins. Another port on the same host can share cookie scope; a sibling subdomain may be able to plant a parent-domain cookie. The exact overwrite or shadowing behaviour depends on names, attributes, and browser rules. The relevant capability is choosing the value the naive verifier treats as authoritative.

The completed check instead has this shape; the field names are schematic:

```text
session = authenticate_session(request.session_cookie)
expected = session.csrf_digest
accept only if digest(request.csrf_header) matches expected
```

The expected digest must come from the **session that authenticated this request**, not from any session belonging to the same user and not from a global search for a matching token. Association with a specific session is the binding. Missing or malformed proof must fail before a protected handler runs; digest comparison should avoid content-dependent early exits.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/csrf-comparison-boundary.svg" width="700" height="440" style="min-width: 620px" alt="Two panels compare CSRF verification. Naive double submit compares a header and cookie that both come from the client. Session-bound verification compares the digest of the client header with the expected digest from the authenticated session in the database. The incoming CSRF cookie is not a verifier input.">
  <img class="plate-dark" src="/images/api-security/csrf-comparison-boundary-dark.svg" width="700" height="440" style="min-width: 620px" alt="Two panels compare CSRF verification. Naive double submit compares a header and cookie that both come from the client. Session-bound verification compares the digest of the client header with the expected digest from the authenticated session in the database. The incoming CSRF cookie is not a verifier input.">
  <figcaption>The fix changes who supplies the expected value. Hashing two attacker-chosen values would not create this boundary.</figcaption>
</figure>

The reported paired probes isolate the change:

```text
planted CSRF cookie + matching planted header   → 401
planted CSRF cookie + genuine session proof     → 201
```

The first request previously returned `201` under naive double submit. The second is the necessary control: it holds the planted cookie constant and restores the legitimate proof. The refusal is caused by the session binding, not by cookie pollution making every request fail.

These probes test the server-side verifier. They are not evidence that a sibling page can bypass the current CORS restriction to send a custom header. A complete browser exploit would also need a way to deliver that header; the existing preflight refusal remains an independent barrier.

The final design is stateful session-bound verification, closer to a synchronizer token than stateless double submit. It does not require a signed token or HMAC: the session store supplies the trusted reference. [OWASP distinguishes stateful synchronizer tokens from double-submit designs](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#token-based-mitigation); keeping a transport cookie does not make cookie-to-header equality the security property.

## Keep the cookie for reloads, not for verification

Removing the readable cookie initially looks cleaner. Return the CSRF token in login JSON, keep it in JavaScript memory, and store only its digest on the server.

A reload breaks that arrangement. JavaScript loses the token, while the `HttpOnly` session cookie survives and still authenticates requests. Reads can work, but mutations lack their required proof. The server cannot reconstruct the original token from its digest. Without another recovery or rotation mechanism, the client needs to authenticate again to obtain a new session and token.

The implemented solution keeps the readable cookie. After a reload, application code reads it and supplies its value in the custom header. The server authenticates the session cookie and validates the header against that session's stored digest. It does not consult the incoming CSRF cookie as an expected value.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/csrf-reload-transport.svg" width="700" height="400" style="min-width: 620px" alt="After reload, the browser retains an HttpOnly session cookie and a script-readable CSRF cookie. The session cookie selects the server-side session record. Application code copies the CSRF token into a request header, whose digest is checked against that record. There is no server verification arrow from the incoming CSRF cookie.">
  <img class="plate-dark" src="/images/api-security/csrf-reload-transport-dark.svg" width="700" height="400" style="min-width: 620px" alt="After reload, the browser retains an HttpOnly session cookie and a script-readable CSRF cookie. The session cookie selects the server-side session record. Application code copies the CSRF token into a request header, whose digest is checked against that record. There is no server verification arrow from the incoming CSRF cookie.">
  <figcaption>The readable cookie preserves the value for the client. The session row determines whether that value is acceptable.</figcaption>
</figure>

This changes the regression contract. Under double submit, an absent CSRF cookie must not waive the comparison. Under the final design, that cookie is not a verifier input at all:

```text
valid session + genuine proof + no CSRF cookie  → proof remains valid
valid session + CSRF cookie + no header         → reject
```

The first case describes server verification, not the ordinary client's ability to recover a lost token. If the readable cookie is deleted and JavaScript has no other copy, the client still needs recovery. A forged cookie can similarly disrupt the value the application sends, but cannot make the server accept that forged value. Availability of the proof and authority of the proof are separate concerns.

## Derive the requirement instead of declaring it on routes

A route needs an explicit access policy. Only the application designer knows whether a path is public, requires an account, or requires a particular privilege.

The CSRF requirement in this design is different. Once authentication has selected a mechanism, it follows from that mechanism and the HTTP method:

```text
requires_csrf = session_authenticated && !safe_method
```

An illustrative Zig expression is equally small:

```zig
const needs_csrf = via_session and !method_is_safe;
```

The inputs come from successful authentication and the parsed method, not from client claims. Header-authenticated API calls retain the explicit-credential path described in Part I. Session-authenticated mutations pass through the CSRF gate before routing to a handler. Safe methods must actually remain read-only; moving a mutation to `GET` would violate the assumption behind the predicate.

A per-route `csrf_required` flag would duplicate a derivable fact. Every new route would then depend on someone remembering to set it. Computing the requirement removes that omission, in the same way that deriving `Content-Length` from a body removes disagreement between two independently supplied values.

This predicate is not a complete login-CSRF policy. A request establishing a session may arrive without an authenticated session at all. Nor is it a reason to treat browser-managed Basic authentication as non-ambient. Its scope is the mechanisms and mutation paths implemented here, with explicit header credentials as the non-cookie alternative.

## Three rejected requests, only one isolated control

A browser demonstration is useful only if its failure identifies the intended defence. Two tempting demonstrations can succeed without the new verifier executing at all.

| Request | Independent barrier | What the result establishes |
|---|---|---|
| Form POST from an unrelated site | Explicit `SameSite=Lax` withholds the session cookie | Cookie-delivery policy, not successful CSRF validation |
| Cross-origin fetch with the custom header | Failed CORS preflight prevents the mutation | No cross-origin permission for that request |
| Same-origin mutation with a valid session, header omitted | Neither of those barriers | The application's proof requirement is enforced |

The third case is a controlled negative test, not a claim that an ordinary attacker can execute script in the trusted origin. Origin and session stay fixed; the required header is deliberately removed. The reported result is `401`. Restoring the genuine proof provides the positive control.

The same experimental discipline applies to token substitution: keep the session, method, body, and planted cookie fixed, then change only the header. A rejection without a corresponding valid request could just mean the endpoint is broken. The paired `401` and `201` distinguish refusal of the forged proof from general failure.

The traces here retain their observed status codes. For an otherwise authenticated session, `403` communicates a failed request permission or CSRF proof more clearly than `401`, which asks the client to authenticate. Re-login cannot repair a fetch that still omits its header. Uniform status codes do not conceal the header requirement from an attacker; they can conceal the cause from the developer debugging it. HTTP distinguishes [authentication challenges](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.2) from [request refusal](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.4); the traces do not establish that this implementation already returns `403`.

## Host prefixes reduce cookie injection, not port sharing

Cookie pollution appeared without an intentional attack: an unrelated local Java service placed `JSESSIONID` and `csrfToken` cookies on requests reaching the registry at another port. Those names did not collide with `csrf`, but they exposed the shared cookie scope. A colliding name could affect which value a parser or application selects.

The completed phase adopts `__Host-` naming. Supporting browsers require that prefix to accompany `Secure`, `Path=/`, and no `Domain`, set from a secure origin. A sibling subdomain cannot create a parent-domain cookie under that name. Incorrect attributes make the browser reject the cookie; the application may merely appear unable to retain a login. The requirements are defined in the [6265bis prefix rules](https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html#section-4.1.3.2).

The limit matters: **`__Host-` does not isolate ports.** Another HTTPS origin on the same host can satisfy those requirements. Localhost also has special secure-cookie handling, documented in [MDN's cookie reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#secure). The prefix is therefore not a universal fix for the local sibling-service scenario. Host prefixes constrain injection; session binding prevents an injected CSRF value from becoming valid proof.

Shared scope also makes a cookie-count limit an operational constraint. Unrelated applications' cookies consume the same request budget. Refusing an over-budget header keeps parsing bounded, but can make every request fail after another application adds cookies. Diagnostics should identify the budget violation without logging cookie values; otherwise a correct refusal is easily mistaken for a session or TLS failure.

## Logout must remove authority before clearing a copy

An expired cookie stops one browser sending a value. It does not invalidate copies elsewhere. The session row is what authorizes future authentication, so logout destroys that row before emitting cookie-clearing instructions.

The reported replay check is direct:

```text
same session value before logout    → 200
same session value after logout     → 401
remaining rows for that session     → 0
```

This proves more than seeing an empty cookie jar. The previously valid credential is replayed independently of the browser's willingness to retain it. As with bearer-token revocation, deletion does not retroactively cancel a request that already authenticated.

Session deletion is scoped through the authenticated owner. A different user's session and an identifier never issued both return `404`; an unscoped existence lookup followed by a distinct refusal would disclose which identifiers are real.

Cookie clearing also depends on which session was deleted. Ending the session that authenticated the current request should clear its browser cookies. Closing another of the same user's sessions must leave the current login intact. `Set-Cookie` goes to the browser receiving this response; it cannot address the other device. Deleting the other row is sufficient to make that device's next authentication fail.

## Fresh login closes the fixation path

Session fixation needs a known identifier to survive the victim's authentication. Login here creates a fresh session row and does not adopt a client-supplied identifier. There is no anonymous session being upgraded in place, so there is nothing in that flow that needs an additional identifier rotation.

The useful regression condition is the one that could reopen the flaw: adding pre-login sessions and preserving their identifiers after authentication, or allowing login input to select an existing session. At that point, replacement on the privilege transition becomes necessary. Fresh identifiers address fixation; they do not by themselves prevent login CSRF, where the victim is induced to enter the attacker's account.

## Test certificate rejection without depending on the laptop

One TLS smoke assertion originally expected a bare `curl` request to fail. That tested the machine's trust configuration. Once the development CA was trusted so the browser could load the demonstration without an interstitial, the assertion failed while the server remained unchanged.

The replacements control the reason for rejection:

| Negative case | Controlled condition | Required failure |
|---|---|---|
| Untrusted issuer | Use a CA that did not sign the server certificate | Certificate-chain verification |
| Wrong identity | Trust the issuing CA, but connect using a name absent from the certificate SAN | Hostname verification |

Both checks must reach the intended TLS server. A refused connection, DNS failure, or malformed test fixture is not a successful certificate-rejection test. The hostname case must also trust the chain; otherwise issuer rejection would hide whether name verification ran. Curl's [certificate verification documentation](https://curl.se/docs/sslcerts.html) explains the separate trust and server-name checks.

The completed phase reports 273 unit tests and 86 smoke checks. Those totals describe suite coverage, not 359 independent proofs of CSRF safety. The meaningful evidence is narrower: the header omission fails with origin and session held constant; forged equality fails while the genuine session proof succeeds; logout invalidates a replayed value; and TLS negatives fail for their intended reasons.

The boundary remains explicit. Same-origin script execution can read the transport token and send an authenticated request, so this is not an XSS defence. A CSRF token is also not package authorization or proof of a human click. It binds a request to a secret issued for the authenticated session. The cookie carries that secret for the client; the server decides whether it belongs.
