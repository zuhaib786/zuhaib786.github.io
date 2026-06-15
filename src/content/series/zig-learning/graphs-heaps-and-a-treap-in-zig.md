---
title: "Graphs, a Min-Heap, and a Treap: Where It All Converges"
description: "Finishing Sprint 4 — a binary min-heap on a dynamic array, an adjacency-list graph with BFS/DFS/topological-sort/Dijkstra that reuses the ring buffer and heap, a text-loading graph subcommand, and a treap that balances a BST with randomness."
date: 2026-06-15
order: 7
tags: ["Zig", "Algorithms", "Data Structures", "Graphs"]
---
The [last post](/series/zig-learning/algorithms-and-a-bst-in-zig) closed out the searching, sorting, and the plain BST, and left graphs as the one thing still ahead. This finishes the algorithms sprint — and it's the post I'd been looking forward to, because graphs are where the pieces from every earlier sprint snap together. BFS runs on the [ring buffer](/series/zig-learning/data-structures-in-zig). Dijkstra runs on a min-heap I had to build first. The `graph` subcommand loads its input through the [arena](/series/zig-learning/arena-allocators-in-zig). Almost nothing here is a brand-new primitive; it's the older primitives finally interlocking. Then a treap as a bonus, because randomness turning a BST balanced is too neat to skip.

## A binary heap on top of a dynamic array

Dijkstra needs a priority queue, so the heap came first. A binary min-heap is the classic trick of storing a complete binary tree *as a flat array* — no nodes, no pointers, just index arithmetic. Mine is literally a wrapper around an `ArrayList`:

```zig
pub fn MinHeap(comptime T: type) type {
    return struct {
        const Self = @This();
        list: ArrayList(T),
        alloctor: Allocator,
        lessThan: *const fn (T, T) bool,
        // ...
    };
}
```

The parent of index `i` is `(i - 1) / 2`; its children are `2*i + 1` and `2*i + 2`. That's the whole data structure — the tree shape is implied by position. Two sift operations keep the min-heap invariant (every parent ≤ its children):

```zig
fn bubbleUp(self: *Self, index: usize) void {
    var i = index;
    while (i > 0) {
        const p = (i - 1) / 2;
        if (!self.lessThan(self.list.items[i], self.list.items[p])) break;
        std.mem.swap(T, &self.list.items[p], &self.list.items[i]);
        i = p;
    }
}
```

`insert` appends to the end and bubbles up; `pop` is the cute one — swap the root with the last element, drop the last (now the old min), and bubble the new root down:

```zig
pub fn pop(self: *Self) ?T {
    const n = self.len();
    if (n == 0) return null;
    const ans = self.list.items[0];
    if (n > 1) std.mem.swap(T, &self.list.items[0], &self.list.items[n - 1]);
    _ = self.list.pop();
    self.bubbleDown(0);
    return ans;
}
```

Building on `ArrayList` means growth, capacity, and freeing are already handled — `deinit` just forwards to the list. The `lessThan` is a stored runtime function pointer (same choice as the BST), so the heap orders whatever you give it. The discriminating test inserts a shuffled `0..9` and pops everything: out comes ascending order, which is heap-sort, and which exercises both sifts. The last test orders `{ d, node }` structs by `d` — a dry run for exactly how Dijkstra will use it.

## The graph: a slice of dynamic arrays

The graph is an adjacency list, and in Zig that's a *slice of `ArrayList`s* — one edge-list per node:

```zig
pub const Graph = struct {
    const Edge = struct { to: usize, w: u32 };
    adj: []ArrayList(Edge),
    allocator: Allocator,

    pub fn init(allocator: Allocator, n: usize) !Self {
        const graph: Self = .{ .allocator = allocator, .adj = try allocator.alloc(ArrayList(Edge), n) };
        for (graph.adj) |*list| list.* = .empty;
        return graph;
    }

    pub fn deinit(self: *Self) void {
        for (self.adj) |*list| list.deinit(self.allocator);
        self.allocator.free(self.adj);
    }
};
```

This is the nested-ownership lesson from the allocator posts made concrete: `init` allocates the outer slice and initializes each inner list to `.empty`; `deinit` has to free every inner list *first*, then the outer slice. Two levels, freed inside-out. `addEdge` just appends to one node's list — and because it's a directed list of weighted edges, an undirected or unweighted graph is a convention on top, not a different type.

