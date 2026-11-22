---
title: "The Fourth Grammar: LDAP Injection and the Limits of Escaping"
description: "Phase 9 of Barbican: typed LDAP escaping, anonymous-bind traps, bounded directory staleness, and a principal whose username outlived its decoding buffer."
date: 2026-10-02
order: 12
tags: ["Security", "LDAP", "Authorization", "Zig", "Memory", "Testing"]
draft: false
---

SQL injection has `prepare` and parameter binding. The LDAP string-filter interface used here has no equivalent: authorization code has to supply an already-encoded expression.

Barbican is a package-registry API in Zig. [The ownership boundary](/series/api-security/authorization-belongs-before-the-handler) gave each package an individual owner; phase 9 adds directory groups as an input to permission decisions. That introduces a fourth grammar after HTTP, SQL, and JSON, with a less forgiving interface. LDAP's operation named *Bind* authenticates a connection; it does not bind values into a search expression.

The directory is also a new authority. It supplies membership, a scheduled job mirrors that membership locally, and authorization uses the mirror. A correct query, a successful bind, a fresh snapshot, and a surviving username are four separate requirements for believing the answer.

## One byte turns membership into presence

A direct-membership search can look like this:

```text
(&(cn=sre)(member=<caller DN>))
```

The application asks whether the search returned an entry. That only establishes membership if the filter still asks the intended question.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/ldap-filter-injection.svg" width="700" height="390" style="min-width: 620px" alt="An unescaped value enters the member clause. A genuine member DN, a bare wildcard, and a clause-injection payload each return the group entry, but only the first result establishes the caller's membership.">
  <img class="plate-dark" src="/images/api-security/ldap-filter-injection-dark.svg" width="700" height="390" style="min-width: 620px" alt="An unescaped value enters the member clause. A genuine member DN, a bare wildcard, and a clause-injection payload each return the group entry, but only the first result establishes the caller's membership.">
  <figcaption>The returned object is the group. A presence test on its member attribute says nothing about the caller.</figcaption>
</figure>

Insert `*` into the slot and the filter becomes `(&(cn=sre)(member=*))`. The member clause now tests whether the attribute exists. A group with members satisfies it regardless of who submitted the request. The fixture returns one entry, exactly as it does for a genuine member.

The longer payload `*)(cn=*` produces:

```text
(&(cn=sre)(member=*)(cn=*))
```

It closes the member clause and introduces another presence test. The `AND` remains intact; its predicates have changed to facts the group already satisfies. Injection does not have to introduce an `OR` or remove an existing condition to weaken a decision.

