---
title: "Sprint 1: Files, Streaming, and the Flush Gotcha"
description: "Notes from building a CLI in Zig 0.15+ — buffered I/O, streaming state, and why copy worked without flushing"
date: 2026-06-13
topic: "Learning Zig"
order: 1
draft: false
---
Notes from Sprint 1 of learning Zig by building a small `cat`/`count`/`copy` CLI. Three things that were non-obvious.

## Reader/Writer: struct vs. interface
`file.reader(io, &buf)` gives a concrete `File.Reader` that owns the buffer and file position. The methods you actually call hang off `&file_reader.interface`, a generic `*Io.Reader`. Write your logic against the `interface`, and the *source* (file vs `File.stdin()`) becomes a one-line branch — both collapse to the same `*Io.Reader`. The Writer side mirrors this exactly; `stdout` is just a `File.Writer` over `File.stdout()`.

## Streaming state: don't sum per-chunk
Reading happens in chunks via `readSliceShort` (returns bytes read, `0` at EOF). A word-counter that tracks "am I inside a word?" can't be called once per chunk and summed: a word split across a buffer boundary (`"hel"` then `"lo"`) would be counted twice. Fix: keep the `in_word` flag *alive between chunks* in a small `Counter` struct with `feed(chunk)` + `finish()`. The flag carries across the boundary, so the word counts once. General lesson: streaming means state lives outside the per-chunk call.

## The flush gotcha (the important one)
Buffered writers hold bytes in user space until the buffer fills **or you flush**. Forget to flush before close and the tail is silently lost — no error. So I expected my `copy` (no flush) to drop data. It didn't, even for a 44 KB file. Why?

File→file `streamRemaining` hits a **zero-copy fast path**: `File.Writer.sendFile` → one kernel syscall (`copy_file_range`/`sendfile`) that moves bytes fd→fd, never touching my user-space write buffer. Nothing buffered ⇒ nothing to flush.

**But that path isn't guaranteed.** If the kernel/filesystem can't do the direct copy, `sendFile` returns `error.Unimplemented` and `stream` falls back to read-buffer-then-`write`, where the final sub-buffer-sized tail *does* sit in the writer buffer until flushed. On that fallback (other OS, a pipe, some filesystems) the no-flush version writes a truncated file — invisible on my Mac.

> Lesson: `try writer.flush()` before close is one line and makes you correct on *every* path. "Worked on my machine" ≠ correct — the same code took a different kernel path elsewhere. Always flush a buffered writer you own.
