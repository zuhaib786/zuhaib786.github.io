---
title: "Arena Allocators in Zig: When Everything Dies Together"
description: "A word-frequency command for lzig that allocates a hashmap, duped keys, the input text, and a sorted result — then frees all of it with a single arena deinit. The same code runs leak-free under a tracking allocator in tests and an arena in main, because the allocator is a parameter."
date: 2026-06-13
order: 4
tags: ["Zig", "Allocators", "Memory"]
---
The [last post](/series/zig-learning/allocators-in-zig) was all about manual ownership: every `alloc` matched by a `free`, every owned slice tracked by hand. This one takes the allocator somewhere with *real lifetimes* — an arena, where you free everything at once instead of tracking each piece. The vehicle is a new `lzig` command, `freq`, which reads text and prints the most common words:

```
$ echo "a b a c a b" | lzig freq 2
a: 3
b: 2
```

That sounds small, but counting words allocates a *lot* of little things, all with the same lifetime: a hashmap, a separately-owned copy of every distinct word, the entire input text, and a sorted result array. Tracking each of those by hand is exactly the bookkeeping the last post was about — and it's exactly what an arena lets you stop doing.

## The job, and everything it allocates

Here's the whole command handler. Read it for the *allocations*, not the logic:

```zig
pub fn handle_freq(args: *std.process.Args.Iterator, out: *std.Io.Writer, in: *std.Io.Reader, io: std.Io, gpa: std.mem.Allocator) !bool {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    const allocator = arena.allocator();

    const text = try in.allocRemaining(allocator, .unlimited);
    const k_str = args.next() orelse "10";
    const k = try std.fmt.parseInt(usize, k_str, 10);
    const word_map = try freq.countWords(allocator, text);
    const top_k = try freq.topK(allocator, word_map, k);

    for (top_k) |word_count| {
        try out.print("{s}: {d}\n", .{ word_count.word, word_count.count });
    }
    return true;
}
```

Count the things that touch the heap: `allocRemaining` slurps all of stdin into an allocated buffer; `countWords` builds a hashmap and dupes a key for every distinct word; `topK` allocates an array of results. Four functions, many allocations, no `free` anywhere. And yet this leaks nothing. The whole memory-management story is two lines at the top:

```zig
var arena: std.heap.ArenaAllocator = .init(gpa);
defer arena.deinit();
```

## What an arena actually is

An arena allocator is a wrapper around another allocator — here `gpa`, the general-purpose allocator `main` receives in `std.process.Init` (memory is a capability, same as `io`). The arena grabs big blocks from `gpa` and hands out little slices of them. Crucially, it **does not free anything individually**. `arena.allocator().free(x)` is essentially a no-op. Instead, every byte the arena ever handed out is released in one shot when you call `arena.deinit()`.

So the model flips. Instead of "every allocation needs a matching free," it's "every allocation shares one lifetime, and that lifetime ends here." The `defer arena.deinit()` is the *only* cleanup, and it covers the text buffer, the map, all the duped keys, and the result array together. They were all born during this command and they all die when it returns. That's the precondition for an arena: **a batch of allocations with a single shared lifetime.** A CLI invocation is the textbook case.

## The bookkeeping the arena is saving us from

To see what we're being spared, look at `countWords`, which has a genuinely tricky ownership problem:

```zig
pub fn countWords(allocator: Allocator, text: []const u8) !Map(u32) {
    var word_map = Map(u32).init(allocator);
    var tokens = std.mem.tokenizeAny(u8, text, " \r\t\n");
    while (tokens.next()) |token| {
        const gop = try word_map.getOrPut(token);
        if (!gop.found_existing) {
            // New key: the map only stored our (borrowed) `token` slice, which
            // points into `text`. Replace it with an owned copy so the map is
            // self-contained and safe to keep after `text` is gone.
            gop.key_ptr.* = try strings.dup(allocator, token);
            gop.value_ptr.* = 0;
        }
        gop.value_ptr.* += 1;
    }
    return word_map;
}
```

