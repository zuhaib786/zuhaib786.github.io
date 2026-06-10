---
title: "I/O in Zig: Buffered Writers and a Tiny CLI"
description: "How output works in recent Zig — the Io capability, the Writer interface, and why you have to flush — built up through a small echo/count command-line tool."
date: 2026-06-10
order: 1
tags: ["Zig", "I/O", "CLI"]
---
I've started learning Zig, and this is the first post in that journey. The plan for this series is simple: pick a small problem, write the smallest real program that exercises it, and write down what surprised me.

The first thing that tripped me up wasn't the syntax — it was I/O. If you search for "print to stdout in Zig" you'll find a dozen answers, half of which no longer compile, because the standard library's I/O interface was reworked. I'm on **Zig 0.16**, and on recent versions writing a line to the terminal involves a few more moving parts than `print("hello")`. Those parts turn out to be the interesting bit, so let's build something tiny and meet them one at a time.

## The program we're building

A command-line tool called `lzig` with two commands. `echo` prints its arguments back; `count` reports how many arguments it got and their total size in bytes:

```
$ lzig echo hello zig world
hello zig world
$ lzig count one two three
args: 3
bytes: 11
```

Small, but it touches everything: reading arguments, writing to stdout, reporting errors to stderr, and a non-zero exit code on misuse. That's a complete I/O surface in about 70 lines.

## I/O is a capability, not a global

Here's the entry point:

```zig
const std = @import("std");

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    var args = init.minimal.args.iterate();
    // ...
}
```

The signature is the first surprise. Instead of a bare `pub fn main() !void` that reaches for global functions, `main` receives a `std.process.Init`. From it we pull `init.io` — the I/O implementation — and `init.minimal.args` for the command-line arguments.

This is the key idea: **I/O is passed in as a value, not grabbed from a global**. The function can't secretly touch the terminal; if it wants to do I/O, it has to be handed an `io`. That makes the dependency explicit and, later on, makes code easy to test against an in-memory implementation instead of the real console.

## Getting a writer

`io` on its own doesn't print anything. We need a *writer* bound to a destination. Standard output is a file, and we ask it for a writer:

```zig
var out_buffer: [4096]u8 = undefined;
var out_writer = std.Io.File.stdout().writer(io, &out_buffer);
const out = &out_writer.interface;
```

Three lines, three ideas:

- `std.Io.File.stdout()` is the stdout file handle.
- `.writer(io, &out_buffer)` wraps it in a buffered writer. **You provide the buffer** — here a 4 KB array that lives on the stack. The writer accumulates bytes into it instead of making a syscall per write.
- `.interface` hands back a `*std.Io.Writer`: a pointer to the generic writer interface. This is the thing the rest of the program actually talks to.

That last point matters. `*std.Io.Writer` is an abstraction over "somewhere bytes can go." Functions that take a `*std.Io.Writer` don't know or care whether it's the terminal, a file, or an in-memory buffer — which is exactly what makes them reusable and testable.

## You have to flush

Because writes go into a buffer, they don't reach the terminal until the buffer is flushed. Forget to flush and your program runs cleanly and prints… nothing. So right after creating the writer:

```zig
defer out.flush() catch {};
```

`defer` runs this at the end of the scope, guaranteeing the buffer is drained however we leave `main`. The `catch {}` is there because a `defer` can't propagate an error, and there's nothing useful to do about a failed final flush as the program exits anyway. It reads a little odd at first, but "buffer, then flush on the way out" is the pattern.

## Writing through the interface

Now the command handlers. Notice the type of `out` — a plain `*std.Io.Writer`. The handler has no idea where its output ends up:

```zig
fn handleEcho(args: *std.process.Args.Iterator, out: *std.Io.Writer) !void {
    var first = true;
    while (args.next()) |arg| {
        if (first) {
            try out.print("{s}", .{arg});
            first = false;
        } else {
            try out.print(" {s}", .{arg});
        }
    }
    try out.print("\n", .{});
}
```

`out.print` takes a format string and a tuple of arguments, like you'd expect. The `first` flag just keeps spaces *between* words rather than before the first one.

