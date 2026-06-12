---
title: "I/O in Zig, Part 2: Readers, stdin, and Growing count into wc"
description: "The other half of I/O in Zig 0.16 — the Reader interface, reading stdin, streaming a file, and turning count into a tiny wc that reads from a file or a pipe."
date: 2026-06-13
order: 2
tags: ["Zig", "I/O", "CLI"]
---
[Last time](/series/zig-learning/io-in-zig) we built half of an I/O surface: *output*. We met the `Io` capability, the buffered `Writer`, and the rule that you have to flush. We ended with a promise — the other half is *reading*, and that's where `count` gets to grow up into something closer to `wc`.

So that's this post. Same tiny tool, `lzig`, now with a `cat` command and a `count` that reads from a file or from a pipe. Reading turns out to be pleasingly symmetric to writing, with two genuinely new ideas: where the bytes *come from*, and what to do when there are no more of them.

## A reader is just a writer pointed the other way

Here's how we get a reader on standard input. Put it next to the writer code from part 1 and the shape is identical:

```zig
const stdin_file = std.Io.File.stdin();
var stdin_buffer: [4096]u8 = undefined;
var stdin_reader = stdin_file.reader(io, &stdin_buffer);
const stdin = &stdin_reader.interface;
```

Beat for beat the same moves as `stdout`:

- `std.Io.File.stdin()` is the file handle.
- `.reader(io, &stdin_buffer)` wraps it in a *buffered* reader, and — just like the writer — **you provide the buffer**. The reader pulls bytes from the OS in chunks into this array instead of making a syscall per byte.
- `.interface` hands back a `*std.Io.Reader`: the generic "somewhere bytes come from" abstraction.

That last line is the payoff again. A function that takes a `*std.Io.Reader` doesn't know whether its bytes are arriving from the keyboard, a file on disk, or a pipe from another process. We'll lean on exactly that in a minute.

## EOF is the new surprise

With a writer, you push bytes and they go. With a reader, you ask for bytes and you have to handle the answer *there are no more*. That's the new wrinkle. Here's the core read loop:

```zig
pub fn count_from_reader(out: *std.Io.Writer, reader: *std.Io.Reader) !void {
    var chunk: [1024]u8 = undefined;
    var counter: Counter = .{};
    while (true) {
        const n = try reader.readSliceShort(&chunk);
        if (n == 0) break;
        counter.feed(chunk[0..n]);
    }
    const result = counter.finish();
    try out.print("Bytes: {d}\nLines: {d}\nWords: {d}\n", .{ result.bytes, result.lines, result.words });
}
```

Two things to notice.

First, `readSliceShort`. The "short" is the important part: it fills *as much as it can right now* and returns how many bytes that was, which may be fewer than the slice you handed it. That's exactly what you want for streaming — you don't want to block waiting for a full 1024 bytes when the terminal just gave you one line. You loop, and a return of `0` is end-of-input. (Contrast with a "read exactly N or error" call, which is the wrong tool when the input is a stream of unknown length.)

Second, `chunk[0..n]`. We only feed the bytes that were actually filled, never the stale tail of the buffer. Easy to get wrong, and the kind of bug that only shows up on the last partial read.

## Counting across chunk boundaries

The thing doing the work is `Counter`, and it's a small state machine on purpose:

```zig
const Counter = struct {
    count: TextCount = .{},
    in_word: bool = false,

    fn feed(self: *Counter, input: []const u8) void {
        self.count.bytes += input.len;
        for (input) |byte| {
            if (byte == '\n') {
                self.count.lines += 1;
            }
            if (byte == '\n' or byte == ' ' or byte == '\t' or byte == '\r') {
                if (self.in_word) {
                    self.count.words += 1;
                }
                self.in_word = false;
            } else {
                self.in_word = true;
            }
        }
        // ...
    }

    fn finish(self: *Counter) TextCount {
        if (self.in_word) {
            self.count.words += 1;
        }
        return self.count;
    }
};
```

Why a struct with a field, instead of a function that counts spaces in a buffer? Because the input arrives in chunks, and a word can be split across two of them — `hel` at the end of one `feed`, `lo` at the start of the next. If each call counted independently it would see two words. The `in_word` flag is the memory that carries the "we're in the middle of a word" fact across the boundary, so we only count the *transition* from word to whitespace. A word becomes a word the moment it ends.

That also explains `finish()`. If the input doesn't end in whitespace, the final word never sees its closing transition during `feed`, so `finish` settles the tab: if we're still `in_word` at end-of-input, that's one more word. It's the streaming version of an off-by-one you'd never think about if you had the whole string in memory.

## count grows up: a file *or* a pipe

Here's where the `*std.Io.Reader` abstraction earns its keep. Real `wc` reads a file if you name one, and reads stdin if you don't:

```zig
pub fn handle_count(args: *std.process.Args.Iterator, out, err, in: *std.Io.Reader, io: std.Io) !bool {
    const path = args.next() orelse {
        try count_from_reader(out, in);
        return true;
    };
    const file = std.Io.Dir.cwd().openFile(io, path, .{}) catch |e| {
        try printOpenError(err, path, e);
        return false;
    };
    defer file.close(io);
    var buf: [1024]u8 = undefined;
    var file_reader = file.reader(io, &buf);
    const reader = &file_reader.interface;
    try count_from_reader(out, reader);
    return true;
}
```

