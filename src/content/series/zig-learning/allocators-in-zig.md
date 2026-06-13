---
title: "Allocators in Zig: Who Owns This Memory?"
description: "Getting familiar with Zig's allocator interface by building a handful of string helpers and a StringBuilder — caller-owns conventions, errdefer, realloc growth, and using std.testing.allocator as a leak detector."
date: 2026-06-13
order: 3
tags: ["Zig", "Allocators", "Memory"]
---
The [first post](/series/zig-learning/io-in-zig) in this series leaned on one idea: in Zig, I/O is a *capability you're handed*, not a global you reach for. `main` receives an `io` and has to pass it to anything that wants to touch the terminal. Memory works exactly the same way. There is no ambient `malloc`. If a function wants to allocate, you hand it an `std.mem.Allocator`, and it can't get heap memory any other way.

I wanted to actually feel that interface rather than read about it, so I wrote a little `strings.zig` — `dup`, `reverse`, `join`, `split`, and a small `StringBuilder` — and tested every one against `std.testing.allocator`, which fails the test if you leak so much as a byte. That last part turned out to be the best teacher in the whole exercise.

## The smallest possible allocation

Here's the simplest function, `dup`, which copies a string onto the heap:

```zig
const Allocator = std.mem.Allocator;

/// Caller owns the returned slice; free it with the same allocator.
pub fn dup(allocator: Allocator, s: []const u8) ![]u8 {
    const out = try allocator.alloc(u8, s.len);
    @memcpy(out, s);
    return out;
}
```

Everything about the allocator interface is already visible here:

- `allocator` is a plain value parameter. It's the only way this function can get memory.
- `allocator.alloc(u8, s.len)` asks for `s.len` items of type `u8`. It returns an *error union* — allocation can fail with `error.OutOfMemory`, so it's `try`.
- The return type is `![]u8`: a slice, or an error.

And then that doc comment, which isn't decoration — it's the contract. **Zig has no garbage collector and no destructors, so ownership is a thing you track by hand and document in words.** "Caller owns the returned slice; free it with the same allocator" tells the caller exactly one thing they're now responsible for. Every allocating function in the file starts with a line like that, because the alternative is leaking.

## The leak detector that grades your homework

This is the part that made allocators click. Here's the test for `dup`:

```zig
test "dup works" {
    const s: []const u8 = "Hello";
    const allocator = std.testing.allocator;
    const out = try dup(allocator, s);
    defer allocator.free(out); // commenting this out fails the test
    try std.testing.expectEqualStrings(s, out);
    try std.testing.expect(s.ptr != out.ptr);
}
```

`std.testing.allocator` is a special allocator that tracks every allocation and, when the test finishes, checks that they were all freed. Delete that `defer allocator.free(out)` line and the test doesn't just pass quietly — it *fails*, with something like `1 tests leaked memory`, and points at the allocation you abandoned.

That changes how it feels to write this code. In C, a forgotten `free` is invisible until a profiler or an out-of-memory crash finds it weeks later. Here it's a red test on the very next run. The `defer` right after the allocation, mirroring the alloc, becomes muscle memory — and the test is what trains the muscle. I genuinely learned ownership by deleting frees and watching things break.

The `s.ptr != out.ptr` assertion is a second small lesson: it proves `dup` actually *copied* rather than handing back a view of the input. Identity matters once memory is manual.

## Measure twice, allocate once

`join` is where a little planning pays off. The naive way to glue parts together with a separator is to keep reallocating as you go. The better way is to compute the final size first and allocate exactly once:

```zig
pub fn join(allocator: Allocator, parts: []const []const u8, sep: []const u8) ![]u8 {
    var length: usize = 0;
    for (parts) |part| length += part.len;
    if (parts.len > 0) length += sep.len * (parts.len - 1);

    const out = try allocator.alloc(u8, length);
    if (parts.len == 0) return out;

    var offset: usize = 0;
    for (parts[0 .. parts.len - 1]) |part| {
        @memcpy(out[offset .. offset + part.len], part);
        offset += part.len;
        @memcpy(out[offset .. offset + sep.len], sep);
        offset += sep.len;
    }
    @memcpy(out[offset..], parts[parts.len - 1]);
    return out;
}
```

One `alloc`, then `@memcpy` the pieces into place by hand. The separator count is `parts.len - 1`, which is exactly the kind of arithmetic that's easy to fumble, so the edge cases get their own tests: an empty list (allocates a zero-length slice and returns it), and a singleton (no separators at all). When memory is manual, the off-by-ones become *allocation* off-by-ones, and a one-byte miscalculation is a buffer overflow rather than a wrong string. Writing the length math out explicitly, separate from the copying, keeps it honest.

## Owned memory vs. a view into someone else's

`split` is the most interesting one, because it returns memory with *mixed* ownership, and the doc comment has to be careful about it:

```zig
/// Caller owns the returned outer slice and must free it with the same
/// allocator. The inner slices are views INTO `s` — do not free them
/// individually, and they are only valid as long as `s` lives.
pub fn split(allocator: Allocator, s: []const u8) ![][]const u8 {
    var list: std.ArrayList([]const u8) = .empty;
    errdefer list.deinit(allocator);
    var start: usize = 0;
    for (s, 0..) |c, i| {
        if (c == ',') {
            try list.append(allocator, s[start..i]);
            start = i + 1;
        }
    }
    try list.append(allocator, s[start..]);
    return list.toOwnedSlice(allocator);
}
```