**The fix is value encoding at construction.** [RFC 4515, section 3](https://www.rfc-editor.org/rfc/rfc4515.html#section-3) requires filter escapes for `*`, `(`, `)`, backslash, and NUL. Escapes encode octets as backslash plus two hexadecimal digits. Consequently `*` becomes `\2a`, and the second payload becomes `\2a\29\28cn=\2a`: one assertion value, with no new clauses. Invalid UTF-8 octets above `0x7f` also require escaping; an encoder accepting arbitrary bytes must account for them.

The builder accepts `FilterValue`, rather than a raw slice. The attribute comes from a closed enum. A small call site shows both decisions:

```zig
var value_buf: [64]u8 = undefined;
var filter_buf: [128]u8 = undefined;
const value = try FilterValue.init(&value_buf, "*");
const filter = try equalityMatch(&filter_buf, .member, value);
// (member=\2a)
```

This makes passing raw bytes or a DN-encoded value to that builder a type error. The encoder still needs correct tests, and code constructing the wrapper must actually run it; naming a struct `FilterValue` cannot prove arbitrary bytes safe. The type preserves the construction decision across normal call sites. Escaping cannot constrain an attacker-chosen attribute or operator, so those choices stay in application code.

## The same byte belongs to two grammars

A distinguished name, or DN, identifies a directory entry: `uid=alice,ou=people,dc=example`. A relative distinguished name, or RDN, is one component, such as `uid=alice`. Put the complete DN into a member filter and it occupies two contexts at once.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/ldap-nested-grammars.svg" width="700" height="390" style="min-width: 620px" alt="A complete DN is nested inside an LDAP filter assertion value. Commas separate DN components but are literal in filter values; a star is literal in a DN but can change a filter. Construct the DN first, then encode the whole DN for its filter position.">
  <img class="plate-dark" src="/images/api-security/ldap-nested-grammars-dark.svg" width="700" height="390" style="min-width: 620px" alt="A complete DN is nested inside an LDAP filter assertion value. Commas separate DN components but are literal in filter values; a star is literal in a DN but can change a filter. Construct the DN first, then encode the whole DN for its filter position.">
  <figcaption>Encoding the inner value establishes the DN. Encoding the completed DN establishes its position in the filter.</figcaption>
</figure>

**The fix is two types:** `DnValue` for an RDN's value, `FilterValue` for a filter's assertion value. A generic `escape(string)` leaves the essential decision unstated. Construction records the position once, and builders require the corresponding type.

For a username containing a comma, the layers are visible:

```text
raw username          smith,john
DN value              smith\,john
completed DN          uid=smith\,john,ou=people,dc=example
filter assertion      uid=smith\5c,john,ou=people,dc=example
```

The filter encoding preserves the DN's backslash through the outer parser. Escaping the entire DN as an RDN value would instead turn its structural commas into data. Applying only DN rules would leave filter operators available.

[RFC 4514, section 2.4](https://www.rfc-editor.org/rfc/rfc4514.html#section-2.4) also makes some escapes positional. A leading space, trailing space, or leading `#` needs encoding; an interior space does not. `john smith` needs no changes, while ` john smith ` becomes `\ john smith\ `. A single space is both first and last and must be escaped once. A loop deciding from the character alone lacks the information required for this policy: it needs the index and the value's length. Escaping every space is legal, but does not reproduce the selective encoding used here.

Both wrappers borrow their output buffers. The type records the grammar, not ownership: an encoded value still cannot outlive the storage holding it.

## A successful bind can authenticate nobody

The directory fixture exposes four different outcomes. These are observed results, including its configured refusal of an empty password with a nonempty DN.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/ldap-bind-outcomes.svg" width="700" height="350" style="min-width: 620px" alt="Observed bind outcomes: real DN and correct password succeed, wrong password fails, real DN and empty password are refused by fixture policy, and empty DN with empty password succeeds anonymously. A success code alone cannot establish a user identity.">
  <img class="plate-dark" src="/images/api-security/ldap-bind-outcomes-dark.svg" width="700" height="350" style="min-width: 620px" alt="Observed bind outcomes: real DN and correct password succeed, wrong password fails, real DN and empty password are refused by fixture policy, and empty DN with empty password succeeds anonymously. A success code alone cannot establish a user identity.">
  <figcaption>Both success paths can complete the operation. Only one supplies evidence of a user's password.</figcaption>
</figure>

An empty DN with an empty password requests an anonymous bind. A nonempty DN with an empty password requests an unauthenticated bind, which can also establish an anonymous authorization state. The supplied name in that second case is not proof of identity. [RFC 4513, sections 5.1.1–5.1.3](https://www.rfc-editor.org/rfc/rfc4513.html#section-5.1.1) defines the distinction and recommends refusing unauthenticated binds by default.

This makes `if (rc == 0) authenticated = true` insufficient. If a username lookup finds no DN and that absence becomes an empty string, the application can accidentally select a successful anonymous operation. It then promotes protocol success into an identity the directory never authenticated.

**The fix runs before the bind call.** A password-authentication path refuses a missing DN or empty password locally. A lookup miss terminates authentication rather than becoming a credential for a different bind mechanism.

```zig
if (dn.len == 0 or password.len == 0)
    return error.InvalidCredentials;
```

The fixture's `unwillingToPerform` result is an additional server policy. Changing that policy must not change whether the application accepts an empty credential. The local guard owns that invariant; a remote refusal does not.

## A leaver can keep yesterday's permission

Authorization reads a local membership mirror to avoid putting a directory round trip on every permission check. That creates revocation lag: removing someone from a group changes the directory immediately, but the API continues to see its last successful snapshot.

“A failed sync must fail closed” leaves the actual policy unresolved. Keeping the old rows allows a removed member to retain access. Emptying the table revokes everyone's group access because another service had a transient failure. Either choice without an age bound obscures the duration or scope of the failure.

**The fix is a declared maximum age.** Keep the last complete snapshot, but refuse permissions derived from it once its age exceeds the window. This accepts bounded stale authority in exchange for availability. It is a security tradeoff with a measurable limit.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/ldap-staleness-window.svg" width="700" height="390" style="min-width: 620px" alt="A successful snapshot at time zero remains usable through 900 seconds despite failed sync attempts at 300, 600, and 900. A member is removed at 450. A successful sync at 600 would reflect the removal; continued failures cause group permissions to be refused after the snapshot reaches the age limit.">
  <img class="plate-dark" src="/images/api-security/ldap-staleness-window-dark.svg" width="700" height="390" style="min-width: 620px" alt="A successful snapshot at time zero remains usable through 900 seconds despite failed sync attempts at 300, 600, and 900. A member is removed at 450. A successful sync at 600 would reflect the removal; continued failures cause group permissions to be refused after the snapshot reaches the age limit.">
  <figcaption>A failed attempt never moves the freshness clock. Revocation arrives with a new snapshot or with expiry of the old one's authority.</figcaption>
</figure>

The configured interval is 300 seconds and the maximum snapshot age is 900 seconds. With healthy runs, removal appears after the next completed sync; the interval alone is not a hard latency guarantee because scheduling, directory visibility, and run duration matter. During failure, the 900-second age limit bounds how long a snapshot can continue granting permission. A multiple of the interval leaves room for missed runs; three intervals are this configuration's choice, not a protocol requirement.

Freshness depends on the last **successful** snapshot. An attempt timestamp is useful operational evidence, but using it for authorization lets repeated failures renew old membership forever. A mirror that has never synced has no authority. A clock earlier than its saved timestamp is also refused rather than interpreted as a negative, automatically acceptable age. Here the boundary is inclusive: age `900` passes; `901` fails.

The rows and the timestamp vouching for them commit in the same transaction. A failure rolls back the replacement. Updating them separately can expose fresh rows dated stale, or stale rows dated fresh; the second combination extends revoked permissions under a false freshness claim. A read that combines membership and freshness must likewise use a coherent database view.

The refusal applies to permissions needing directory membership. It need not erase the snapshot or bring down unrelated public reads. “Not a member” and “too stale to establish membership” remain different internal outcomes even when both prevent the protected operation.

## The principal points into a frame that has returned

The first group permission check exposed a separate authorization failure. A genuine member was refused because the username reaching membership resolution had the right length but blank bytes.

Basic authentication decoded `username:password` into a local array. The returned principal retained a username slice into that array. Password verification worked while the frame existed; the name became a dangling reference when the decoding function returned. Debug execution happened to expose spaces. Release execution had no defined value to rely on.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/ldap-principal-lifetime.svg" width="700" height="460" style="min-width: 620px" alt="A principal's borrowed username points into a returned decoding frame containing username and password. The fix copies only the username into request-owned storage. A deterministic test overwrites the exact decoder buffer after authentication and verifies the retained name remains correct.">
  <img class="plate-dark" src="/images/api-security/ldap-principal-lifetime-dark.svg" width="700" height="460" style="min-width: 620px" alt="A principal's borrowed username points into a returned decoding frame containing username and password. The fix copies only the username into request-owned storage. A deterministic test overwrites the exact decoder buffer after authentication and verifies the retained name remains correct.">
  <figcaption>The surviving identity needs ownership of its name. Keeping the whole decoded credential alive extends the password's lifetime unnecessarily.</figcaption>
</figure>

The bug had survived five phases. Earlier permission checks used an integer account ID; the name reached logs and a listing endpoint, where corrupted text could look cosmetic. Directory authorization was the first decision path that depended on the name's bytes.

**The fix copies the username into request-owned storage.** Moving the entire decode buffer into the request would repair the dangling slice, but it would also retain the plaintext password for the whole request. Only the username needs that lifetime. The temporary credential buffer can cease to be used after verification; ending its lifetime does not, by itself, securely erase its bytes.

The [password-authentication article](/series/api-security/who-are-you) stated this ownership requirement. The implementation still violated it. An explained invariant and a correct parser do not establish that the caller obeys the returned slice's lifetime.

The first regression test also passed with the bug intact. Calling another function to clobber the stack after return merely hopes it reuses the same address. If it does not, dead bytes survive long enough to make a dangling reference look valid.

The useful test supplies a decoding buffer it owns to the authentication helper. After obtaining the principal, it overwrites that exact buffer and checks the retained username:

```text
fill controlled buffer with username:password
authenticate slices borrowed from that buffer
overwrite the same buffer with spaces
assert principal.name still equals username
```

That proves independence from the input storage without relying on stack layout. Delete the username copy and this assertion fails deterministically. A regression becomes evidence when it rejects the defective implementation; merely watching it pass after a change establishes much less.

Escaping is the control available when this interface will not separate a value from an expression for you. It survives by deciding the value's position during construction, carrying that decision in its type, and keeping attributes and operators in a closed vocabulary the caller cannot supply. The directory's answer then earns authority only while its identity evidence, snapshot age, and backing memory remain valid.
