---
title: "OAuth's Front Channel, Back Channel, and PKCE"
description: "Following an authorization code from browser redirect to token exchange, with the checks that bind it to the right client, browser session, and authorization server."
date: 2026-09-13
order: 2
tags: ["Security", "OAuth", "PKCE", "Cookies", "CORS"]
draft: true
---

Suppose a developer wants a release-management service to publish packages on their behalf. Giving that service the registry password would give it a reusable credential with whatever authority the password carries. OAuth allows the developer to grant narrower access through an authorization server instead.

There are four roles in this example. The developer is the resource owner. The release-management service is the client. The authorization server authenticates the developer and issues credentials. The registry API is the resource server that accepts an access token and decides whether the requested operation is permitted.

Those roles can share infrastructure, but their responsibilities remain different. In particular, a client identifier is not a user identity, and an access token is not automatically evidence that the holder owns every package.

The authorization code flow is easiest to understand by following where its messages travel and what each recipient must verify.

## One flow, two communication paths

The browser carries the authorization request to the authorization server and carries the result back to the client. That is the front channel. The client then calls the token endpoint directly to exchange the code. That is commonly called the back channel.

```text
Client → browser → authorization endpoint
Client ← browser ← callback containing code
Client ──────────→ token endpoint: code + verifier
Client ←────────── token response
```