The `orelse` does the whole Unix convention in one move: no path argument? Fall back to the stdin reader we already have. Otherwise open the file and get *its* reader. Both branches call the exact same `count_from_reader` — it never learns which one it got, because both are just a `*std.Io.Reader`. That's the abstraction paying off concretely: one counting routine, two sources, zero branching inside the logic.

Opening the file is its own little I/O lesson:

- `std.Io.Dir.cwd().openFile(io, path, .{})` — opening is itself an operation that needs the `io` capability. There are no ambient file handles; even "the current directory" is reached through `io`.
- `catch |e|` captures the error union. Opening can fail a dozen ways, so we map the common ones to readable messages:

```zig
fn printOpenError(err: *std.Io.Writer, path: []const u8, e: anyerror) !void {
    switch (e) {
        error.FileNotFound => try err.print("{s}: no such file\n", .{path}),
        error.AccessDenied => try err.print("{s}: permission denied\n", .{path}),
        error.IsDir => try err.print("{s}: is a directory\n", .{path}),
        else => try err.print("{s}: cannot open\n", .{path}),
    }
}
```

- `defer file.close(io)` — closing needs `io` too, and `defer` makes sure it happens however we leave the function.

## cat: when you don't even need the loop

`cat` reads a file and dumps it to stdout. We *could* write the same chunk loop as `count`. But reading from one place and writing to another is such a common shape that the `Reader` has a method for exactly it:

```zig
pub fn handle_cat(args: *std.process.Args.Iterator, out, err, io: std.Io) !bool {
    const path = args.next() orelse {
        try err.print("cat: missing path\n", .{});
        return false;
    };
    const file = std.Io.Dir.cwd().openFile(io, path, .{}) catch |e| {
        try printOpenError(err, path, e);
        return false;
    };
    defer file.close(io);
    var buf: [1024]u8 = undefined;
    var file_reader = file.reader(io, &buf);
    const reader = &file_reader.interface;
    _ = try reader.streamRemaining(out);
    return true;
}
```

`reader.streamRemaining(out)` is the whole body of the loop, gone. It pumps everything left in the reader straight into a writer — reader on one side, writer on the other, both just interfaces. No intermediate `chunk` array of our own, because the reader's buffer already *is* the staging area. It returns the number of bytes moved; we don't care here, so `_ =`.

It's a neat illustration of why both ends being interfaces matters: `streamRemaining` is a single function that connects *any* reader to *any* writer, and it works for our file-to-stdout case without knowing anything about files or terminals.

## A small detour: flushing before you bail

One thing changed structurally from part 1. Each handler now returns a `bool` — did it succeed? — and `main` turns a `false` into a non-zero exit:

```zig
const ok = switch (command) {
    .echo => try handle_echo(&args, stdout),
    .count => try handle_count(&args, stdout, stderr, stdin, io),
    .cat => try handle_cat(&args, stdout, stderr, io),
};
if (!ok) {
    // process.exit() skips the deferred flushes above, so flush by hand first.
    stdout.flush() catch {};
    stderr.flush() catch {};
    std.process.exit(1);
}
```

That comment is a trap I walked into. In part 1 we leaned on `defer out.flush()` to drain the buffer on the way out of `main`. But `std.process.exit` ends the process *immediately* — it does not unwind the stack, so your deferred flushes never run. Buffer your error message, call `exit(1)`, and the user sees… nothing, because the bytes died in the buffer. So the rule pairs with part 1's rule: **buffered output plus a hard exit means you flush by hand first.** Returning an error from `main` is fine (the defers run); calling `exit` is not.

## The pure core is still pure

The nicest part survived the upgrade. All the counting logic lives in `Counter`, which never touches `io`. So the tests feed it plain strings and check the numbers, no I/O machinery at all:

```zig
test "text count" {
    var text: []const u8 = "hello\nzig\n";
    var text_count = countText(text);
    try std.testing.expectEqual(TextCount{ .lines = 2, .words = 2, .bytes = 10 }, text_count);

    text = " hello\tzig\r\nagain";
    text_count = countText(text);
    try std.testing.expectEqual(TextCount{ .lines = 1, .words = 3, .bytes = 17 }, text_count);
}
```

That second case is the cross-boundary logic in miniature: leading space, a tab and a `\r\n` between words, and a trailing word with no whitespace after it — three words, one line. The same `Counter` that streams a 4 GB file through 1 KB chunks is the one being checked here against a 17-byte literal. Keep the logic pure and the readers at the edges, and your tests get to ignore I/O entirely.

## Where this leaves us

We now have the full loop: arguments in, files and stdin read, bytes counted or streamed, results to stdout, errors to stderr, and a correct exit code. `lzig` does a believable impression of `echo`, `wc`, and `cat` in well under 200 lines, and almost none of those lines are fighting the I/O model — once the `Reader`/`Writer` symmetry clicks, it mostly gets out of the way.

The thing I keep coming back to is how much falls out of "I/O is a capability you're handed." Readers and writers are values, the logic between them is pure, and the same `count_from_reader` serves a file and a pipe without noticing the difference. Next I want to push on the parts I waved at here — what `streamRemaining` is doing underneath, and what happens when the buffer sizes start to matter.
