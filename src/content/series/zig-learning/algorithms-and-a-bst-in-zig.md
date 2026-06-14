---
title: "Sorting, Searching, and a BST in Zig"
description: "Sprint 4's algorithms blitz — binary search with insertion-position behavior, insertion/merge/quick sort generic over a comparator, and a recursive BST with create/destroy nodes — all leaning on the comptime-generics and ownership patterns from earlier sprints."
date: 2026-06-14
order: 6
tags: ["Zig", "Algorithms", "Data Structures"]
---
The plan calls this sprint the "algorithms blitz": binary search, three sorts, a binary search tree, and graphs. The first three are done and tested against the standard library; graphs are the one piece still ahead. This post is a tour of what's built — and the nice thing is how little of it is *new*. The comptime-generics from the [data structures post](/series/zig-learning/data-structures-in-zig) and the ownership rules from the [allocator posts](/series/zig-learning/allocators-in-zig) carry almost the whole thing. The algorithms are mostly a new arrangement of moves I already had.

## Ordering is a parameter you pass in

Every function here is generic over both the element type *and* how to compare two elements. The comparator is just a function you hand in:

```zig
pub fn insertionSort(comptime T: type, items: []T, comptime lessThan: fn (T, T) bool) void { ... }
```

`comptime T: type` mints a specialized version per element type, and `lessThan` decides the order — so the same code sorts `u32`s ascending, or structs by a field, or anything else. In the tests the comparator is defined inline with Zig's anonymous-struct idiom:

```zig
const lessThan = struct {
    fn less(a: u32, b: u32) bool { return a < b; }
}.less;
```

One small thing I noticed comparing my signatures to `std.sort`: the standard library threads a *context* value through, so its comparator is `fn(context, T, T) bool` (you can see the `ctxLessThan` with a `_: void` first parameter in my tests, used to call `std.mem.sort` as the oracle). Mine skip the context and take a bare `fn(T, T) bool`, which is simpler when the comparison needs no extra state. Passing `comptime` lets the comparator inline at the call site, so the abstraction is free.

## Binary search that tells you where it *would* go

The search primitive isn't "is it here" — it's `lowerbound`, the index of the first element not less than the target. That's strictly more useful: it answers membership *and* gives you the insertion position for a value that's absent.

```zig
pub fn lowerbound(comptime T: type, items: []const T, target: T, comptime lessThan: fn (T, T) bool) usize {
    var low: usize = 0;
    var high: usize = items.len;
    while (low < high) {
        const mid = low + @divFloor(high - low, 2);
        if (lessThan(items[mid], target)) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    return low;
}
```

Two details worth flagging. `mid` is computed as `low + (high - low)/2` rather than `(low + high)/2` — the textbook trick to avoid overflow when the indices are large. And the half-open `[low, high)` invariant is what makes the edge cases fall out for free: a target below everything returns `0`, above everything returns `items.len`, which the `lower bound` and `lower bound empty` tests both pin down. `contains` is then a one-liner on top — find the slot, check it's in range and equal on both sides (`!lessThan` in each direction, since equality is "neither is less").

## Three sorts, three memory profiles

The sorts are the clearest illustration of how the allocator threads through algorithm design. Each one makes a different bargain with memory.

**Insertion sort** touches no allocator at all — it shifts in place:

```zig
for (1..items.len) |i| {
    const key = items[i];
    var j = i;
    while (j > 0 and lessThan(key, items[j - 1])) : (j -= 1) {
        items[j] = items[j - 1];
    }
    items[j] = key;
}
```

Pull out each element, slide the bigger ones right, drop it in the gap. O(n²), but in-place and cache-friendly, and the obvious choice for tiny or nearly-sorted inputs.

**Merge sort** is the one that needs the allocator — and so its signature carries one and can fail:

```zig
pub fn mergeSort(comptime T: type, items: []T, allocator: Allocator, comptime lessThan: fn (T, T) bool) !void {
    if (items.len <= 1) return;
    const mid = items.len / 2;
    try mergeSort(T, items[0..mid], allocator, lessThan);
    try mergeSort(T, items[mid..], allocator, lessThan);
    try merge(T, items, mid, allocator, lessThan);
}
```

`merge` allocates a scratch copy, with the `alloc`/`defer free` reflex from the allocator sprint:

```zig
const out = try allocator.alloc(T, items.len);
defer allocator.free(out);
@memcpy(out, items);
// ...merge the two halves of `out` back into `items`
```

