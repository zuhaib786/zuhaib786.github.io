---
title: "The Storage Interface, a Write-Ahead Log, and Tail Repair"
description: "Milestone 1 — the durability core. A Storage vtable, a LevelDB-style 32 KiB-block WAL with per-fragment checksums, and recovery that truncates a torn tail but treats mid-log corruption as fatal. After a kill -9, every sync-acked write survives."
date: 2026-06-28T10:00:00Z
order: 2
tags: ["Zig", "Storage", "WAL", "Durability"]
draft: true
---

<!-- IN PROGRESS — the Storage interface section is written against the committed code.
     Everything from "File headers" down is still outline; C1 isn't finished. -->

The [kickoff post](/series/lzdb/building-a-storage-engine-in-zig) made one promise and hung the entire project off it: *after `sync` returns success, the bytes written before it are durable.* Milestone 1 is that promise in miniature. No memtable, no SSTables, no compaction — just a log you can append to, a `sync` that means something, and a recovery path that can look at a file a crash left half-written and decide, correctly, what part of it to believe.

But before any of that, a detour that looks like bureaucracy and isn't.

## The interface comes first, and it isn't bureaucracy

The engine never touches the filesystem. Every read, every write, every `sync` goes through a `Storage` vtable — a struct of function pointers with a type-erased context:

```zig
pub const Handle = usize; // filehandler

/// File system indirection
pub const Storage = struct {
    context: *anyopaque,
    openFn: *const fn (*anyopaque, []const u8) anyerror!Handle,
    createFn: *const fn (*anyopaque, []const u8) anyerror!Handle,
    closeFn: *const fn (*anyopaque, Handle) anyerror!void,
    readFn: *const fn (*anyopaque, Handle, u64, []u8) anyerror!usize,
    writeFn: *const fn (*anyopaque, Handle, u64, []const u8) anyerror!usize,
    fileSizefn: *const fn (*anyopaque, Handle) anyerror!u64,
    truncateFn: *const fn (*anyopaque, Handle, u64) anyerror!void,
    syncFn: *const fn (*anyopaque, Handle) anyerror!void,
    renameFn: *const fn (*anyopaque, []const u8, []const u8) anyerror!void,
    removeFn: *const fn (*anyopaque, []const u8) anyerror!void,
    listDirectoryFn: *const fn (*anyopaque, Allocator) anyerror![]Entry,
    syncDirectoryFn: *const fn (*anyopaque) anyerror!void,
};
```

This exists from commit one for a reason that only pays off at Milestone 4. The thing I actually want to build is a *simulator* — a second implementation of this same interface that tears writes in half, drops unsynced data, fails `sync`, and crashes the engine at a chosen point, all driven by a single PRNG seed. If the engine reaches for `std.Io.Dir` even once, that whole milestone becomes a rewrite instead of a new file. So the discipline is: `RealStorage` is the only code in the project allowed to know that a filesystem exists.

That's also why the interface is *narrow and awkward on purpose*. `read` and `write` take an explicit offset and return a count — there's no cursor, no `writeAll`. A file is a `Handle`, an integer, not a `std.Io.File`. Every method is something a simulator can plausibly implement and lie about. Anything more convenient would be something the simulator can't fault-inject, which is to say: something that hides a way the disk can hurt me.

The `usize` return on `read` and `write` is the sharpest edge here, and it's deliberate. A write is *allowed* to be partial. Callers must loop:

```zig
var written: usize = 0;
while (written < payload.len) {
    const count = try storage.write(handle, @intCast(written), payload[written..]);
    if (count == 0) return error.WriteZero;
    written += count;
}
```

On `RealStorage`, against a normal file, that loop will run exactly once forever and the `while` will look like superstition. That's the trap: a caller that forgets the loop and just calls `write` once will pass every test I can write today, and only fail at M4 when a torn write finally shows up — by which point the bug is somewhere in a WAL writer I stopped thinking about weeks ago. The counts have to stay on the interface, because partial writes are precisely what I'm building the simulator to inject.

## RealStorage: a file table behind an integer

`RealStorage` maps `Handle` → `std.Io.File` through a hash map, handing out monotonically increasing integers:

```zig
fn addFile(rs: *RealStorage, file: std.Io.File) !Handle {
    const handle = rs.next_handle;
    rs.next_handle += 1;
    errdefer file.close(rs.io);
    try rs.files.put(handle, file);
    return handle;
}
```

