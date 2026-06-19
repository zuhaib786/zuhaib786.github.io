---
title: "Sprint 4: Comptime vs Stored Comparators, Ties Go Left, and Recursion That Returns the Root"
description: "Notes from the algorithms sprint in Zig — why sorts take a comptime comparator but the BST stores a pointer, the one asymmetry that makes merge sort stable, and the reassign-what-recursion-returns idiom that edits a tree without parent pointers"
date: 2026-06-15
topic: "Learning Zig"
order: 4
draft: false
---
Notes from Sprint 4: binary search, three sorts, a BST (plus a heap, graphs, and a treap that got their own [long post](/series/zig-learning/graphs-heaps-and-a-treap-in-zig)). Three things that weren't obvious until I'd written them wrong once.

## Where the comparator lives says how long it lives
The sorts take `comptime lessThan: fn (T, T) bool`; the BST and heap store `lessThan: *const fn (T, T) bool` as a struct field. That split isn't arbitrary. A sort runs the comparator and is done, so passing it `comptime` lets Zig monomorphize and **inline** it — zero call overhead, exactly how `std.sort` does it. A BST *outlives* any single call: it has to compare on every future insert and lookup, so the comparator has to be stored, which means a runtime function pointer in the struct. Rule of thumb I took away: comptime comparator when it's consumed within the call (fast, baked per instantiation); stored pointer when the structure must remember how to order itself later (flexible, one byte of indirection). And only `lessThan` is ever needed — equality is derived as `!less(a,b) and !less(b,a)`, which is exactly what `contains` uses in both the BST and the binary search.

## One flipped comparison is the whole difference between stable and unstable
Merge sort's tie-breaking lives in a single line:

```zig
if (!lessThan(out[j], out[i])) {   // take LEFT when left is not greater
    items[k] = out[i]; i += 1;
} else {
    items[k] = out[j]; j += 1;
}
```

The natural-looking version is `if (lessThan(out[i], out[j])) take left`. With *that*, equal elements pull from the right half first and stable order is lost. Phrasing it as `!lessThan(out[j], out[i])` — "take the left element unless the right one is strictly smaller" — means **ties go to the left half**, which is the one whose elements came first. Stability is that and nothing else. I only believed it after the test with `{key:1, key:1, key:2, key:1}` carrying original-position tags came back in input order. Same single comparator, one negation, two different algorithms.

## Recursion returns the new subtree root (the important one)
The cleanest idiom in the BST is that every structural edit returns the (possibly new) root of the subtree, and the caller reassigns it:

```zig
self.root = try self._insert(value, self.root);
self.root = self._delete(value, self.root);
```

There are no parent pointers anywhere in the node. Instead, `_insert`/`_delete` return what that position *should now point to*, and each frame wires it back in with `n.left = self._delete(value, n.left)`. That one move handles every shape change without bookkeeping: deleting a leaf returns `null`, deleting a one-child node returns the surviving child, and the awkward two-children case copies the in-order successor's value into the node and then deletes the successor from the right subtree — which is guaranteed to have at most one child, so it collapses to an easy case. The recursion threads the edit up the path on the way back out, and "rebuild the link from the return value" replaces every parent-pointer fixup you'd otherwise write. Same pattern carried straight into the [treap](/series/zig-learning/graphs-heaps-and-a-treap-in-zig), just with a rotation spliced in before the return.
