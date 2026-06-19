---
title: "Threads, a Blocking Queue, and a Worker Pool That Shuts Down Clean"
description: "Sprint 6 — a mutex counter beside an atomic one, a bounded producer-consumer queue built on condition variables, a worker pool with graceful shutdown and error propagation to the caller, and a parallel file-checksum pipeline that reuses Sprint 5's sum with no lock on its results."
date: 2026-06-19
order: 9
tags: ["Zig", "Concurrency", "Threads", "Systems"]
---
The [last post](/series/zig-learning/walking-hashing-and-a-binary-format-in-zig) closed Sprint 5 with three tools that talked to the operating system but did it one thread at a time. Sprint 6 is where the single thread finally splits. The deliverables build on each other: two thread-safe counters (one with a mutex, one atomic, to *feel the difference*), a bounded producer-consumer queue on condition variables, a worker pool that shuts down without hanging and gets its errors back to the caller, and a parallel file-checksum pipeline that reuses [`sum`](/series/zig-learning/walking-hashing-and-a-binary-format-in-zig) from last sprint. The thread running through all of it: the hard part of concurrency isn't starting threads, it's *stopping* them — cleanly, with their results and their failures intact.

One Zig-0.16 note up front. The synchronization primitives are reached through the same `io` capability as files were: `std.Io.Mutex`, `std.Io.Condition`, and a lock is `mutex.lockUncancelable(io)`. There are no ambient locks any more than there were ambient file handles — concurrency is I/O, and you're handed the capability to do it.

## Two counters, one to feel the difference

The warm-up is the same counter built twice. The mutex version wraps every increment in a critical section:

```zig
const Counter = struct {
    value: u64 = 0,
    mutex: Mutex = .init,
    pub fn bump(self: *Counter, io: std.Io, n: usize) void {
        for (0..n) |_| {
            self.mutex.lockUncancelable(io);
            defer self.mutex.unlock(io);
            self.value += 1;
        }
    }
};
```

The atomic version drops the lock entirely:

```zig
const AtomicCounter = struct {
    value: std.atomic.Value(u64) = .init(0),
    pub fn bump(self: *AtomicCounter, n: usize) void {
        for (0..n) |_| _ = self.value.fetchAdd(1, .monotonic);
    }
};
```

Both tests spawn 8 threads that each bump 100,000 times and assert the total is exactly 800,000 — the canonical "did you actually make `+= 1` safe?" check, because `value += 1` is really *load, add, store*, and without protection two threads interleave those steps and lose increments. The mutex makes the three steps one indivisible region. The atomic makes the increment *itself* one indivisible instruction (`fetchAdd`), no lock acquired or released.

The difference you're meant to feel: the mutex protects an arbitrary *block* of code, so reach for it when an invariant spans several operations or several fields. The atomic protects exactly *one* word with a single hardware op — faster and lock-free, but only for that one update, with no room to do anything else atomically alongside it. The `.monotonic` ordering is the weakest one, and it's correct here precisely because nothing else is ordered *by* this counter — no other memory's visibility depends on the count, so we pay for no extra fencing. The moment another thread had to read this value and then trust some *other* data was ready, `.monotonic` would be too weak.

## The blocking queue: condition variables and waiting in a loop

The producer-consumer queue is the centerpiece, and it's the [Sprint 3 ring buffer](/series/zig-learning/data-structures-in-zig) — `head` + `count` modular arithmetic — wrapped in synchronization so producers and consumers can hammer it from different threads. The new machinery is **two condition variables**: `not_empty` (consumers wait on it) and `not_full` (producers wait on it).

```zig
pub fn push(self: *Self, io: std.Io, item: T) void {
    self.mutex.lockUncancelable(io);
    defer self.mutex.unlock(io);
    while (self.count == capacity and !self.closed) self.not_full.waitUncancelable(io, &self.mutex);
    if (self.closed) return;
    self.buf[(self.head + self.count) % capacity] = item;
    self.count += 1;
    self.not_empty.signal(io);
}
pub fn pop(self: *Self, io: std.Io) ?T {
    self.mutex.lockUncancelable(io);
    defer self.mutex.unlock(io);
    while (self.count == 0 and !self.closed) self.not_empty.waitUncancelable(io, &self.mutex);
    if (self.count == 0) return null;
    const item = self.buf[self.head];
    self.head = (self.head + 1) % capacity;
    self.count -= 1;
    self.not_full.signal(io);
    return item;
}
```

