---
title: "A Memtable, Reads, and Tombstones That Survive a Crash"
description: "Milestone 2 — reads work, deletes are durable tombstones, and the memtable is provably a pure function of the log. Replay the WAL into a fresh memtable and you get a semantically identical state, every time."
date: 2026-07-02T10:00:00Z
order: 3
tags: ["Zig", "Storage", "LSM", "Memory"]
draft: true
---

<!-- SCAFFOLD — outline only, not yet written. -->

If the WAL is the authority, the memtable is just a cache — and this milestone makes that claim literal and testable.

**To cover:**
- Memtable as an in-memory hash map (no ordered structure yet — sorting happens at flush in M3), built on the [hash map / LRU work](/series/zig-learning/data-structures-in-zig) and the [key-lifetime/ownership rules](/series/zig-learning/allocators-in-zig) (who owns the key bytes?).
- The `put` order: durably append to WAL → `sync` → *then* update the memtable, with all allocation done before the `sync`.
- `delete` as a real, sequence-numbered tombstone WAL record — a forgotten delete is a resurrected key.
- `get`: memtable lookup, tombstone → "not found".
- Recovery: replay the WAL into a fresh memtable and assert *semantic* equality (same key→value/tombstone set), not bit-identical layout.

**Demo:** interleave puts/overwrites/deletes → crash → recover → reads return the last sync-acked value, or "not found" for tombstoned keys.
