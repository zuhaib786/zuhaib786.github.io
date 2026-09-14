---
title: "API Security: What Each Control Actually Protects Against"
description: "Starting a series on API security by building one in Zig. The first thing I needed was a map — every control I kept reading about, the specific attack it closes, and, more usefully, the attack it does not."
date: 2026-09-13
order: 1
tags: ["Security", "API", "Zig", "OAuth"]
draft: true
---

I've started working through API security properly, and the plan for this series is the same one that worked for [lzdb](/series/lzdb): pick the smallest real thing that exercises the problem, build it from scratch, and write down what surprised me.

The thing I'm building is **barbican** — a small package registry, the kind of service that hosts library versions and lets you publish to them. Written in Zig, standard library wherever it's reasonable. I picked a registry rather than a typical CRUD app because its security problems are unusually varied: humans log in through a browser, but CI robots authenticate with long-lived tokens; publishing is irreversible and affects everyone downstream; downloads are anonymous and are the obvious target for exhaustion. One codebase, several genuinely different threat profiles.

Zig is a deliberate choice too. There's no framework quietly parsing my request body, no ORM quietly parameterising my queries. Every byte crossing a trust boundary is one I have to read, bound, and validate myself. That's slower, and it's the point — you cannot take a control for granted when nothing provides it for you.

## The problem with how this gets taught

The first few days were frustrating in a specific way. Every resource gives you a *list*: use HTTPS, hash your passwords, set `HttpOnly`, configure CORS, validate input, add rate limiting. All true. None of it told me *why each item was on the list*, so the whole thing stayed a pile of unrelated incantations rather than a system.

What eventually fixed it was reframing every control as an answer to a question:

> **What specific attack does this close, and what does it leave open?**

The second half turned out to matter more than the first. A control you think is total is more dangerous than one whose limits you know, because you stop looking past it. `HttpOnly` is the clean example — I'd absorbed it as "stops XSS," which is wrong in a way that would have led me to build the wrong thing. It stops an attacker *exfiltrating* your session token. Script running in your page can still make requests as you. The credential doesn't leave the browser; the damage does.

So before writing any code I built a map. This post is that map.

## The map

I'll expand each row into its own post as I implement it. Read the right-hand column first — it's the one that changed how I think.

| Control | Protects against | Does **not** protect against |
|---|---|---|
| Input validation (allowlist) | Injection, path traversal, malformed input | Logic flaws, authorization bugs |
| Bounded reads | Memory exhaustion, decompression bombs | Distributed volumetric attacks |
| Checked arithmetic | Integer overflow defeating a length check | Errors in the check itself |
| `ReleaseSafe` build | Bounds/overflow bugs becoming exploitable UB | The bug — it turns RCE into a crash |
| `secureZero` | Keys recovered from freed memory or a core dump | Keys while legitimately in use |
| Parameterised queries | SQL injection | Injection anywhere you didn't parameterise |
| Output encoding | XSS | Malicious stored data being *used* elsewhere |
| TLS | Eavesdropping, tampering, server impersonation | Anything after the bytes arrive |
| HSTS | Protocol downgrade, after the first visit | The first visit (needs preloading) |
| Argon2id | Offline cracking of a stolen password table | Phishing, weak passwords, reuse |
| Constant-time compare | Timing side channels | Everything else |
| Identical auth failures | Username enumeration | Credential stuffing |
| CSPRNG tokens | Prediction and forgery | Theft of a real token |
| Hashing tokens at rest | A database leak yielding usable credentials | Theft in transit or at the client |
| Token expiry | A leak being useful indefinitely | Misuse inside the window |
| `HttpOnly` | Token exfiltration via XSS | XSS acting as the user, in the page |
| `Secure` | The cookie being sent over plaintext | Anything, once you're on HTTPS |
| `SameSite` | Most CSRF, as a browser-side default | Older clients, same-site attackers |
| CSRF token | CSRF | XSS — which can simply read the token |
| CORS | **Nothing.** It *relaxes* the same-origin policy | Non-browser clients, entirely |
| Same-origin policy | Cross-origin reads of the user's data | Your server, approached directly |
| Ownership checks | BOLA / IDOR | Compromised legitimate accounts |
| Roles (RBAC) | Privilege escalation | Over-broad role design |
| ABAC | Role explosion; context-dependent rules | Static analysis — rules become un-auditable |
| ReBAC (Zanzibar) | Transitive-access bugs; "who can access this?" | Latency — a graph query per request |
| Scoped tokens | The blast radius of a leaked credential | The leak itself |
| Rate limiting | Brute force, exhaustion, cheap enumeration | Network-layer DDoS |
| Audit logging | Repudiation, undetected compromise | The breach — this is detection, not prevention |
| Signed tokens (JWT) | Forgery and tampering | Theft; and it *costs* you easy revocation |
| `aud` / `iss` claims | A token replayed against a different service | Misuse at the correct audience |
| ID token (OIDC) | Identity confusion — access ≠ authentication | Anything, if you send it to an API |
| DPoP / bound tokens | Token theft and replay; nosy intermediaries | Compromise of the client's key |
| PKCE | Authorization code interception | A fully compromised client |
| `state` | CSRF on the OAuth redirect | Code interception — that's PKCE's job |
| mTLS | Service impersonation, lateral movement | A compromised service's own authority |
| Content addressing | Artifact tampering at rest or in transit | A malicious artifact published legitimately |
| Version immutability | Retroactive tampering; invalidated checksums | The first publish being malicious |
| Fuzzing | Parser bugs — the classic RCE source | Logic and authorization flaws |
| Secret rotation | How long a leaked secret stays useful | The leak |

