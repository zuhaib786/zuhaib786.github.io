---
title: "Object Authorization: Ownership Before the Handler"
description: "Phase 8 of Barbican: closing broken object-level authorization with separate credential and permission policies, router-enforced ownership, explicit route declarations, and stable owner identifiers."
date: 2026-09-26
order: 11
tags: ["Security", "Authorization", "BOLA", "Zig", "SQLite", "Testing"]
draft: false
---

A valid credential proves who is making a request. It does not establish a relationship between that person and the package named in the URL.

That distinction is easy to lose in code review. The endpoint has an authentication check, rejects anonymous requests, and works when the package's author tests it. It also works when another authenticated user substitutes somebody else's package name. Nothing in the successful authentication result answers whether that user may modify that package.

Phase 8 of Barbican, the package-registry API in this series, adds that missing relationship check. It also moves enforcement into the router, so individual handlers cannot forget to perform the check they were never assigned.

## The authenticated-stranger failure

The vulnerable path is short:

```text
read package name from request
verify that the caller has a valid credential
modify the selected package
```

The omitted predicate is `caller may perform this action on this object`. [OWASP ranks Broken Object Level Authorization as API1 in its 2023 API Security Top 10](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/). The related term *insecure direct object reference*, or IDOR, can draw attention to the identifier. Making that identifier harder to guess does not authorize its use. Here package names are public anyway.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/bola-missing-relationship.svg" width="700" height="380" style="min-width: 620px" alt="A request selects Ayesha's package and successfully authenticates Rahul. The owner relationship check is missing, so execution jumps directly to modifying the package. A valid credential and a valid object reference do not establish permission between them.">
  <img class="plate-dark" src="/images/api-security/bola-missing-relationship-dark.svg" width="700" height="380" style="min-width: 620px" alt="A request selects Ayesha's package and successfully authenticates Rahul. The owner relationship check is missing, so execution jumps directly to modifying the package. A valid credential and a valid object reference do not establish permission between them.">
  <figcaption>The credential and the object can both be valid. The missing fact is their relationship for the requested action.</figcaption>
</figure>

Three questions must stay distinct. Authentication asks who the caller is. Function-level authorization asks whether that caller may use an operation. Object-level authorization asks whether the operation is permitted on this particular object. A user can legitimately have access to publishing while lacking permission to publish into another person's package.

The completed phase reports these outcomes:

| Request | Result | Reason |
|---|---:|---|
| Rahul publishes into Ayesha's existing package | `403` | Valid identity, no ownership permission |
| Rahul yanks a version of Ayesha's package | `403` | Same missing relationship |
| Anonymous caller attempts a yank | `401` | Required authentication is absent |
| Authenticated caller targets a nonexistent package | `404` | No package to resolve |
| Anonymous caller reads an existing public package | `200` | Reading remains public |

These are not interchangeable failures. Re-authenticating Rahul does not make him Ayesha, and retrying a nonexistent package with a stronger credential does not create it. The missing-package result applies after the request has satisfied its access requirements; it does not imply that an anonymous mutation bypasses authentication to test existence.

## Separate credential evidence from object permission

An `owner` variant added to an existing access enum looks economical:

```text
public | authenticated | password | owner
```

It puts two independent dimensions on one axis. `password` describes evidence supplied by the caller; `owner` describes a relationship to an object. A single enum cannot express “password proof **and** ownership” without adding combination variants and teaching every consumer what they mean.

The implemented route model keeps them separate:

| Policy | Question | Values |
|---|---|---|
| `access` | What credential evidence is required? | `public`, `authenticated`, `password` |
| `permission` | What relationship to the target is required? | `none`, `package: Action` |

The shape in Zig is small. `Action` below represents the package-operation enum; the example omits unrelated route fields:

```zig
const Access = enum { public, authenticated, password };

const Permission = union(enum) {
    none,
    package: Action,
};

const RoutePolicy = struct {
    access: Access,
    permission: Permission,
};
```

There is no default on `permission`. A public read declares `.none`; an ownership-protected mutation declares a package action. Password proof and package permission can now coexist without inventing a new authentication level.

For Barbican's opaque credentials, authentication resolves an account and the mechanism used to prove it. Package ownership comes from application state, not from the credential's mere validity. In a larger system the relationship might be membership, delegation, or a role assignment; the decision would still concern a principal, action, and object rather than a generic “authenticated” bit.