## BFS and DFS: the ring buffer earns its place

Breadth-first search is the moment the [Sprint 3 ring buffer](/series/zig-learning/data-structures-in-zig) pays for itself. BFS needs a FIFO queue, and since every node is enqueued at most once, a fixed-capacity ring buffer sized to the node count is exactly right — no growth needed:

```zig
pub fn bfs(self: *Self, start: usize) ![]usize {
    var order: ArrayList(usize) = .empty;
    errdefer order.deinit(self.allocator);
    var visited: []bool = try self.allocator.alloc(bool, self.adj.len);
    defer self.allocator.free(visited);
    for (0..self.adj.len) |i| visited[i] = false;

    var q: queue.RingBuffer(usize) = try .init(self.allocator, self.adj.len);
    defer q.deinit(self.allocator);
    try q.eneque(start);
    visited[start] = true;
    while (q.deque()) |u| {
        for (self.adj[u].items) |e| {
            if (!visited[e.to]) {
                visited[e.to] = true;
                try order.append(self.allocator, e.to);
                try q.eneque(e.to);
            }
        }
    }
    return try order.toOwnedSlice(self.allocator);
}
```

Notice the cleanup choreography, all of it habits from earlier sprints: `defer` frees the scratch `visited` array and the queue, `errdefer` drops the result list if an append fails partway, and `toOwnedSlice` hands the finished order to the caller. The function returns owned memory; the doc comment says so; the test frees it. DFS is the recursive counterpart and doesn't even need its own allocation — the caller passes in the `visited` array, and recursion is the stack. The tests confirm the two things that actually matter: BFS/DFS visit exactly the reachable set (a disconnected component stays untouched), and DFS terminates on a cycle instead of looping forever.

## Topological sort is Kahn's algorithm — and a cycle detector

Topological sort reuses the same queue, but with a twist that doubles as cycle detection. Kahn's algorithm tracks each node's in-degree, seeds the queue with the zero-in-degree nodes, and peels them off, decrementing neighbors as it goes:

```zig
for (0..n) |u| {
    for (self.adj[u].items) |e| indeg[e.to] += 1;
}
for (0..n) |i| if (indeg[i] == 0) try q.eneque(i);
while (q.deque()) |u| {
    try order.append(self.allocator, u);
    for (self.adj[u].items) |e| {
        indeg[e.to] -= 1;
        if (indeg[e.to] == 0) try q.eneque(e.to);
    }
}
for (0..n) |i| {
    if (indeg[i] != 0) return error.CycleError;
}
```

The elegant part is the ending: if the graph has a cycle, the nodes in it never reach in-degree zero, so they never get queued, and at the end their in-degree is still nonzero. That leftover *is* the cycle, surfaced as `error.CycleError` through the function's error union. The tests check a valid order respects every edge (`pos[u] < pos[v]` for each `u→v`, since topological orders aren't unique), that it spans disconnected DAGs, and that a 3-cycle is rejected.

## Dijkstra: the heap was the whole point

And here's the convergence. Dijkstra is shortest-paths on a weighted graph, and its frontier is a priority queue keyed by tentative distance — which is precisely the `{ d, u }`-ordered-by-`d` min-heap I built at the top:

```zig
pub fn dijikstra(self: *Self, src: usize) ![]u64 {
    var distances: []u64 = try self.allocator.alloc(u64, n);
    for (0..n) |i| distances[i] = INF;
    distances[src] = 0;
    const data = struct { d: u64, u: usize };
    const lessThan = struct {
        fn less(a: data, b: data) bool { return a.d < b.d; }
    }.less;
    var pq: Heap(data) = .init(self.allocator, &lessThan);
    defer pq.deinit();
    try pq.insert(.{ .d = 0, .u = src });
    while (pq.pop()) |d| {
        const u = d.u;
        if (d.d > distances[u]) continue;   // stale entry — already found shorter
        for (self.adj[u].items) |e| {
            if (distances[e.to] > d.d + e.w) {
                distances[e.to] = d.d + e.w;
                try pq.insert(.{ .d = d.d + e.w, .u = e.to });
            }
        }
    }
    return distances;
}
```

