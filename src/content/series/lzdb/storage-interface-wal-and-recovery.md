---
title: "The Storage Interface, a Write-Ahead Log, and Tail Repair"
description: "Milestone 1 — the durability core. A Storage vtable, a LevelDB-style 32 KiB-block WAL with per-fragment checksums, and recovery that truncates a torn tail but treats mid-log corruption as fatal. After a kill -9, every sync-acked write survives."
date: 2026-06-28T10:00:00Z
order: 2
tags: ["Zig", "Storage", "WAL", "Durability"]
draft: true
---

<!-- SCAFFOLD — outline only, not yet written. -->

The first milestone is the whole point in miniature: make `sync` the durability boundary and prove it.

**To cover:**
- The `Storage` vtable (open/create/close, read/write/fileSize/truncate/sync, rename/remove, listDirectory/syncDirectory) and `RealStorage` over `std.Io` — built on the [I/O capability](/series/zig-learning/io-in-zig) from the fundamentals series.
- File headers: `magic + format_version`, rejecting unknown versions — reusing the [binary-format work](/series/zig-learning/walking-hashing-and-a-binary-format-in-zig).
- WAL framing: fixed 32 KiB physical blocks, `full / first / middle / last` fragments, no fragment crossing a block boundary.
- Per-fragment frame `checksum | length | kind | payload`, the checksum covering everything but itself — reusing the [streaming SHA-256 / checksum work](/series/zig-learning/walking-hashing-and-a-binary-format-in-zig).
- Hard limits validated *before* allocating or slicing, so a corrupt file can't request unbounded memory or overflow an offset.
- The `put` contract: success reported only *after* `sync`, and only after all allocations already succeeded.
- Recovery with tail repair: truncate a torn trailing record back to `last_valid_offset`; treat a corrupt block followed by any non-empty block as fatal mid-log corruption.

**Demo:** put keys → `kill -9` mid-run → reopen → every sync-acked write present, torn trailing record truncated, WAL clean for new appends.
