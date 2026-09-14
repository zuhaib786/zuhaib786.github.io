---
title: "Front Channel, Back Channel"
description: "The OAuth2 authorization code grant made no sense to me until I stopped asking what the steps were and started asking which of them the attacker can see. A walk through the trust boundary, built up by breaking it four times."
date: 2026-09-13
order: 2
tags: ["Security", "OAuth", "PKCE", "Cookies", "CORS"]
draft: true
---

I could recite the authorization code grant before I understood it. Client builds an authorization URL with scopes and a redirect URI; user authenticates and consents; the authorization server redirects back with a code; the client exchanges the code for an access token and a refresh token. Fine. I could draw the arrows.

What I couldn't answer was **why**. Why a code and then a token, instead of just a token? Why does the client send its secret on the second call and not the first? What is the attacker in this story actually able to do, such that this specific shape defeats them?

The thing that unlocked it was learning that "front channel" and "back channel" — which I'd skimmed past as spec jargon — are the entire point.

## The founding constraint

Start further back than the flow. OAuth exists to satisfy one requirement:

> **The client must never see the user's credentials.**

If a third-party tool could just collect your registry password and use it, none of this machinery would be needed. That design exists — it's the deprecated `password` grant — and it's deprecated because it hands your password, with unlimited scope and unlimited lifetime, to software you don't control.

So the password must reach the authorization server and nothing else. But the client is the thing you're interacting with. Getting you from the client over to the AS and back, using nothing but ordinary web plumbing, means a **browser redirect**.

That single decision creates every subsequent problem. The browser is now carrying messages between the AS and the client — and the browser is not a trusted party.

## Courier or endpoint

This is the distinction, and it has nothing to do with servers versus JavaScript. I assumed "back channel" meant "a backend." It doesn't.

**Front channel — the browser is a courier.**

```js
window.location = 'https://as.example.com/authorize?client_id=barbican-cli'
                + '&redirect_uri=https://registry.example/cb&code_challenge=xYz&state=abc'
```

You aren't talking to the AS. You're handing the browser a URL and telling it to go there. The data *is* the URL. Which means the message lands in the address bar, in browser history permanently, in the `Referer` header sent to every third-party script on the destination page, in the access log of every server the URL touches, and on mobile, in whatever app claimed that URL scheme. The redirect back is a URL too, so `?code=...` inherits all of it.

**Back channel — the browser is an endpoint.**

```js
fetch('https://as.example.com/token', {
  method: 'POST',
  body: 'grant_type=authorization_code&code=abc123&code_verifier=<secret>'
})
```

That is JavaScript, running in a browser, and it is still a back channel. There's no courier. It's a direct TLS connection to the AS, the secret is in a POST body rather than a URL, and nothing navigated — so no history entry, no `Referer`, no intermediate logs.

```
FRONT:  you ──[ the URL is the message ]──> 🌐 navigates ──> AS
BACK:   you ─────────────── TLS ──────────────────────────> AS
```

Same machine, same language, completely different exposure. The rule I now apply:

> Assume everything that crosses the front channel is **public**.

## Building it by breaking it

With that framing, the grant stops being arbitrary. Here's the design arrived at by attacking each version.

### v0 — send the token in the redirect

This was the implicit grant:

```
https://registry.example/cb#access_token=eyJhbGci...
```

An access token is a *bearer* credential — possession is authorization, no further proof required. We just put one on the public bulletin board. It's in history. Any injected script reads it. It leaks via `Referer`. And the AS has no idea who ended up holding it.

Implicit existed because before CORS was universal, browser apps physically couldn't make the cross-origin POST that the next version requires. That constraint is gone, so implicit is now discouraged and OAuth 2.1 drops it.

### v1 — send a code, exchange it over the back channel

Now the front channel carries a claim ticket rather than the goods, and the token only ever exists on the direct connection.

But a stolen claim ticket still works. The attacker lifts `code` from the URL exactly as they'd have lifted the token, and POSTs it themselves. The problem moved; it didn't go away.

### v2 — require something the front channel never saw

Authenticate at the token endpoint:

```
POST /token
Authorization: Basic <base64(client_id:client_secret)>
grant_type=authorization_code&code=abc123
```

Here's the whole mitigation in one table:

| | crosses the front channel | required to get a token |
|---|---|---|
| `code` | yes | yes |
| `client_secret` | **never** | yes |