The one idiom worth calling out is `if (d.d > distances[u]) continue`. A real binary heap can't *decrease-key* a node already inside it, so instead of updating in place, I just push a fresh `{ d, u }` whenever I find a shorter route and let the old, larger entry rot in the heap. When a stale entry eventually pops, its distance is worse than the best already recorded, so I skip it. Lazy deletion — far simpler than a decrease-key heap and the standard way to do this. Unreachable nodes keep their `INF`, which the tests pin down alongside a non-zero source (the classic "did you hardcode 0?" trap) and a node reachable two ways where the heap must surface the cheaper route first.

## Loading a graph from a file

The deliverable was a `graph` subcommand: `lzig graph <algo> <file> [source]`. The file format is a header line with the node count, then `u v [w]` edges (weight defaults to 1), and `parseGraph` tokenizes it with the validation reflexes from the `freq` work — rejecting out-of-range nodes and malformed edges with named errors. The handler wires it together with the arena pattern from Sprint 2:

```zig
var arena: std.heap.ArenaAllocator = .init(gpa);
defer arena.deinit();
const allocator = arena.allocator();
const text = try reader.allocRemaining(allocator, .unlimited);
var graph = try graphlib.parseGraph(allocator, text);
switch (algo) {
    .bfs => try performBfs(&graph, args, out),
    .dfs => try performDfs(&graph, args, out),
    .dijikstra => try performDijikstra(&graph, args, out),
    .topo => try performTopo(&graph, out, err),
}
```

One arena holds the slurped text, the parsed graph, every adjacency list, and each algorithm's scratch and result. None of it is freed by hand — `arena.deinit()` drops the whole command's allocations at once, which is exactly the bounded-lifetime shape arenas are for. The earlier sprints didn't just teach techniques; they're load-bearing here.

## A treap: balancing a BST with randomness

The plain BST from last post has a weakness — feed it sorted input and it degenerates into a linked list, O(n) per operation. A **treap** fixes that with a genuinely clever idea: be a binary search **tree** by value *and* a **heap** by a random priority, simultaneously. Each node gets a random priority on creation:

```zig
const Node = struct { value: T, left: ?*Node, right: ?*Node, priority: u64 };
// in makeNode:
node.priority = self.prng.random().int(u64);
```

The values obey the BST ordering (left < node < right), while the priorities obey a max-heap ordering (parent > children). After a normal recursive insert, if a child ends up with a higher priority than its parent, a rotation lifts it:

```zig
fn _insert(self: *Self, value: T, node: ?*Node) !*Node {
    var n = node orelse try self.makeNode(value);
    if (self.lessThan(value, n.value)) {
        n.left = try self._insert(value, n.left);
        if (n.left.?.priority > n.priority) n = rotateRight(n);
    } else if (self.lessThan(n.value, value)) {
        n.right = try self._insert(value, n.right);
        if (n.right.?.priority > n.priority) n = rotateLeft(n);
    }
    return n;
}
```

`rotateLeft`/`rotateRight` are the standard tree pivots — they rearrange three pointers while preserving the in-order sequence. The magic is what the priorities buy you: because they're random, the tree's *shape* is the shape you'd get from inserting in random order, which is balanced in expectation. The height stays ~O(log n) **without any explicit balance logic** — no AVL bookkeeping, no red-black colors, just "respect a random heap priority and rotate when it's violated." Deletion uses the same trick in reverse: rotate the higher-priority child up until the target node becomes a leaf, then snip it. It's the same `insert`/`delete`/`inOrder`/`min`/`max` surface as the BST, with rotations threaded in — the in-order traversal still comes out sorted, so every BST test passes unchanged.

## Sprint 4, done

That's the algorithms sprint complete: binary search, three sorts, a BST, a min-heap, four graph algorithms, and a treap — all generic, all tested against hand-worked expectations or the standard library. The lasting impression is how much of it was *assembly*. The heap is an `ArrayList` plus index math; BFS is the ring buffer plus a visited set; Dijkstra is the heap plus a relaxation loop; the subcommand is the arena plus a parser. Build the primitives well in the early sprints and the later "hard" algorithms turn out to be short. Next up is Sprint 5 — systems programming: a directory walker, checksums, and a tiny binary file format.