The indirection through an integer isn't decoration. `SimulatedStorage` has no `std.Io.File` to hand back — its "files" are byte buffers in memory that it can corrupt at will. Both implementations can hand out a `usize`. The `errdefer` is the [ownership reflex](/series/zig-learning/allocators-in-zig) from Sprint 2 showing up in a new costume: `put` can fail on allocation, and if it does, the file I just opened has no owner and would leak the descriptor. The `errdefer` closes it on exactly the failure path and never on the success path.

`syncDirectory` is the method that looks strangest and matters most later:

```zig
fn syncDirectory(context: *anyopaque) !void {
    const rs = realStorage(context);
    const directory_file = try rs.dir.openFile(rs.io, ".", .{
        .mode = .read_only,
        .allow_directory = true,
    });
    defer directory_file.close(rs.io);
    return directory_file.sync(rs.io);
}
```

You open a *directory* as a file and `fsync` it. The reason is that a `rename` is a modification to a directory, and syncing the renamed *file* does nothing for the durability of the *name*. Crash after a rename without the directory sync and the file can come back under its old name — or under neither. This method is unused in M1 and load-bearing in M3, where the commit protocol for every structural change runs `sync` new file → `rename` → **`sync` directory** → manifest edit. Writing it now, unused, was cheaper than discovering the concept later.

### What the tests are actually testing

The round-trip test does create → write → sync → size → read → truncate → close → reopen, and the detail I want to flag is that it drives everything through `storage`, the interface value — never through `real`, the concrete struct:

```zig
var real = RealStorage.init(allocator, io, tmp.dir);
defer real.deinit();
const storage = real.storage();
```

That's not aesthetics. A test that reaches for the concrete type is a test that will not run against `SimulatedStorage`, and the entire bet of this milestone is that the M4 simulator drops in underneath everything without the layer above noticing.

`listDirectory` gets its own test, and its implementation is where the errdefer choreography from the [binary-format sprint](/series/zig-learning/walking-hashing-and-a-binary-format-in-zig) earns its keep: an inner `errdefer allocator.free(name)` for the name in flight, plus an outer block `errdefer` that frees every name already appended and the list itself. Fail on the fourth `dupe` of a seven-entry directory and three names and one list get cleaned up, each exactly once.

## Open questions I haven't settled

Two things I know are wrong-ish and haven't fixed, written down here so I can't quietly forget them:

**`anyerror` everywhere.** It's the standard move for a type-erased vtable, and it means the engine cannot exhaustively `switch` on what can go wrong. Right now there's one implementation and it doesn't bite. At M4 I'll have a simulator injecting errors that no call site has a handler for, which is either exactly what I want (it finds real gaps) or a source of noise (it finds errors that can't physically happen). A concrete `Storage.Error` set is the fix, and it's cheaper to define now with one implementation than later with two.

**`listDirectory` depends on the caller having opened `dir` with `.iterate = true`,** and nothing in the type says so. The test does it. An `open()` that forgets gets a runtime error from deep inside `RealStorage` with no useful trail back to the cause.

<!-- ================= STILL TO WRITE ================= -->

**To cover:**
- File headers: `magic + format_version`, rejecting unknown versions — reusing the [binary-format work](/series/zig-learning/walking-hashing-and-a-binary-format-in-zig). Never guess at a version you don't recognize.
- WAL framing: fixed 32 KiB physical blocks, `full / first / middle / last` fragments, no fragment crossing a block boundary — and *why* the block boundary is what makes resynchronization possible at all.
- Per-fragment frame `checksum | length | kind | payload`, the checksum covering everything but itself — so corruption of the *framing header* is detected, not just the payload. Reuses the [streaming checksum work](/series/zig-learning/walking-hashing-and-a-binary-format-in-zig).
- Hard limits validated *before* allocating or slicing, so a corrupt file can't talk me into a 4 GB allocation or an integer overflow on an offset.
- The `put` contract: success reported only *after* `sync` returns, and only after every allocation the record needs has already succeeded. A durable record while `put` returns `error.OutOfMemory` is a broken promise.
- Recovery with tail repair: track `last_valid_offset`, truncate a torn trailing record back to it. **The asymmetry that is the whole lesson:** a corrupt final block is expected and gets truncated; a corrupt block followed by any non-empty block is mid-log corruption and is *fatal* — refuse to open rather than silently drop later records.
- The question I owe an answer to: `truncate` and `sync` are separate calls. What does the file look like if I truncate and crash before syncing — and is that actually a problem?

**Demo:** put keys → `kill -9` mid-run → reopen → every sync-acked write present, torn trailing record truncated, WAL clean for new appends.
