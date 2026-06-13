---
title: "Sprint 2: Ownership, Borrowed Views, and the Arena Escape Hatch"
description: "Notes from learning Zig's allocator interface — the double-free that isn't, why destruction order matters, and how an arena dissolves the whole problem"
date: 2026-06-13
topic: "Learning Zig"
order: 2
draft: false
---
Notes from Sprint 2: string helpers (`dup`/`join`/`split`/`StringBuilder`) and a word-frequency counter, all driven through `std.mem.Allocator`. Three non-obvious things. `std.testing.allocator` graded all of it — it fails the test if you leak a byte, which is what made the subtleties visible.

## Ownership transfer = null out your own pointer
The `StringBuilder` test has both `defer a.free(out)` and `defer sb.deinit(a)` for what looks like the same buffer. Looks like a double free. Isn't. The trick is inside `toOwnedSlice`: after `realloc`-ing the buffer to its exact length and returning it, it does `self.buf = &.{}`. The builder no longer points at that memory, so when `deinit` runs at end of scope it frees an *empty* slice — a no-op. Same pattern in `split` and `topK` via `list.toOwnedSlice(allocator)`, which empties the `ArrayList` so its `errdefer ...deinit()` correctly does nothing on the happy path. General lesson: **transferring ownership means resetting your own reference**, so two cleanup paths can coexist without colliding.

## Borrowed views, and the destruction order they impose
Not everything an allocating function returns is owned. `split` returns `[][]const u8` where the *outer* slice is heap-allocated (caller frees) but the inner slices are windows *into* the input — free one and you hand the allocator a pointer it never gave out. The frequency counter is sharper: the tokenizer yields slices into `text`, the hashmap stores them as keys, so on first insert I `dup` the key — otherwise every key dangles once `text` is gone. Then `topK`'s results *borrow* those map keys (`.word = entry.key_ptr.*`, no copy). So in the test the defers run in a forced order:

```zig
defer freeCounts(u32, a, &map); // runs 2nd: frees the keys
const top = try topK(a, map, 2);
defer a.free(top);              // runs 1st: top borrows the keys
```

Defers are LIFO, so `top` (the borrower) is freed before the keys it points into. **Free borrowers before owners**, or you iterate freed memory. Doc comments carry this contract — "caller owns the outer; inner slices BORROW; don't free, don't outlive."

## The arena dissolves the whole problem (the important one)
All that order-juggling exists only because each thing is freed individually. The `freq` command in `main` doesn't do any of it. Two lines:

```zig
var arena: std.heap.ArenaAllocator = .init(gpa);
defer arena.deinit();
```

Every allocation — the slurped input text, the hashmap, every duped key, the sorted result — comes from `arena.allocator()`, and `arena.deinit()` releases all of it at once. No `freeCounts`, no per-object frees, no ordering puzzle, because there *is* no per-object destruction. The striking part: `countWords` and `topK` are byte-for-byte the same functions the tests drive with `std.testing.allocator` and meticulous ordered frees. The allocator is a *parameter*, so the same code runs leak-free under a tracking allocator (free everything, in order) and under an arena (free nothing, all at once) — the caller picks the strategy.

> Lesson: an arena is the right tool when a bounded phase allocates a pile of things that all become garbage at the same moment (a CLI command, a request, a parse pass). Match the allocator's lifetime to the work's lifetime and the bookkeeping vanishes. The catch: an arena only *grows* — it never reclaims until `deinit` — so it's wrong for a long-running accumulator. Track the lifetime once instead of N objects.
