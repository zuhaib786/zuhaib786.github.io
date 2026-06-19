---
title: "Sprint 3: Capacity vs Length, a Derived Tail, and Two Indexes on One Node"
description: "Notes from building a dynamic array, ring buffer, and LRU cache in Zig — amortized growth, why a queue stores count not tail, and the destruction order when a map and a list share ownership of the same node"
date: 2026-06-14
topic: "Learning Zig"
order: 3
draft: false
---
Notes from Sprint 3: a generic dynamic array, a ring-buffer queue, and an LRU cache. Three non-obvious things, all about the gap between what a structure *stores* and what it *exposes*.

## Length and capacity are two different numbers
`List(T)` keeps `len` separate from `items.len`. `items.len` is the *capacity* — how much memory I hold; `len` is how much of it is live. `push` only grows the backing slice when `len == items.len`, and it grows by **doubling** (`@max(8, len * 2)`), which is what makes append amortized O(1): most pushes are a single assignment, and the occasional `realloc` copy is paid down across all the cheap ones. `pop` just does `len -= 1` — it never shrinks the buffer, because the whole point of capacity is to keep that space around for the next push. And `toOwnedSlice` is the [ownership-transfer reflex](/notes/zig-sprint2-allocators) again: `realloc` down to exactly `len`, then `self.items = &.{}` so the list no longer points at the buffer it just handed away.

## A ring buffer stores count, not a tail pointer
The obvious FIFO design keeps `head` and `tail` indexes. I kept `head` and `count` instead, and derive the tail: `(head + count) % capacity`. The reason is the classic ambiguity — with head and tail pointers, `head == tail` means *either* empty *or* completely full, and you need a wasted slot or a flag to tell them apart. Storing `count` makes both checks unambiguous: empty is `count == 0`, full is `count == items.len`, and enqueue/dequeue are pure modular arithmetic with no special cases. The wrap-around test (capacity 3, fill-drain-fill again) is the one that proves the `% capacity` actually wraps and isn't just an array with extra steps.

## Two indexes pointing at one node — who frees the key? (the important one)
The LRU cache is the [borrowed-vs-owned lesson](/notes/zig-sprint2-allocators) under real pressure, because each node is referenced *twice*: once by the `StringHashMap` (keyed by the node's key) and once by the doubly-linked list (for recency order). On `put` I `dup` the key so the cache owns it independent of the caller — but only one of the two indexes can be the owner. I made the **node** own the key, which forces the destruction order in `deinit`:

```zig
self.map.deinit();              // map frees its buckets — it does NOT own the keys
while (self.head) |head| {      // the list walk frees each node's key + the node
    const next = head.next;
    self.freeNode(head);
    self.head = next;
}
```

The map goes first, but notice *why* it's safe: `map.deinit()` only tears down its own bucket array, it never touches the key bytes — those belong to the nodes. So when the list walk runs `freeNode` (free key, then destroy node), nothing is double-freed and nothing dangles. The mirror of this is that **values are not owned at all** — they're borrowed from the caller, so `deinit` and `evict` deliberately leave them alone. Two indexes, one node, exactly one owner per piece of memory: get that assignment right and the cleanup order falls out of it.