An attacker who completely owns the front channel still cannot finish the exchange, because one required input was never there. That's what "the code is useless on its own" means — not that it's encrypted or clever, just that it's insufficient.

Single use and a sixty-second lifetime are layered on top, but they're defence in depth. The structural property is the table.

Except: a CLI tool, a mobile app, or a single-page app has no secret. Anything shipped to a user's device can be extracted — `unzip` the APK, open DevTools, run `strings` on the binary. A secret distributed to a million devices is a published secret, and registering the client as "confidential" doesn't change that, it just means the AS is trusting a factor everyone already has.

### v3 — PKCE, an ephemeral secret per flow

If you can't hold a *persistent* secret, generate a fresh one each time:

```
before starting:  verifier  = 32 random bytes, base64url    ← stays in memory
                  challenge = base64url(SHA-256(verifier))

→ front channel (public):   code_challenge=<challenge>&code_challenge_method=S256
← front channel (public):   code=abc123
→ back  channel (private):  code=abc123 & code_verifier=<verifier>

AS checks: SHA-256(code_verifier) == the challenge I stored at the start?
```

Structurally identical to v2. The public channel sees the challenge and the code; the verifier never goes there, and a hash can't be run backwards to produce it. A stolen code is still unredeemable.

On mobile this isn't hypothetical — a malicious app can register the same custom URL scheme and receive your redirect. PKCE is what makes that theft worthless. And because PKCE also defeats code injection, current guidance is to use it for *every* client, confidential ones included. OAuth 2.1 makes it mandatory.

### v4 — the two remaining holes

**Redirect URI manipulation.** If an attacker can get the AS to deliver the code to `https://evil.example/cb`, they don't need to steal anything. The AS must only redirect to URIs pre-registered for that `client_id`, matched *exactly* — no wildcards, no prefix matching. (Prefix matching is a recurring real-world bug: `localhost:3000` also matches `localhost:3000.evil.example`.)

**CSRF on the redirect.** The attacker starts a flow with *their* account, then tricks your browser into visiting `https://registry.example/cb?code=<their code>`. Your client now holds a token for the attacker's account and writes your data into it. The `state` parameter — random, tied to your session, verified on return — closes it. PKCE covers it too, since their code won't match your verifier.

## Where the honesty is

For a server-side client, the back channel is genuinely strong: the call originates on a machine the user doesn't control, and the secret never enters a browser.

For a single-page app it's weaker, and the spec authors say so plainly. The `code_verifier` lives in JavaScript memory. **XSS in your own origin defeats it** — hostile script can run the same `fetch` or read the token afterwards. PKCE protects the code in transit; it does nothing about code executing inside your page.

| Threat | SPA back channel |
|---|---|
| Code stolen from URL, history, `Referer` | ✅ closed |
| Network attacker, malicious app on the device | ✅ closed |
| Rogue browser extension | ⚠️ partial |
| XSS in your own app | ❌ **open** |

Which is why the current recommendation for browser apps isn't "SPA with PKCE" — it's the **backend-for-frontend** pattern. A small server of yours performs the exchange, holds the tokens, and hands the browser an `HttpOnly` `SameSite` session cookie. Then the browser never touches a token, and XSS is reduced from "steal a portable credential and use it from anywhere, later" to "make requests as the user, right now, from this page." Still bad. Considerably less bad.

## The second boundary, which I nearly missed

There's a trust boundary inside the token pair itself:

```
access token   ──> shown to EVERY resource server you call
refresh token  ──> shown ONLY to the authorization server
```

Different audiences, so different exposure, so different lifetimes. The access token gets passed around widely — hence short-lived and narrowly scoped, so a compromised or simply nosy resource server gains ten minutes of limited access rather than permanent access. The refresh token has exactly one recipient, so it can afford to be long-lived.

I'd assumed the split was about not re-prompting the user. Convenience is a side effect. The design reason is blast radius.

## The one sentence

Everything above collapses into this, and once I had it the rest stopped needing memorisation:

> **The front channel is a public bulletin board; the back channel is a private line. Only ever post a claim ticket on the board, and require something from the private line to redeem it.**

Next: Phase 0 of [barbican](/series/api-security/what-protects-against-what) — an API with no authentication at all, a written threat model, and the satisfaction of deleting a stranger's package with a single anonymous `curl`.