Three things here are load-bearing and each is a classic trap.

**`wait` releases the lock, then re-takes it.** That's the whole trick of a condition variable: `waitUncancelable(io, &self.mutex)` atomically unlocks the mutex and sleeps, so *another* thread can take the lock and change `count`, then wakes up holding the lock again. Without that release nobody could ever make the condition you're waiting for come true — you'd hold the lock while sleeping and deadlock instantly.

**The wait is in a `while`, not an `if`.** When a thread wakes, it re-checks `count == capacity` instead of assuming it's now false. This guards against two real things: *spurious wakeups* (a wait can return without a signal), and the case where it was signalled but another thread raced in and re-filled the slot before this one reacquired the lock. The predicate is the truth; the signal is only a hint to go re-check it. Phrase it as `if` and you act on a condition that's no longer true.

**Each side signals the other.** A successful `push` wakes a consumer (`not_empty.signal`); a successful `pop` wakes a producer (`not_full.signal`). The producer test uses capacity 4 with 5,000 items precisely so the producer keeps hitting the full-queue wait and the FIFO order survives all the blocking — and the multi-producer/multi-consumer test sizes the work to divide evenly so every item pushed is popped exactly once and the totals balance.

## Closing the queue is the actual hard part

A queue that only ever fills and drains is easy. The difficulty is *ending* — telling consumers blocked in `pop` that no more items are ever coming, so they stop waiting and let their threads exit. That's what `closed` and `close` are for:

```zig
pub fn close(self: *Self, io: std.Io) void {
    self.mutex.lockUncancelable(io);
    defer self.mutex.unlock(io);
    self.closed = true;
    self.not_empty.broadcast(io);
}
```

`broadcast`, not `signal` — and this is the single most important line in the file. `signal` wakes *one* waiter; `broadcast` wakes *all* of them. If four worker threads are blocked in `pop` on an empty queue and `close` only `signal`ed, exactly one would wake, see the queue closed, and exit — and the other three would sleep forever, hanging shutdown. There's a test built specifically to catch this: start a pool of 4 workers, submit *nothing*, and shut down. If `close` used `signal` it would deadlock; reaching the end of the test proves all four idle workers woke and exited. The `pop` predicate is the other half: `while (count == 0 and !closed)` — once closed, the loop falls through, and `if (count == 0) return null` hands the worker its "we're done" signal. A closed queue still drains its remaining items first, *then* starts returning null.

## The worker pool: graceful shutdown and errors that come back

The pool ties it together. `start` spawns N threads each running `workerLoop`, which is dead simple — pop jobs until the queue says null:

```zig
fn workerLoop(self: *Self, io: std.Io) void {
    while (self.queue.pop(io)) |job| {
        job.run() catch |e| self.record_first_error(e, io);
    }
}
```

Two design decisions make this *graceful* rather than abort-on-first-error. First, a job that fails doesn't stop the worker — the error is recorded and the loop pops the next job. Second, `record_first_error` keeps only the *first* error under a mutex (`if (self.first_error == null) self.first_error = e`), so concurrent failures don't race and the caller gets one representative error rather than a torn one. Every submitted job still runs; the failure is reported, not thrown mid-batch. The test submits 200 jobs with job #100 rigged to fail, then checks both that `shutdown` returns `error.Boom` *and* that all 200 jobs executed.

`shutdown` is where it all converges:

```zig
pub fn shutdown(self: *Self, io: std.Io, allocator: Allocator) !void {
    self.queue.close(io);
    for (self.threads) |thread| thread.join();
    allocator.free(self.threads);
    const ans = self.first_error;
    self.* = .{};
    return ans orelse {};
}
```

Close the queue (every blocked worker wakes via broadcast and drains-then-exits), `join` every thread (block until each has actually finished), free the thread handles, and return the first error to the caller. That the `pool: runs every submitted job` test *returns at all* instead of hanging is itself the proof the workers exited — a deadlocked pool would never reach the assertion.

## The startup deadlock you only hit on the error path