The error propagates up the recursion through `try`, so an OOM deep in the tree surfaces cleanly at the top. Merge sort is also *stable*, and that's a one-character decision: when the two front elements are equal, `if (!lessThan(out[j], out[i]))` takes the **left** (earlier) one first, so equal keys keep their original order. The `merge sort stability` test makes this explicit — it sorts records by a key while tracking their original positions and checks the ties come out in insertion order.

**Quick sort** goes back to in-place, no allocator, with a Lomuto partition around the last element:

```zig
fn partition(comptime T: type, items: []T, lessThan: fn (T, T) bool) usize {
    const pivot = items[items.len - 1];
    var i: usize = 0;
    for (0..items.len - 1) |j| {
        if (lessThan(items[j], pivot)) {
            std.mem.swap(T, &items[i], &items[j]);
            i += 1;
        }
    }
    std.mem.swap(T, &items[i], &items[items.len - 1]);
    return i;
}
```

Everything smaller than the pivot gets swapped to the front; the pivot drops into the boundary; recurse on the two sides around it. No scratch buffer, so no allocator and no error — the signature is the simplest of the three.

All three are checked the same honest way: run mine, run `std.mem.sort` on a copy, and `expectEqualSlices` the results across empty, single, sorted, reversed, and random inputs. The standard library is the oracle.

## A BST: recursion, optionals, and per-node ownership

The binary search tree pulls the data-structure muscles back in. Nodes are individually heap-allocated — `create`/`destroy`, exactly as in the LRU cache — and the children are optional pointers, `?*Node`, which is Zig's way of saying "a link that might not be there."

Insertion is written in a functional style: each recursive call *returns* the (possibly new) subtree root, and the parent reattaches it.

```zig
pub fn insert(self: *Self, value: T) !void {
    self.root = try self._insert(value, self.root);
}
fn _insert(self: *Self, value: T, node: ?*Node) !*Node {
    const n = node orelse try self.makeNode(value);   // null slot -> create the node here
    if (self.lessThan(value, n.value)) {
        n.left = try self._insert(value, n.left);
    } else if (self.lessThan(n.value, value)) {
        n.right = try self._insert(value, n.right);
    }
    return n;   // equal -> already present, fall through (duplicates ignored)
}
```

The `orelse try self.makeNode(value)` is where allocation happens — only when the recursion walks off the end into a `null` child. Reassigning `self.root = ...` and `n.left = ...` on the way back up means the tree stitches itself together without any special-casing of the empty tree or the root.

`delete` is the genuinely fiddly one, and it's the classic three cases:

```zig
// leaf or one child: splice the (single) child up in place
if (n.left == null) { const r = n.right; self.deleteNode(n); return r; }
if (n.right == null) { const l = n.left; self.deleteNode(n); return l; }
// two children: copy the in-order successor's value in, then delete it from the right
const succ = minNode(n.right.?);
n.value = succ.value;
n.right = self._delete(succ.value, n.right);
return n;
```

A node with zero or one child is replaced by its child (possibly `null`). A node with two children can't just vanish, so we find the **in-order successor** — the smallest value in the right subtree — copy its value up, and recursively delete *that* node, which by construction has at most one child. The test suite walks every case separately: leaf, one child, two children, deleting the root, and deleting down to empty (plus `delete` of an absent value returning `false`).

Two more touches reuse earlier lessons. `inOrder` collects a sorted slice using the `ArrayList` + `toOwnedSlice` handoff with an `errdefer` guard — the exact ownership-transfer pattern from the allocator posts, so the caller owns the returned slice. And `deinit` is a recursive post-order `destroy`: free both children before the node itself, so you never free a parent while its children still dangle.

One design contrast I liked: the sorts take their comparator at the call site (often `comptime`, so it inlines), but the BST *stores* its comparator as a runtime function pointer — `lessThan: *const fn (T, T) bool` — because the tree needs the same comparison again and again across many later `insert`/`contains`/`delete` calls. Where the ordering lives depends on how long it has to stick around.

## What's left: graphs

That closes out searching, sorting, and the tree. The remaining slice of the sprint is graphs — an adjacency-list representation, BFS and DFS, topological sort and Dijkstra, and a `graph` subcommand that loads edges from a text file and runs one of them. That's where the ring buffer (a BFS queue), the LRU-style node bookkeeping, and the binary-heap-shaped priority logic all get to converge, so it feels like the right capstone for the data-structures-and-algorithms half of the project. More on that once it's built.

The throughline of the whole sprint: the algorithms themselves are short. What makes them *work* in Zig is the stuff from the earlier sprints — generics over type and comparator, knowing which routine needs an allocator and which doesn't, propagating errors through recursion, and owning every node you create. Derive the complexity, reuse the patterns.
