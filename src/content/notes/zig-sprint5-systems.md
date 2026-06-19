---
title: "Sprint 5: A Hostile Filesystem, Hashing as a Stream, and the errdefer Ladder"
description: "Notes from the systems sprint in Zig — why a directory walker switches on entry kind and continues past errors, how a checksum is just the streaming loop again, and the three-scope errdefer that keeps a truncated binary file from leaking"
date: 2026-06-19
topic: "Learning Zig"
order: 5
draft: false
---
Notes from Sprint 5: a recursive directory walker, a SHA-256 checksum, and a tiny binary file format. The [long post](/series/zig-learning/walking-hashing-and-a-binary-format-in-zig) walks the code; here are the three things that actually changed how I think.

## The filesystem is hostile, so the default path has to survive it
A directory entry is not "a file" — it's a tagged union of file, directory, symlink, and stranger things, and the walker `switch`es on `entry.kind`. Two decisions make it robust instead of naive. First, the symlink case **prints and stops** — it never descends, because following a link that points at its own ancestor is how a walker loops forever (the filesystem version of a visited-set). Second, `openDir` is wrapped in a `catch` that maps `error.AccessDenied` to a line on *stderr* plus a `continue`, so one unreadable directory costs one directory, not the whole traversal — and the complaint goes to stderr while the listing goes to stdout, so piping still gives a clean tree. Robustness here wasn't extra code bolted on; it was choosing per-entry recovery over abort-on-first-error as the default shape.

## A checksum is the streaming loop wearing a different hat
`hashReaders` is the [`count` read loop](/notes/zig-sprint1-io) with `hasher.update` where the word-counter used to be: `readSliceShort` into a 4 KB buffer, `n == 0` is EOF, feed only `buf[0..n]`. Two details. The hash is **two-phase** — `update` many times to fold in chunks, then `final` *once* to settle padding and emit the digest; `final` spends the hasher. And the digest is `[Sha256.digest_length]u8`, a fixed-size array on the stack — nothing to free, because the size is a compile-time constant on the type. The test asserts against the *canonical* vector (`e3b0c442…` is the SHA-256 of the empty string), not a round-trip, because the entire value of a checksum is that everyone computes the same digits — so the test must pin the exact digits.

## The errdefer ladder for a half-read file (the important one)
Binary I/O is just *stricter* than text: explicit `.little` endianness and length-prefixed fields replace the delimiter (any byte, including `\n`, is legal data), and a magic header + version let the reader fail fast on the wrong input. The sharp part is `readRecords`, which can't use an [arena](/notes/zig-sprint2-allocators) because the records *are* the return value — so a truncated file mid-read has to unwind three live allocations at three scopes:

```zig
var records = try allocator.alloc(Record, count);
errdefer allocator.free(records);                              // outer slice
var filled: usize = 0;
errdefer for (records[0..filled]) |r| allocator.free(r.key);   // keys already filled
while (filled < count) : (filled += 1) {
    const key = try allocator.alloc(u8, key_len);
    errdefer allocator.free(key);                              // the in-flight key
    try reader.readSliceAll(key);                              // ← truncation errors here
    // ...store into records[filled]...
}
```

Three `errdefer`s, each owning exactly one layer: the outer slice, the keys of records *already* completed (and reading `filled` at unwind time, not loop entry, is what frees the finished ones and not the uninitialized tail), and the one key allocated but not yet stored. The proof it works is that the "truncated file" test runs under `std.testing.allocator` and passes — a leak-checker coming back clean on a *deliberately broken* input is the only way to be sure the ladder is right. When you can't reach for an arena, you pay it back in precise `errdefer`s.