The subtlety: the tokenizer yields slices that *point into* `text`. When `getOrPut` inserts a new entry, the map stores that borrowed slice as the key. If `text` later goes away, every key in the map dangles. So on first insert we `dup` the token and overwrite the key with an owned copy. Now the map owns its keys — which means *someone has to free them*. That's a second function:

```zig
pub fn freeCounts(comptime T: type, allocator: Allocator, map: *Map(T)) void {
    var it = map.keyIterator();
    while (it.next()) |key_ptr| allocator.free(key_ptr.*);
    map.deinit();
}
```

Free every key, *then* deinit the map. Get the order wrong and you iterate freed memory. This is correct, but it's the kind of careful, ordered teardown that gets heavier with every new owned thing.

## Two strategies, one set of functions

Here's the part I find genuinely elegant. `freq.zig`'s own tests do *not* use an arena. They use `std.testing.allocator` — the leak detector from last post — and free everything meticulously by hand:

```zig
test "topK returns the k most frequent" {
    const a = std.testing.allocator;
    var map = try countWords(a, "a b a c a b");
    defer freeCounts(u32, a, &map);   // runs second
    const top = try topK(a, map, 2);
    defer a.free(top);                // runs first
    try std.testing.expectEqual(@as(usize, 2), top.len);
    try std.testing.expectEqualStrings("a", top[0].word);
}
```

Two defers, in deliberate order. `topK` returns `WordCount` structs whose `.word` fields *borrow* the map's keys — so the result must be freed *before* the keys it points into. Defers run last-in-first-out, so `a.free(top)` fires before `freeCounts`. Borrowers before owners. The test passes the leak check precisely because this dance is correct.

Now compare that to `main`, which drives the *exact same* `countWords` and `topK` — and frees none of it, calls no `freeCounts`, worries about no ordering. It just lets `arena.deinit()` drop everything.

That's the payoff of the allocator-as-parameter design that's run through this whole series. `freq.zig` never mentions arenas or testing allocators; it takes an `Allocator` and trusts the caller to decide what that means. The tests hand it a leak-tracking allocator and pay for that with careful, ordered frees — which is what *makes* them a useful leak test. `main` hands it an arena and pays nothing. **Same code, two memory strategies, chosen entirely by what you pass in.** Under the arena the destruction-order puzzle simply evaporates, because there is no per-object destruction — there's one `deinit` and no order to get wrong.

## The trade-off

An arena isn't free lunch; it's a *different* lunch. Because it never reclaims individual allocations, its memory only grows until `deinit`. If `freq` ran in a loop over a million files without resetting, the arena would hold every file's allocations at once. For a single short-lived command that's exactly what you want — peak usage is one input's worth, and teardown is a single cheap operation instead of thousands of `free`s. For a long-running accumulator it's the wrong tool, and you'd reach back for per-object freeing or reset the arena between iterations.

So the rule of thumb I'm taking away: **reach for an arena when a clearly-bounded phase of work allocates a pile of things that all become garbage at the same moment.** A request handler, a CLI command, a parse pass, a single frame. Match the allocator's lifetime to the work's lifetime and the bookkeeping disappears.

(One smaller thing worth noting: `in.allocRemaining(allocator, .unlimited)` reads *all* of stdin into one buffer, unlike the chunked `readSliceShort` loop from [part 2](/series/zig-learning/io-in-zig-part-2). The word counter needs the whole text to tokenize it anyway, and the arena makes "allocate a big buffer and stop thinking about it" genuinely cheap — it'll be reclaimed with everything else.)

## What stuck

The arena reframed how I think about `free`. The earlier posts trained the reflex of matching every `alloc` with a `free`; the arena says that reflex is sometimes solving a problem you don't have. When a group of allocations shares a lifetime, you don't need to track them one by one — you need to track the *lifetime*, once. The allocator interface is what makes both styles possible without rewriting a line of the code that does the actual work: `countWords` and `topK` are completely indifferent to which world they're running in.

Next I'd like to point `lzig` at a genuinely large input and actually measure this — arena versus per-object freeing — and finally dig into what `gpa` is doing underneath as the arena's backing store.
