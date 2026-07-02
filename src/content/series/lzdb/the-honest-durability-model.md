---
title: "The Honest Durability Model: What lzdb Promises (and Doesn't)"
description: "Polish and retrospective — the architecture in one diagram, the durability/consistency model stated honestly (it does not survive a disk that lies about sync), the on-disk format, and what I understand about storage now that I didn't before the simulator."
date: 2026-07-23T10:00:00Z
order: 7
tags: ["Zig", "Storage", "Durability", "Retrospective"]
draft: true
---

<!-- SCAFFOLD — outline only, not yet written. -->

The closer: state the guarantees plainly, including the ones lzdb refuses to make.

**To cover:**
- The architecture in one picture: engine → `Storage` → Real / Simulated.
- The durability/consistency model stated honestly — what it guarantees, and what it explicitly does *not* (it does not survive a disk that lies about `sync`; that needs replication/special hardware, out of scope).
- The on-disk format + manifest spec, in one reference section.
- How to run the simulator.
- The single apples-to-apples benchmark from [the axis milestone](/series/lzdb/picking-an-axis-and-measuring).
- Five lines on what deterministic simulation testing taught me that I didn't understand before [M4](/series/lzdb/deterministic-simulation-testing).