`count` is the same shape — walk the arguments, accumulate into a small struct, print a summary:

```zig
const CountResult = struct {
    args: usize = 0,
    bytes: usize = 0,
};

fn addArg(count: *CountResult, arg: []const u8) void {
    count.args += 1;
    count.bytes += arg.len;
}

fn handleCount(args: *std.process.Args.Iterator, out: *std.Io.Writer) !void {
    var result: CountResult = .{};
    while (args.next()) |arg| addArg(&result, arg);
    try out.print("args: {d}\nbytes: {d}\n", .{ result.args, result.bytes });
}
```

I pulled `addArg` out as its own function on purpose — it's pure logic with no I/O, so it's trivial to unit test later.

## Errors go to stderr

Misuse shouldn't print to stdout, and it should fail loudly. So we make a *second* writer for stderr and define an error set for the things that can go wrong:

```zig
const CliError = error{
    MissingCommand,
    UnknownCommand,
};
```

The usage text is a multiline string literal (each line prefixed with `\\`), and a missing command prints it to stderr and returns an error — which Zig surfaces as a non-zero exit code:

```zig
const command = args.next() orelse {
    try err.print(usage, .{});
    return CliError.MissingCommand;
};
```

`orelse` handles the "no argument at all" case in one move: if `args.next()` is null, run the block.

## The whole thing

Put together, this compiles and runs on Zig 0.16:

```zig
const std = @import("std");

const CliError = error{
    MissingCommand,
    UnknownCommand,
};

const CountResult = struct {
    args: usize = 0,
    bytes: usize = 0,
};

fn addArg(count: *CountResult, arg: []const u8) void {
    count.args += 1;
    count.bytes += arg.len;
}

fn handleEcho(args: *std.process.Args.Iterator, out: *std.Io.Writer) !void {
    var first = true;
    while (args.next()) |arg| {
        if (first) {
            try out.print("{s}", .{arg});
            first = false;
        } else {
            try out.print(" {s}", .{arg});
        }
    }
    try out.print("\n", .{});
}

fn handleCount(args: *std.process.Args.Iterator, out: *std.Io.Writer) !void {
    var result: CountResult = .{};
    while (args.next()) |arg| addArg(&result, arg);
    try out.print("args: {d}\nbytes: {d}\n", .{ result.args, result.bytes });
}

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    var args = init.minimal.args.iterate();

    var out_buffer: [4096]u8 = undefined;
    var out_writer = std.Io.File.stdout().writer(io, &out_buffer);
    const out = &out_writer.interface;
    defer out.flush() catch {};

    var err_buffer: [4096]u8 = undefined;
    var err_writer = std.Io.File.stderr().writer(io, &err_buffer);
    const err = &err_writer.interface;
    defer err.flush() catch {};

    const usage =
        \\usage: lzig <command> [args]
        \\commands: echo count
        \\
    ;

    _ = args.next(); // skip the program name

    const command = args.next() orelse {
        try err.print(usage, .{});
        return CliError.MissingCommand;
    };

    if (std.mem.eql(u8, command, "echo")) {
        try handleEcho(&args, out);
    } else if (std.mem.eql(u8, command, "count")) {
        try handleCount(&args, out);
    } else {
        try err.print(usage, .{});
        return CliError.UnknownCommand;
    }
}
```

## Testing the pure parts

Because `addArg` never touches `io`, testing it needs no I/O machinery at all. Zig runs `test` blocks in the same file with `zig build test`:

```zig
test "addArg accumulates count and bytes" {
    var result: CountResult = .{};
    addArg(&result, "hello");
    addArg(&result, "world");
    try std.testing.expectEqual(@as(usize, 2), result.args);
    try std.testing.expectEqual(@as(usize, 10), result.bytes);
}
```

This is the quiet payoff of I/O-as-a-capability: the logic lives in plain functions, and the writers stay at the edges of the program. Keep the core pure and the testable surface stays large.

## Where this is going

We only did half of I/O here — *output*. The other half is reading: `stdin`, the `Reader` interface, and pulling bytes in rather than pushing them out. That's the natural next step, and where `count` gets to grow up into something closer to `wc`. More on that in the next post.
