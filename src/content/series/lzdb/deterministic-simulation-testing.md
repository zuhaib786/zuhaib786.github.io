---
title: "Deterministic Simulation Testing: Finding a Bug by Seed"
description: "Milestone 4, the soul of the project — a second Storage implementation that injects faults from one PRNG seed, a reference model of caller-acknowledged state, and a harness that finds a real durability bug and replays it bit-for-bit. TigerBeetle's testing philosophy, applied."
date: 2026-07-16T10:00:00Z
order: 5
tags: ["Zig", "Storage", "Testing", "Durability"]
draft: true
---

<!-- SCAFFOLD — outline only, not yet written. -->

This is the payoff of putting a `Storage` interface in at commit one: the entire engine runs unchanged against a simulated disk that lies, tears, and crashes on cue.

**To cover:**
- `SimulatedStorage` — a second impl of the M1 `Storage` interface, every nondeterministic choice drawn from one PRNG seed, built on the [`std.Random` work from the treap](/series/zig-learning/graphs-heaps-and-a-treap-in-zig). Same seed → identical run.
- Fault injection that *obeys* the fault model: tear writes, drop/reorder **unsynced** writes, fail `sync` with an error — but a `sync` that returns success keeps its data (never report success then discard).
- The reference model's three states per op: `submitted`, `durable`, `acknowledged`; a crash may land between durable and acknowledged.
- Post-crash assertions: every acknowledged op is reflected; the final in-flight op may be present or absent; no never-submitted op appears; no torn record loads.
- The harness loop: seed → workload → fault → assert → replay. A failing seed reproduces identically.
- The trap that bites everyone: hidden nondeterminism (map iteration order, timestamps, pointer addresses) leaking into behavior so seeds stop reproducing.

**Demo:** `lzdb simulate --seed 12345` runs a full crash/recover lifecycle; a deliberately injected durability bug is caught by some seed, printed, and reproduced bit-for-bit on rerun.
