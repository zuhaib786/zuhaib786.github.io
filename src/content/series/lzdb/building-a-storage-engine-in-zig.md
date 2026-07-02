---
title: "Building a Storage Engine in Zig: What, and Why"
description: "The kickoff for lzdb — an embedded, crash-safe, log-structured key-value engine written in Zig with nothing but the standard library. The plan, the one promise that matters (after sync returns, the bytes are durable), and how it pays off everything from the fundamentals series."
date: 2026-06-23T10:00:00Z
order: 1
tags: ["Zig", "Storage", "LSM", "Databases"]
draft: true
---

<!-- SCAFFOLD — outline only, not yet written. -->

The [Zig Learning](/series/zig-learning) series was nine sprints of fundamentals — [I/O as a capability](/series/zig-learning/io-in-zig), [allocators and ownership](/series/zig-learning/allocators-in-zig), [data structures](/series/zig-learning/data-structures-in-zig), [algorithms](/series/zig-learning/algorithms-and-a-bst-in-zig), [talking to the system](/series/zig-learning/walking-hashing-and-a-binary-format-in-zig), and [concurrency](/series/zig-learning/threads-mutexes-and-a-worker-pool-in-zig). This series spends all of it at once: building **lzdb**, an embedded, single-process, log-structured key-value engine, standard library only.

**To cover:**
- What lzdb is: LSM design (LevelDB/RocksDB as the architectural reference), TigerBeetle as the *testing-philosophy* reference — deterministic simulation, not its storage internals.
- The one promise: *after `sync` returns success, the bytes written before it are durable.* Everything else serves that sentence.
- The two crash classes that must never be conflated: `kill -9` process-crash recovery vs. power-loss faults (only the simulator tests the latter).
- The `Storage` interface from commit one, so the simulator drops in later with no rewrite.
- The five-milestone map: WAL+recovery → memtable+tombstones → SSTables+manifest+compaction → simulation testing → measure one axis honestly.
