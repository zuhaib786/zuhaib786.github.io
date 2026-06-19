---
title: "Walking, Hashing, and a Binary Format: Talking to the System"
description: "Sprint 5 — a recursive directory walker that survives symlinks and permission errors, a streaming SHA-256 checksum, and a tiny length-prefixed binary file format with a magic header, version, and the errdefer choreography that keeps a half-read file from leaking."
date: 2026-06-19
order: 8
tags: ["Zig", "Systems", "I/O", "Binary"]
---
The [last post](/series/zig-learning/graphs-heaps-and-a-treap-in-zig) closed out the algorithms sprint and ended with the observation that the late, "hard" work was mostly *assembly* of earlier primitives. Sprint 5 turns outward — away from in-memory structures and toward the operating system. Three deliverables: a `walk` subcommand that recurses a directory tree, a `sum` subcommand that checksums a stream, and a tiny binary file format with a magic header and a version. The connective theme is that the filesystem is a place where things go wrong — paths vanish, symlinks loop, permissions bite — and Zig's `io` capability plus its error unions make handling that the default path, not an afterthought.

## Walking a directory tree

The walker is the most "systems" of the three, and the shape is plain recursion: list a directory, print what's there, and descend into each subdirectory. What makes it interesting in Zig is that *every* filesystem touch goes through the `io` capability — the same one from the [I/O posts](/series/zig-learning/io-in-zig). There are no ambient file handles; iterating a directory, opening a child, closing it — all of it is handed `io`:

```zig
pub fn walk(allocator: Allocator, io: std.Io, dir: std.Io.Dir, prefix: []const u8, out: *std.Io.Writer, err: *std.Io.Writer) !void {
    var it = dir.iterate();
    while (try it.next(io)) |entry| {
        switch (entry.kind) {
            .directory => {
                const child_path = try std.fs.path.join(allocator, &.{ prefix, entry.name });
                defer allocator.free(child_path);
                try out.print("{s}/\n", .{child_path});
                var child = dir.openDir(io, entry.name, .{ .iterate = true }) catch |e| switch (e) {
                    error.AccessDenied => {
                        try err.print("{s}: Permission Denied\n", .{child_path});
                        continue;
                    },
                    else => return e,
                };
                defer child.close(io);
                try walk(allocator, io, child, child_path, out, err);
            },
            .sym_link => try out.print("Sym link: {s}/{s}\n", .{ prefix, entry.name }),
            .file => try out.print("{s}/{s}\n", .{ prefix, entry.name }),
            else => {},
        }
    }
}
```

A few things earn their place here.

The `switch (entry.kind)` is the whole reason this isn't a one-liner. A directory entry isn't just "a file" — it's a file, *or* a directory, *or* a symlink, or a handful of stranger things (sockets, FIFOs, block devices) that the `else => {}` quietly skips. Treating a symlink as a directory and descending into it is how a naive walker walks forever the moment a link points back at its own parent. So the symlink case here deliberately *prints and stops* — it never follows. That's the cycle-safety decision made by refusing to recurse, the filesystem cousin of the visited-set in [BFS](/series/zig-learning/graphs-heaps-and-a-treap-in-zig).

The `error.AccessDenied` branch is the other half of robustness. A real tree has directories you're not allowed to read, and the wrong behavior is to abort the entire walk because one subdirectory said no. So `openDir` is wrapped in a `catch` that switches on the error: permission denied gets a line on **stderr** and a `continue` to the next sibling; anything else propagates up through the `!void`. One unreadable directory costs you one directory, not the whole traversal — and the error goes to stderr while the listing goes to stdout, so piping the output to a file still gives you a clean tree with the complaints kept separate.

And the small ownership note: `std.fs.path.join` *allocates* the joined path, so it's paired with `defer allocator.free(child_path)` right below it — the [ownership reflex](/series/zig-learning/allocators-in-zig) from Sprint 2, except notice the recursion passes `child_path` *down* as the next `prefix` while still freeing it on the way out. That works because the child's recursion finishes — and builds its own joined paths from the borrowed prefix — before this frame's `defer` runs. Each level owns its own path string for exactly as long as its subtree is being walked.

## sum: hashing is just the streaming loop again

The checksum utility is where Sprint 5 quietly reuses Sprint 1. A cryptographic hash is computed *incrementally* — you feed it chunks and it folds each one into its running state — which is exactly the streaming read loop from [`count`](/series/zig-learning/io-in-zig-part-2), with `hasher.update` where the word-counter used to be:

```zig
pub fn hashReaders(reader: *std.Io.Reader) ![Sha256.digest_length]u8 {
    var hasher = Sha256.init(.{});
    var buf: [4096]u8 = undefined;
    while (true) {
        const n = try reader.readSliceShort(&buf);
        if (n == 0) break;
        hasher.update(buf[0..n]);
    }
    var digest: [Sha256.digest_length]u8 = undefined;
    hasher.final(&digest);
    return digest;
}
```

The same three beats as the counter: `readSliceShort` fills as much as it can right now, `n == 0` is end-of-input, and `buf[0..n]` feeds only the bytes that actually arrived — never the stale tail. The point is that the function takes a `*std.Io.Reader`, so it hashes a file, stdin, or a pipe without caring which, and it never holds more than 4 KB in memory regardless of input size. A 4 GB file and a 3-byte string go through the identical code path.

Two details worth pinning down. `Sha256.digest_length` (32 bytes) is a compile-time constant on the type, so the return type is a fixed-size array `[32]u8`, not a heap allocation — the digest is small and known, so it lives on the stack and there's nothing to free. And the hash is built in two stages on purpose: `update` many times, then `final` *once* to settle the padding and produce the digest. Call `final` and the hasher is spent.

The tests are the giveaway that this is real SHA-256 and not "some bytes that look hashy" — they pin the output against the published test vectors:

```zig
test "test hash empty" {
    var reader = std.Io.Reader.fixed("");
    const bytes = try hashReaders(&reader);
    try std.testing.expectEqualStrings("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", &std.fmt.bytesToHex(bytes, .lower));
}
```

`e3b0c442...` is *the* canonical SHA-256 of the empty string — if you've ever stared at a hash long enough it's burned into memory. Testing against a known constant rather than a round-trip is the right call for a hash: the whole value of a checksum is that everyone in the world computes the same digit for the same bytes, so the test has to assert the *exact* digit, not merely that it's stable. `std.fmt.bytesToHex` turns the raw 32 bytes into the 64-char lowercase string everyone expects to see.

## A tiny binary format: magic, version, length-prefixed records

The third deliverable is where text I/O and binary I/O part ways. Up to now everything `lzig` wrote was human-readable lines. A binary format is the opposite stance: a precise byte layout that a *program* reads back, with no whitespace, no delimiters, and no parsing-by-guessing. The format here stores a list of `{ key: string, value: u32 }` records, and it opens with two conventions that nearly every binary format on disk shares — a **magic number** and a **version**:

```zig
const MAGIC = "LZIG";
const VERSION: u16 = 1;

pub fn writeRecords(writer: *std.Io.Writer, records: []const Record) !void {
    try writer.writeAll(MAGIC);
    try writer.writeInt(u16, VERSION, .little);
    try writer.writeInt(u32, @intCast(records.len), .little);
    for (records) |record| {
        try writer.writeInt(u32, @intCast(record.key.len), .little);
        try writer.writeAll(record.key);
        try writer.writeInt(u32, record.value, .little);
    }
}
```

The magic `"LZIG"` is a four-byte signature at offset zero. Its only job is to let the reader reject a file that isn't ours *before* it tries to interpret a single number — open a JPEG by mistake and you find out immediately instead of allocating a four-gigabyte "key" from random bytes. The version `u16` right after it is the forward-compatibility hook: a future layout bumps to `2`, and old readers can refuse it cleanly instead of silently misreading.

The body is the part that makes binary binary. `writeInt(u32, value, .little)` writes a number as **exactly four bytes in little-endian order** — not the text `"42"`, but the raw machine representation. The `.little` is not optional decoration: endianness is the order the four bytes go on disk, and writer and reader *must agree* or every multi-byte number comes back scrambled. Picking it explicitly means the file reads the same on a big-endian machine as a little-endian one.

And every string is **length-prefixed**: a `u32` count, then exactly that many bytes. Binary formats can't lean on a delimiter the way text leans on `\n`, because any byte — including a newline — is legal data inside a key. So you say *how long* a thing is, then read precisely that many bytes. Length-then-bytes is the single most common idea in binary serialization, and the reader is its mirror image.

## Reading it back — and the errdefer that saves a half-read file

The read path validates as it goes, and it's the most careful piece of memory choreography in the sprint. Each header check has its own named error, and the record loop has to clean up *partial* work if it fails midway:

```zig
pub fn readRecords(allocator: Allocator, reader: *std.Io.Reader) ![]Record {
    const magic = try reader.takeArray(4);
    if (!std.mem.eql(u8, magic, MAGIC)) return error.BadMagic;
    const version = try reader.takeInt(u16, .little);
    if (version != VERSION) return error.UnsupportedVersion;
    const count = try reader.takeInt(u32, .little);
    var records = try allocator.alloc(Record, count);
    errdefer allocator.free(records);
    var filled: usize = 0;
    errdefer for (records[0..filled]) |record| allocator.free(record.key);
    while (filled < count) : (filled += 1) {
        const key_len = try reader.takeInt(u32, .little);
        const key = try allocator.alloc(u8, key_len);
        errdefer allocator.free(key);
        try reader.readSliceAll(key);
        const value = try reader.takeInt(u32, .little);
        records[filled] = .{ .key = key, .value = value };
    }
    return records;
}
```

