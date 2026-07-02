---
title: "SSTables, a Manifest, and Surviving a Crash Mid-Compaction"
description: "Milestone 3, the LSM core — flush memtables to immutable sorted SSTables, make the manifest the authority for the live file set, and commit every structural change so a crash at any step leaves a consistent set of files. Nothing lost, nothing resurrected."
date: 2026-07-09T10:00:00Z
order: 4
tags: ["Zig", "Storage", "LSM", "Compaction"]
draft: true
---

<!-- SCAFFOLD — outline only, not yet written. -->

The largest milestone. The lesson underneath it: a `rename` is not a transaction, which is exactly why you need a manifest.

**To cover:**
- SSTable writer: flush a frozen memtable to a sorted segment (data blocks + index + footer), sorting the hash map's entries with the [merge/quick sort](/series/zig-learning/algorithms-and-a-bst-in-zig); footer checksums to reject an incomplete segment.
- Read path: memtable → SSTables ordered by **sequence number**, never file mtime; binary-search the index with `lowerBound` from the [searching/sorting sprint](/series/zig-learning/algorithms-and-a-bst-in-zig).
- The read invariant: live SSTable sequence ranges stay disjoint and totally ordered, so first-match newest→oldest is authoritative.
- The MANIFEST: append-only, synced, reusing the **same fragment framing and corruption policy** as the WAL; it carries `last_sequence`, `next_file_number`, WAL generations, and the live SSTable set.
- WAL rotation by generations — never truncate the sole WAL in place during a flush.
- Compaction policy: size-tiered *full* compaction via k-way merge (the [min-heap from the graphs sprint](/series/zig-learning/graphs-heaps-and-a-treap-in-zig)); a tombstone may be dropped only when the compaction includes every older SSTable that could hold the key.
- The commit protocol, in exact order: sync new files → rename temporaries → sync directory → append + sync manifest edit → delete obsolete files → sync directory.
- Recovery vs. filesystem: the manifest is authority; orphan/temp files not named by it are ignored and removed.

**Demo:** write past memory → SSTables + manifest evolve → trigger a compaction → crash *mid-compaction* → reopen → manifest names a consistent file set, nothing lost or resurrected.