Both paths normally use HTTPS. The distinction is message delivery, not whether one path is encrypted. Browser navigation exposes values to the user agent and callback handling. A direct token request avoids placing tokens in a navigation URL. The basic exchange is defined in [RFC 6749, section 4.1](https://www.rfc-editor.org/rfc/rfc6749.html#section-4.1).

For a server-side client, the token call originates on the server and the resulting tokens can stay there. A single-page application can also call a token endpoint directly if that endpoint supports the necessary CORS behavior. The protocol still has a separate exchange, but JavaScript and tokens remain in the browser's execution environment. Calling it a back channel does not make that environment equivalent to a backend.

## What a redirect can expose

A callback URL might look like this:

```text
https://client.example/callback?code=<authorization-code>&state=<transaction-id>
```

The browser sees the URL, the callback server receives it, and an access log may record its query. Page scripts and browser extensions can create additional exposure depending on their privileges. The client should therefore avoid third-party content on the callback page, consume the response promptly, and avoid logging sensitive query parameters.

Referrer leakage needs more precision than “every URL is sent to every other site.” It depends on the active referrer policy and destination. URL fragments are excluded from the `Referer` header, and `strict-origin-when-cross-origin` strips the path and query on cross-origin requests. Those rules do not remove all browser-side exposure. See the [Referrer Policy specification](https://www.w3.org/TR/referrer-policy/).

A POST body also is not automatically secret from its endpoints. A token endpoint, reverse proxy, debugger, or application log can expose one. The benefit of the token exchange is a controlled recipient and additional validation, not immunity from logging or a compromised client.

## Why return a code instead of an access token?

An access token is used at the API. If it is a bearer token, someone who possesses it can present it without proving possession of a separate key. This makes accidental disclosure operationally significant. [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750.html) defines bearer-token use and its security requirements.

An authorization code has a more constrained purpose. It is short-lived, single-use, and redeemed at the token endpoint. The authorization server associates it with the client and redirect URI, along with the authorization transaction. Before issuing tokens, the token endpoint can check information that the browser redirect did not carry.

These restrictions reduce exposure but do not make a stolen code harmless on their own. If a public client can redeem a code using only values visible in the redirect, an attacker who obtains the code may redeem it first. PKCE adds the missing proof that the redeemer holds a secret established for that transaction.

For confidential clients, the token endpoint also authenticates the client. That answers which registered client is making the call. It is separate from proving that this particular code belongs to this particular in-progress authorization flow.

## PKCE binds the exchange to a fresh secret

Before navigation, the client generates a cryptographically random verifier and derives a challenge:

```text
verifier  = base64url_without_padding(32 random bytes)
challenge = base64url_without_padding(SHA256(ASCII(verifier)))
```

The hash input is the encoded verifier string, not the original random bytes. Thirty-two random bytes encode to 43 base64url characters, fitting PKCE's verifier grammar. The verifier stays with the client; the authorization request carries the challenge and `code_challenge_method=S256`.

At the token endpoint, the client supplies the code and verifier. The authorization server recomputes the challenge and compares it with the value associated with that code. An interceptor who has only the code and challenge cannot feasibly recover a sufficiently random verifier. The transformation and exchange are specified in [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636.html).

A shortened authorization request has these fields:

```text
response_type=code
client_id=release-client
redirect_uri=https://client.example/callback
code_challenge=<challenge>
code_challenge_method=S256
state=<random-transaction-id>
```

These are shown one per line for readability; the real request encodes them as query parameters. The token exchange uses form encoding and includes `grant_type=authorization_code`, the code, redirect URI when required, and verifier. Confidential clients also use their configured client-authentication method.

Current OAuth security guidance requires PKCE for public clients and recommends it for confidential clients. It also requires the challenge to be specific to the transaction and securely bound to the initiating client and user agent. Reusing one verifier for every login defeats that binding. [RFC 9700, section 2.1.1](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.1.1) is the relevant guidance.

## Store a transaction, not just a verifier

A server-side client needs enough temporary state to recognize the callback:

```text
pending transaction:
  browser session
  state value
  PKCE verifier
  expected authorization server
  redirect URI
  expiry
```

The client stores this before redirecting the browser. On return, it checks that the transaction exists, belongs to this browser session, has not expired, and has the expected `state`. It consumes the transaction so another callback cannot reuse it. Multiple simultaneous login attempts need separate entries; a single global “current verifier” is incorrect even before considering attacks.

This is the application part of the protocol. A library can compute the challenge correctly while the surrounding application attaches the callback to the wrong browser session.

Consider login CSRF: an attacker starts authorization for their own account, then causes another person's browser to visit the resulting callback. If the application accepts that callback without matching an initiating transaction, the victim can end up using the attacker's account and putting data into it. A session-bound `state` value provides correlation. Correctly bound PKCE can also supply CSRF protection under the conditions described in the security guidance; merely including the parameter is insufficient.

## Redirect URIs and issuers are independent checks

The authorization server must deliver the code only to a registered redirect URI under the applicable matching rules. Prefix matching is dangerous: allowing a URL because it starts with a trusted string can admit a different host or path. Native applications have a specific exception for variable ports on loopback redirects; that is not permission for broad wildcard matching.

Native apps also illustrate why a shipped client secret is not confidential. A static secret included in every copy can be extracted. PKCE instead creates a secret for each authorization attempt. Custom URI schemes can be claimed by another app, while claimed HTTPS redirects and loopback redirects have different platform properties. These considerations are covered by [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html).

A client that supports multiple authorization servers needs another binding: which server started this transaction? It must not send a code or verifier to an endpoint chosen from untrusted callback data. Store the expected issuer and use trusted configuration to choose endpoints. Where supported, validate the authorization response's `iss` value against that issuer. [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html) specifies the issuer parameter as a defense against authorization-server mix-up.

PKCE, redirect validation, and issuer validation answer different questions. Passing one check does not make the others redundant.

## PKCE ends at the token exchange

PKCE protects code redemption. It does not stop hostile JavaScript running inside a browser client from using that client's verifier or stealing tokens after the exchange. It also does not protect a bearer access token once that token has been copied elsewhere.

A backend-for-frontend design changes where those credentials live. The server performs the exchange and holds the OAuth tokens; the browser receives a session cookie. An `HttpOnly` cookie reduces direct credential extraction through page JavaScript, but injected script may still issue authorized requests through the application. Cookie-backed actions need CSRF protections as well.

That architecture can reduce token exposure, but it creates a session store and a server that acts on the browser's behalf. The choice depends on what the application can operate and which client-side threats it needs to contain. It is not a property that PKCE alone can provide.

Access tokens should go only to their intended resource servers. Refresh tokens go to the authorization server's token endpoint, not to the registry API. Their longer potential lifetime creates a separate need for expiry, revocation, rotation or sender constraints, and protected storage.

If the application also needs to sign a user in, OpenID Connect adds an ID token with authentication information for the client. That token has its own validation requirements, including issuer, audience, signature, expiry, and a nonce when one was sent. It is not interchangeable with the access token presented to an API. The distinction is defined in [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html#IDToken).

For the registry, the eventual result is a credential that represents delegated authority. The API must still validate it and enforce package-level permissions. A successful OAuth exchange establishes how the client obtained a token; it does not decide whether the next publish request is allowed.