The separation also prevents unrelated code from having to interpret ownership. An access-level switch used by the CORS policy had acquired an owner case under the combined model. That was a symptom of the wrong abstraction: preflight sharing policy cannot resolve package ownership from a browser negotiation that carries no authenticated session. Credential requirements and resource permissions need not travel through the same switches.

## Enforce the declaration before dispatch

Authorization bugs can contain incorrect predicates, but the failure addressed here is omission. A handler with no ownership check still compiles, serves valid requests, and can pass a happy-path test suite. Successful execution is the symptom, not an error that automatically produces a log entry.

Putting an ownership check into every handler fixes today's handlers. It also assigns every future handler author the same security-critical chore. A new mutation route can silently omit it.

Barbican instead resolves the package permission in the router before dispatch. Route authors declare the required action; the shared enforcement path decides whether the authenticated principal may perform it on the selected package. A refusal prevents the handler from running.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/api-security/ownership-before-dispatch.svg" width="700" height="440" style="min-width: 620px" alt="Two enforcement designs. With checks inside handlers, three routes each need a check and one can omit it. With router enforcement, all three routes pass through one required permission gate before reaching their handlers. Route declarations still determine which permission the gate checks.">
  <img class="plate-dark" src="/images/api-security/ownership-before-dispatch-dark.svg" width="700" height="440" style="min-width: 620px" alt="Two enforcement designs. With checks inside handlers, three routes each need a check and one can omit it. With router enforcement, all three routes pass through one required permission gate before reaching their handlers. Route declarations still determine which permission the gate checks.">
  <figcaption>Centralization removes per-handler omission. Explicit declarations and route-table tests address the remaining risk of declaring the wrong policy.</figcaption>
</figure>

The important sequence is:

```text
match route and parameters
establish required credential evidence
resolve permission for the selected package and action
dispatch only after acceptance
```

