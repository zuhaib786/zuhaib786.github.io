---
title: "Data Structures in Zig: Putting the Allocator to Work"
description: "A ring-buffer queue, a dynamic-array stack, and an LRU cache — built from the allocator vocabulary the last few posts established: alloc/free, realloc growth, create/destroy, owned keys, and std.testing.allocator keeping it honest."
date: 2026-06-13
order: 5
tags: ["Zig", "Allocators", "Data Structures"]
---
The last two posts were about the allocator interface — [ownership and leak-testing](/series/zig-learning/allocators-in-zig), then [arenas](/series/zig-learning/arena-allocators-in-zig). Data structures are where you find out whether any of it stuck. So I built three: a fixed-size queue, a growable stack, and an LRU cache. Each one leans on a different corner of what I'd learned, and `std.testing.allocator` graded all of them — leak a node and the test goes red.

This post is a quick tour of how the skills so far compose into real containers.

## The generic container pattern

All three are generic over their element type, and Zig spells that with a function that *returns a type*:

```zig
pub fn RingBuffer(comptime T: type) type {
    return struct {
        const Self = @This();
        items: []T = &.{},
        // ...
    };
}
```

`RingBuffer(u8)` and `RingBuffer([]const u8)` are two distinct types minted at compile time. `@This()` names the struct we're inside so the methods can take `self: *Self`. This is the same shape as `std.ArrayList(T)` and the `StringBuilder` from before — once you've seen it, every container looks like it.

## A queue: allocate once, wrap with modular arithmetic

A ring buffer is the case where you *don't* grow. You allocate the backing array exactly once and reuse the slots, which makes it the simplest allocator story of the three: one `alloc` in `init`, one `free` in `deinit`, nothing in between.

```zig
pub fn init(allocator: Allocator, capacity: usize) !Self {
    return .{ .items = try allocator.alloc(T, capacity) };
}

pub fn deinit(self: *Self, allocator: Allocator) void {
    allocator.free(self.items);
    self.* = undefined;
}

pub fn eneque(self: *Self, item: T) !void {
    if (self.count == self.items.len) return error.Full;
    const tail = @mod(self.head + self.count, self.items.len);
    self.items[tail] = item;
    self.count += 1;
}

pub fn deque(self: *Self) ?T {
    if (self.count == 0) return null;
    const item = self.items[self.head];
    self.head = @mod(self.head + 1, self.items.len);
    self.count -= 1;
    return item;
}
```

All the cleverness is in `@mod`. The queue tracks a `head` and a `count`; the tail is computed, never stored, as `(head + count) % len`. When indices run off the end of the array they wrap to the front, so the same fixed slab serves an endless stream of enqueues and dequeues. Fullness is `count == len` (returns `error.Full` — the caller's problem, not a silent overwrite), emptiness is `count == 0` (returns `null`). The `wrap around` test enqueues, drains, and enqueues again across the boundary to prove the modular indexing holds. No `realloc`, no per-item bookkeeping — the allocator shows up exactly twice.

## A stack: a dynamic array that grows by doubling

The stack is the opposite — you *don't* know the size up front, so it grows. This is the `StringBuilder` pattern generalized to any `T`: `realloc` with amortized doubling.

```zig
pub fn push(self: *Self, allocator: Allocator, item: T) !void {
    if (self.len == self.items.len) {
        const new_cap = @max(8, self.len * 2);
        self.items = try allocator.realloc(self.items, new_cap);
    }
    self.items[self.len] = item;
    self.len += 1;
}

pub fn pop(self: *Self) ?T {
    if (self.len == 0) return null;
    self.len -= 1;
    return self.items[self.len];
}
```

`push` doubles capacity (with an 8-element floor) only when full, so appending N items costs O(N) total copying rather than O(N²). `pop` never shrinks the buffer — it just moves `len` down and hands back the top, leaving the capacity for reuse. And the handoff method is the *exact* ownership-transfer trick from the `StringBuilder` post:

```zig
pub fn toOwnedSlice(self: *Self, allocator: Allocator) ![]T {
    const out = try allocator.realloc(self.items, self.len);
    self.items = &.{};
    self.len = 0;
    return out;
}
```

`realloc` down to the exact length, return it, then null out `self.items` so the later `deinit` frees an empty slice instead of double-freeing what we just gave away. Same pattern, new container — which is the whole point of learning it once.

## An LRU cache: where the allocator earns its keep

The cache is the hard one, and it's the first place I needed a tool the earlier posts didn't cover: **allocating individual objects**, not slices. It's a `StringHashMap` for O(1) lookup laid over an intrusive doubly linked list that tracks recency — most-recently-used at the head, eviction victim at the tail.

```zig
const Node = struct { key: []const u8, prev: ?*Node, next: ?*Node, value: V };
```

`put` shows the new vocabulary. Where slices use `alloc`/`free`, a single heap object uses `create`/`destroy`:

```zig
pub fn put(self: *Self, key: []const u8, value: V) !void {
    if (self.map.get(key)) |node| {
        node.value = value;
        self.detatch(node);
        self.pushFront(node);   // touch -> becomes most-recently-used
        return;
    }
    if (self.map.count() == self.capacity) self.evict();   // full -> drop the tail
    const node = try self.allocator.create(Node);
    node.key = try strings.dup(self.allocator, key);
    node.value = value;
    node.next = null;
    node.prev = null;
    self.pushFront(node);
    try self.map.put(node.key, node);
}
```

Three ownership decisions, all borrowed straight from earlier posts:

- **`allocator.create(Node)`** carves out one `Node` and returns a `*Node`; its partner is `allocator.destroy(node)`. That's the single-object analogue of `alloc`/`free`.
- **The key is owned, so it's `dup`'d.** Just like the frequency counter, the caller's `key` slice is borrowed — we copy it so the node is self-contained. The map and the node both reference *that same duped slice*, which matters for teardown.
- **The value is *not* owned.** It's stored as-is; the cache never frees it. The doc-comment discipline — "this is owned, this is borrowed" — is what keeps a structure with two storage layers from double-freeing or leaking.

That borrowed-vs-owned split makes `deinit` an ordering puzzle, exactly the kind the freq post warned about:

```zig
pub fn deinit(self: *Self) void {
    self.map.deinit();                  // frees the map's storage, NOT the keys
    while (self.head) |head| {          // walk the list, free each node...
        const next = head.next;
        self.freeNode(head);            // ...which frees the duped key, then destroys the node
        self.head = next;
    }
}
```

The map's keys *are* the nodes' keys (one duped slice, two references). So you tear the map down first — that only releases the map's internal buckets, not the key strings — and then walk the list, where `freeNode` frees the key and `destroy`s the node. Free the keys from the map side instead and the list walk would touch freed memory. One allocation, two referents, a required order: the LRU is the freq post's lesson with sharper teeth.

## The toolbox, after three structures

Nothing here needed a tool the allocator posts didn't already introduce — it was all recombination:

- `alloc` / `free` for the buffers (queue, stack).
- `realloc` with doubling for growth, plus the `toOwnedSlice` null-out-your-pointer handoff (stack).
- `create` / `destroy` for individual nodes — the one genuinely new verb (cache).
- `dup` for owned keys, borrowed values left alone, and a `deinit` order that respects who owns what (cache).
- `std.testing.allocator` underneath all of it, turning every missed `free` or `destroy` into a failing test.

That's the quiet payoff of treating memory as an explicit capability: once you know the five verbs and the ownership rules, a queue, a stack, and an LRU cache are just different arrangements of the same handful of moves. Next I'd like to make these containers iterable and benchmark the stack against `std.ArrayList` to see what the standard library is doing that mine isn't.