## Four things that fell out of writing it

**CORS is not a security control.** This one genuinely reoriented me. I had it filed as "the thing that stops other sites calling my API," which is backwards. The protection is the **same-origin policy**, it's enforced by the browser, and it protects *the user*, not my server. CORS is me deliberately punching a hole in it for origins I trust. A permissive CORS policy isn't a missing protection — it's a vulnerability I introduced. And none of it applies to `curl`, or a Zig client, or an attacker's script. If an endpoint is "protected" by CORS, it is not protected.

**Authentication and authorization are not a spectrum.** I'd been treating them as one gradient of "how logged in are you." They answer disjoint questions — *who are you* versus *what may you do* — and the second needs the resource in hand, not just the credential. This is why Broken Object Level Authorization is the top item on the OWASP API list: the code checks you have *a* valid token, then acts on an object ID from the URL without ever asking whether your token's subject has any relationship to that object. Valid token, someone else's package.

**Every control trades something.** Signed tokens buy you a stateless request path and pay for it with revocation — a JWT is valid until it expires, full stop, and everything you bolt on to fix that (denylists, short expiry plus refresh) is you rebuilding the database lookup you were trying to avoid. Argon2id buys resistance to offline cracking and pays with 100ms and 64MB per attempt, which is a gift to an attacker who can trigger it unauthenticated. That's not an argument against either. It's an argument for knowing which bill you signed.

**Defence in depth means independence, not redundancy.** Two controls that fail for the same reason are one control wearing a disguise. `SameSite` plus a CSRF token is genuine depth: one is a browser default I don't control, the other is my own logic. TLS plus HSTS is much less so — HSTS is worthless if TLS is broken.

## How the build is structured

Nineteen phases in five parts, each one opening with a `curl` that exploits the previous phase. Phase 0 is a deliberately unauthenticated API, so the first thing I get to do is delete someone else's package as an anonymous stranger and watch it return `200`. Then transport, then identity, then permissions, then limits, then proof of what happened.

Identity is built out completely — passwords, tokens, cookies, CORS — before authorization begins. Most tutorials interleave them, which hides the interesting failure: people build an identity layer structurally incapable of answering "may *this* principal touch *this* object," and find out far too late.

Two phases exist because of choices specific to this project. One is memory safety, which most API security material skips entirely because it assumes a managed runtime — in Zig, an integer overflow on a `Content-Length` is a memory-corruption bug, so it gets a phase. The other is supply chain security, which a package registry cannot honestly omit: the thing being built *is* a supply chain.

The next post is the one I found hardest and needed most: [front channel and back channel](/series/api-security/front-channel-back-channel) — what the trust boundary in OAuth actually is, why the authorization code grant is shaped the way it is, and why PKCE exists.