The existing session/CSRF gate remains part of request admission. Ownership does not replace it: a forged request can act through an account that really does own the package. Conversely, a genuine CSRF proof establishes nothing about ownership. [Phase 6's request proof](/series/api-security/csrf-proof-belongs-to-the-session) and this phase's object permission answer different questions.

Central enforcement also needs a consistent target. Checking the package selected by `{name}` is insufficient if the handler later mutates a different object selected from the body. The checked action and resolved object must correspond to the eventual mutation. Sharing the enforcement location removes duplication; it does not make an incorrect resource mapping safe.

## Make three different omissions fail visibly

The route model has three safeguards, each operating at a different stage.

First, **the permission field has no default**. Introducing it made all twelve existing route declarations fail to compile until each supplied a value. `.none` remains available, but it must be an explicit decision rather than the value obtained by not thinking about permission.

Second, **startup validates the route shape**. A package permission needs the `{name}` parameter that identifies its target. Declaring that permission on a path without `{name}` prevents startup instead of producing a broken permission lookup on the first live request.

Third, **a test sweeps the route table**. Every route that mutates a named package must declare ownership permission. The test inspects the table rather than naming only today's routes, so a future route is examined without someone remembering to add another individual assertion.

```text
permission field omitted                 → compile failure
package permission without {name}        → startup refusal
named-package mutation declares .none    → route-table test failure
```

These guarantees should not be overstated. The compiler proves that a declaration exists, not that its value is correct. Startup proves that the required parameter is available, not that the owner predicate is sound. The sweep proves its classification rule across the route table; that rule must evolve if new mutation shapes or object types are introduced.

Together they make a forgotten permission harder to hide. Runtime enforcement, configuration validation, and tests have separate jobs. This follows the broader [OWASP guidance to deny by default and validate permission on every request](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html#deny-by-default), without pretending that one language feature establishes the whole authorization policy.

## Why a foreign package is 403 but a foreign token is 404

The relevant question is whether an authorized channel already exposes the object's existence.

Package names and metadata are public. Rahul can read Ayesha's package without logging in. Returning `404` when he attempts to modify it would not conceal its existence; the read API has already disclosed it. `403` explains the actual failure: the package exists, but Rahul may not perform this operation.

Tokens are different. A caller cannot legitimately list another account's credentials. Token lookup and revocation therefore stay scoped to the authenticated owner, and a foreign handle is indistinguishable in status from a handle never issued. The `404` avoids adding an existence signal to a private resource API.

HTTP permits a server to conceal a forbidden resource with `404`; it does not require every denied operation to use that response. [RFC 9110 describes that choice](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.4). Barbican chooses according to the disclosure policy of the resource. A matching status alone is not a guarantee against every timing or response-detail side channel, but the public/private distinction explains these apparently opposite results.

## One idempotent edit, one permission declaration

Yanking is not deleting the release. It changes whether the release is marked as yanked; restoring it changes the same field in the other direction. The phase uses one `PUT` operation that sets the desired state rather than separate mutation routes with independently maintained ownership declarations.

The distinction is between setting and toggling:

```text
set yanked = true twice    → still yanked
toggle yanked twice        → back to the original state
```

Idempotence concerns the intended effect of repeating an identical request, not whether every response byte or log entry is identical. That is the [HTTP definition of idempotence](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2). Using `PUT` is appropriate for setting the yank-state resource; it is not a claim that `DELETE` is non-idempotent.

The shared route declares the more privileged of the two actions it can perform. The router decides permission before the handler parses the body, so it cannot safely choose a weaker requirement based on a field it has not inspected. The conservative declaration covers either requested state.

That is a deliberate tradeoff: someone entitled only to the less privileged direction would still be refused. If future roles need that distinction, the design must resolve and authorize the requested action before mutation, or expose separate operations whose declarations cannot diverge unnoticed. A body-dependent decision is possible, but not before the relevant body value has been read and validated.

## Store the owner's identity, not a spelling of their name

The owner reference is an integer account identifier. A username is a poor relationship key not only because it may change, but because text equality can differ between the foreign-key constraint and an ordinary query.

SQLite enforces a text foreign key using the **parent column's collation**. A child column's own collation can still govern a later comparison. The rules are documented separately for [foreign keys](https://www.sqlite.org/foreignkeys.html#fk_basics) and [ordinary comparisons](https://www.sqlite.org/datatype3.html#collation).

This minimal example reproduces the mismatch with foreign keys enabled:

```sql
PRAGMA foreign_keys = ON;
CREATE TABLE users (
  username TEXT COLLATE NOCASE PRIMARY KEY
);
CREATE TABLE packages (
  owner TEXT COLLATE BINARY NOT NULL REFERENCES users(username)
);
INSERT INTO users VALUES ('alice');
INSERT INTO packages VALUES ('ALICE'); -- accepted
```

The relationship exists according to the constraint, but these joins differ:

```sql
SELECT count(*) FROM packages p JOIN users u
  ON p.owner = u.username; -- 0: child-side BINARY comparison

SELECT count(*) FROM packages p JOIN users u
  ON u.username = p.owner; -- 1: parent-side NOCASE comparison
```

It is not true that every join fails: operand order and explicit `COLLATE` clauses matter. That dependence is precisely the problem. A permitted row can disappear from an ownership query because the query and the foreign key disagree about equality.

An integer owner key avoids that username-collation mismatch and keeps display-name changes out of ownership. The foreign key ensures the referenced account exists; the authorization check still has to establish that this account is the authenticated caller. Referential integrity is not permission enforcement.

## A permanent owner is an operational commitment

This phase has one permanent owner per package. That makes today's relationship straightforward, but leaves a recovery problem: if the owner loses account access and no recovery or transfer process exists, nobody can maintain the package through the normal API.

A transfer column or administrator role would only provide a mechanism. It would not decide who is entitled to recover or take over a package. That requires evidence, process, and an audit trail. For a concrete example, [PyPI's name-retention policy](https://peps.python.org/pep-0541/) defines conditions for handling abandoned projects and transfer requests. A registry needs policy as well as schema.

Ownership transfer would also change the consistency requirements of checking before acting. If ownership can change between router resolution and mutation, the operation needs suitable transactional or conditional enforcement. Centralizing the check does not by itself close a future check/use race.

## Test the relationship, not just successful authentication

The completed phase reports 333 unit tests and 93 smoke checks. The useful evidence is not the totals alone: authenticated strangers are refused, anonymous mutations fail authentication, missing packages are distinct, and public reads stay public.

An ownership regression also needs a positive control. The same operation and object should succeed for the permitted owner, while the denied attempt should leave stored state unchanged. Otherwise a universally broken endpoint or a mutation performed before a late error could look like successful enforcement. Those assertions complement the declaration sweep; neither substitutes for the other.

The boundary is now explicit: a credential establishes the caller, a route declares the action, and the router verifies the caller's relationship to the selected package before handing control to the handler. New handlers no longer carry an undocumented obligation to remember ownership. New routes still carry a visible policy decision—and three different mechanisms make omissions observable.