The subtlest bug in the whole sprint lives in `start`, on the failure path. Spawning N threads can fail partway — say thread 3 of 8 won't spawn. The already-running threads are blocked in `queue.pop` on an empty queue, so you cannot just `join` them; they'd never return. The `errdefer` has to *close the queue first*:

```zig
var filled: usize = 0;
errdefer {
    // Workers already spawned are blocked in queue.pop; we must close
    // the queue before joining or this error path deadlocks.
    self.queue.close(io);
    for (self.threads[0..filled]) |thread| thread.join();
}
while (filled < numWorkers) : (filled += 1) {
    self.threads[filled] = try std.Thread.spawn(.{}, workerLoop, .{ self, io });
}
```

It's the same close-then-join discipline as `shutdown`, but reached through error unwinding — `filled` tracks exactly how many threads exist so the cleanup joins those and not uninitialized handles. This is the [errdefer-ladder reflex](/notes/zig-sprint5-systems) from the binary reader, except the resource being unwound is *running threads* instead of allocations, and the unwinding order (close, then join) is mandatory rather than merely tidy. Get it backwards and the error path hangs forever — a deadlock that only ever fires when something *else* already went wrong.

## The parallel checksum pipeline: parallel map without a lock

The capstone deliverable is `sum --parallel <dir>`: walk a directory, checksum every file across the pool, print `<hex>  <path>`. It's "parallel map" wearing the worker pool, and the elegant part is that its results need **no mutex at all**.

```zig
const results = try allocator.alloc(SumResult, paths.items.len);
defer allocator.free(results);
for (results) |*r| r.* = .{};
// ...
var pool: Pool(ChecksumJob) = .{};
try pool.start(workers, io, allocator);
for (paths.items, results) |p, *r| {
    pool.submit(.{ .dir = open_base, .io = io, .path = p, .result = r }, io);
}
try pool.shutdown(io, allocator); // joins every worker before we touch `results`
```

Each job gets a pointer to its *own* result slot, indexed by collection order. Because every job writes to a disjoint slot, there's no shared mutable state between jobs — nothing to lock. The only synchronization that matters is the `join` inside `shutdown`: a thread's writes *happen-before* the join that observes its exit, so once `shutdown` returns, every slot is fully written and visible, and the main thread reads them all back lock-free. The lesson that took me longest to internalize: **a `join` is a synchronization point, not just a "wait" — it publishes everything the joined thread did.** Disjoint slots plus one join at the end beats a mutex-guarded result map, and it's simpler.

There's also a deliberate *two-channel* error model. A file that won't open or read isn't a pool failure — it's recorded in that file's own slot (`result.err`) and the job returns normally, so one unreadable file never aborts the batch. The pool's `first_error` is reserved for genuinely unexpected job failures. So per-file problems print to stderr afterward while the pool's error channel stays clean:

```zig
for (paths.items, results) |p, r| {
    if (r.err) |e| try err.print("{s}: {s}\n", .{ p, @errorName(e) })
    else try out.print("{s}  {s}\n", .{ std.fmt.bytesToHex(r.digest, .lower), p });
}
```

Output is in *collection* order, not completion order — the parallelism speeds up the work without scrambling the report. The test builds a small tree on disk (with a subdirectory and an empty file), runs the pipeline, and checks each file's line against the *serial* `hashReaders` reference — proving the parallel path computes byte-identical digests to the single-threaded one. And `std.testing.allocator` over the whole thing means the pool, the queue, the path list, and the result array all came back clean: concurrency that leaks is just a slower way to be wrong.

## Sprint 6, done — fundamentals complete

That's concurrency: a mutex counter and an atomic one with a real reason to pick between them, a blocking queue whose hard parts are the `while`-loop wait and the `broadcast`-on-close, a worker pool that shuts down by closing-then-joining and routes both first-errors and per-item errors back to the caller, and a parallel pipeline that gets away with zero locks on its results because a `join` already orders everything. The recurring lesson is that the interesting code is all in the *ending* — spawning threads is one line; making them stop cleanly, surrender their results, and report what went wrong is the entire craft. With this, the fundamentals are complete: I/O, allocators, data structures, algorithms, systems, and threads. Next the project changes shape entirely — the capstone, `zcage`, a tiny container runtime where every one of these sprints becomes load-bearing at once.
