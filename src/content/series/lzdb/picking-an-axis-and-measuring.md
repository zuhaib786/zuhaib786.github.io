---
title: "Pick One Axis, Measure It Honestly"
description: "Milestone 5 — choose a single axis (throughput, crash-safety hardening, or range queries), specialize hard, and measure it apples-to-apples against a real baseline at identical durability. 'Beat SQLite' is marketing; 'equal-durability throughput on workload X' is an acceptance criterion."
date: 2026-07-21T10:00:00Z
order: 6
tags: ["Zig", "Storage", "Benchmarks", "Performance"]
draft: true
---

<!-- SCAFFOLD — outline only, not yet written. -->

One axis, chosen on purpose, measured without flattering myself.

**To cover (pick exactly one):**
- **Throughput** — group commit / batching: one `sync` amortized over many ops, measured vs. `sqlite3` at the *same* durability (`synchronous=FULL`). Reuses the [bench harness](/series/zig-learning) and, if coordination is needed, the [concurrency work](/series/zig-learning/threads-mutexes-and-a-worker-pool-in-zig) — still a single-threaded engine; batching is about amortizing `sync`, not threads.
- **Crash-safety hardening** — per-data-block SSTable checksums + torn-write detection; survive 100k seeded crashes with zero invariant violations, reusing the [M4 simulator](/series/lzdb/deterministic-simulation-testing).
- **Range queries** — an ordered merge-iterator over memtable + SSTables behind `scan from..to`, with model-based correctness tests and a defined scan benchmark vs. SQLite over identical data.

**The honest part:** spell out the config and workload, and report where lzdb loses, not just where it wins.