The return type `[][]const u8` is a slice of slices, and the two levels are owned by different people. The *outer* slice — the array of pieces — is freshly allocated, so the caller frees it. The *inner* slices are `s[start..i]`: windows into the original input, no copying, no allocation. Free one of those and you'd be handing the allocator a pointer it never gave out. So the contract is "free the outer, never the inner, and don't outlive `s`." That's a lot to ask of a caller, but it's also zero-copy and fast, and the comment makes the deal explicit.

Two new tools show up here:

- **`errdefer`**, the partial-failure twin of `defer`. We build the list incrementally, and any `append` can fail with `OutOfMemory` halfway through. `errdefer list.deinit(allocator)` cleans up the list *only if we leave via an error*. On the happy path we don't want it to fire, because —
- **`toOwnedSlice`** hands the list's backing buffer to the caller and leaves the list empty. Ownership transfers out, so the `errdefer` correctly does nothing on success. This is the same handoff pattern that makes the `StringBuilder` below tick.

(Aside: that `std.ArrayList(...) = .empty` with the allocator passed to each method — `append(allocator, …)`, `deinit(allocator)` — is itself recent. Like the I/O rework from the earlier posts, `ArrayList` moved to passing the allocator per-call rather than storing it. Same philosophy: the allocator is a capability you carry to the operation, not state the container hides.)

## Growing a buffer: StringBuilder

The helpers above each allocate once. A builder is the case where you *don't* know the final size up front, so you grow:

```zig
const StringBuilder = struct {
    buf: []u8 = &.{},
    len: usize = 0,

    pub fn append(self: *StringBuilder, allocator: Allocator, bytes: []const u8) !void {
        const needed = self.len + bytes.len;
        if (needed > self.buf.len) {
            const new_cap = @max(needed, 2 * self.buf.len);
            self.buf = try allocator.realloc(self.buf, new_cap);
        }
        @memcpy(self.buf[self.len..needed], bytes);
        self.len = needed;
    }
    // ...
};
```

It starts with `buf = &.{}` — an empty slice, no allocation yet. `append` introduces `realloc`, the third verb after `alloc` and `free`: it resizes an existing allocation, copying the contents to a bigger home if it has to move. The growth rule is the classic one — `@max(needed, 2 * self.buf.len)`. Doubling means that appending N bytes one chunk at a time costs O(N) total copying, not O(N²), because reallocations get geometrically rarer as the buffer grows. There's a `string builder looped` test that appends 100 times and checks the result is `"Hello World"` repeated 50 times, partly to exercise exactly that regrowth path.

## The handoff that looks like a double free

Now the bit I found genuinely satisfying. The builder has two methods that both, on the face of it, want to free `buf`:

```zig
pub fn toOwnedSlice(self: *StringBuilder, allocator: Allocator) ![]u8 {
    const out = try allocator.realloc(self.buf, self.len);
    self.buf = &.{};
    self.len = 0;
    return out;
}

pub fn deinit(self: *StringBuilder, allocator: Allocator) void {
    allocator.free(self.buf);
    self.* = .{};
}
```

And the test uses *both*:

```zig
test "string builder implementation" {
    const allocator = std.testing.allocator;
    var sb: StringBuilder = .{};
    defer sb.deinit(allocator);          // (2) runs last
    try sb.append(allocator, "Hello ");
    try sb.append(allocator, "World");
    const out = try sb.toOwnedSlice(allocator);
    defer allocator.free(out);           // (1) runs first
    try std.testing.expectEqualStrings("Hello World", out);
}
```

At a glance that's a double free: `toOwnedSlice` hands out `out`, we `free(out)`, and then `deinit` also frees. But it's correct, and `std.testing.allocator` confirms it by *not* complaining. The trick is the two lines in the middle of `toOwnedSlice`: after shrinking the buffer to its exact length and returning it, it resets `self.buf = &.{}`. The builder no longer points at that memory. So when `deinit` runs at end of scope, it frees an *empty* slice — a no-op — not the buffer we already handed out.

It's the `toOwnedSlice` pattern from `split` again, made explicit: **transferring ownership means nulling out your own reference so two cleanup paths can coexist without colliding.** Two defers, one buffer, no double free — because in between, ownership moved. Once you see it here, the whole "who frees this" discipline stops feeling like bookkeeping and starts feeling like a property you can actually reason about.

## What stuck

Three things I'll carry forward:

1. **Memory is a capability, like I/O.** No hidden allocator, no hidden `io`. You pass what a function is allowed to do.
2. **Ownership is documented and tracked by hand** — and the doc comment is part of the function. "Caller owns this," "this is a view, don't free it," "this transfers ownership" are the vocabulary.
3. **`std.testing.allocator` makes that discipline learnable.** Leaks become failing tests instead of distant mysteries. Comment out a `free`, watch it go red, put it back. That feedback loop taught me more than any explanation.