The header reads mirror the writes exactly: `takeArray(4)` then check magic, `takeInt(u16, .little)` then check version, `takeInt(u32, .little)` for the count. Each mismatch surfaces as a distinct error through the `![]Record` union — `error.BadMagic`, `error.UnsupportedVersion` — so the caller can tell "not my file" from "my file, newer version."

Then the careful part. By the time the loop is halfway done, the function holds three *different* live allocations that all have to be unwound if the next read fails — and they unwind at three scopes. The function-level `errdefer allocator.free(records)` drops the outer record slice. The second function-level `errdefer for (records[0..filled]) ...` frees the keys of every record *already filled in* — and reading `filled` at unwind time, not loop-entry time, is what makes it free exactly the completed ones and not touch the uninitialized tail. And the loop-body `errdefer allocator.free(key)` covers the in-flight key — the one allocated but not yet stored into `records[filled]` when `readSliceAll` hits a truncated file. Three `errdefer`s at two scopes, each owning one layer, so a file that ends mid-record leaks nothing. This is the [nested-ownership lesson](/series/zig-learning/arena-allocators-in-zig) from Sprint 2 under pressure: when you can't use an arena because the records are the *return value*, you pay it back in precise `errdefer`s.

Notice the read methods come in two flavors that mirror the streaming choice from `sum`. `takeInt`/`takeArray`/`readSliceAll` all read *exactly* the requested size or fail with `error.EndOfStream` — the opposite of `readSliceShort`. That's the correct tool here: a binary record has a known size, so a short read isn't "we'll get the rest later," it's a corrupt file, and erroring out is exactly right.

## The tests: round-trip plus three ways to be broken

The headline test is the **identity property** — write records, read them back, assert you got the same records. That's the contract of any serializer in one test: `read(write(x)) == x`.

```zig
test "identity property" {
    const allocator = std.testing.allocator;
    var buf: [1024]u8 = undefined;
    var writer = std.Io.Writer.fixed(&buf);
    var reader = std.Io.Reader.fixed(&buf);
    const records: [3]Record = .{ .{ .key = "Zuhaib", .value = 10 }, .{ .key = "Zig", .value = 20 }, .{ .key = "Zamann", .value = 10 } };
    try writeRecords(&writer, &records);
    try writer.flush();
    const found_records = try readRecords(allocator, &reader);
    defer freeRecords(allocator, found_records);
    // ...assert lengths and every key/value match...
}
```

`Writer.fixed`/`Reader.fixed` over the same `buf` make the whole round-trip an in-memory exercise — no disk, no `io` capability needed, the bytes the writer lays down are the bytes the reader picks up. And `std.testing.allocator` means the identity test is *also* a leak test: every key `readRecords` allocates has to come back out through `freeRecords`, or the build fails.

The other three tests attack the validation, one per failure mode, and this is where the header design proves itself:

- **bad magic** — feed it `"XXXX"`, expect `error.BadMagic`. The reader bails at byte four, before allocating anything.
- **bad version** — write a valid `"LZIG"` then version `2`, expect `error.UnsupportedVersion`. The forward-compat check fires exactly as designed.
- **truncated file** — write a header claiming two records but only one record's worth of bytes, expect `error.EndOfStream`. This is the test that exercises the `errdefer` ladder: the reader allocates the slice, fills one record, then runs off the end reaching for the second — and `std.testing.allocator` confirms the partial work was fully unwound, no leak.

That last test is the satisfying one, because a passing leak-checker on a *deliberately broken* input is the proof that the three-layer `errdefer` choreography actually works. You can reason about it on paper, but the tracking allocator is what makes it certain.

## Sprint 5, done

Three small tools, one consistent posture. The walker survives the filesystem's hostility — symlink loops, unreadable directories, missing paths — by switching on entry kind and catching the errors that matter while letting one bad directory cost only itself. `sum` shows that hashing is the streaming loop wearing a different hat, reusable across any reader. And the binary format draws the line between text I/O and binary I/O: explicit endianness, length-prefixed fields, a magic number and version to fail fast on the wrong input, and an `errdefer` ladder so a corrupt file leaves no trace in memory. Binary I/O isn't harder than text — it's just *stricter*, and the strictness is the feature. Next is Sprint 6, where the single thread finally splits: mutexes, atomics, a producer-consumer queue, and a worker pool that has to shut down without hanging.
