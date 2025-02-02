+++ 
draft = false
date = 2025-02-02T19:46:40+05:30
title = "Evaluating uvloop Performance for I/O Bound Workloads in Python"
description = ""
slug = ""
authors = []
tags = []
categories = []
externalLink = ""
series = []
+++
Writing `async` coroutines is a common approach for handling I/O-bound workloads in modern applications. Having worked extensively with Python's built-in `asyncio` module, I had always relied on its default event loop without considering alternatives. However, while working with the [vllm](https://github.com/vllm-project/vllm/blob/f256ebe4df6757d76f1f1642d7e110268a2f8190/vllm/entrypoints/openai/api_server.py#L909C1-L909C33) library, I encountered a scenario that led me to explore different event loops.

A quick search led me to a [blog post](https://magic.io/blog/uvloop-blazing-fast-python-networking/) discussing uvloop, a high-performance event loop for Python. The authors claim that uvloop is at least twice as fast as other Python asynchronous frameworks. However, their performance benchmarks primarily focus on handling thousands of parallel requests with minimal server-side processing, which may not reflect real-world workloads where some async coroutines involve CPU-intensive operations.

To determine whether uvloop provides meaningful performance gains in a more realistic workload, I conducted a benchmark comparing uvloop against the built-in asyncio event loop.

# Benchmarking Scenario
The following Python script benchmarks uvloop and the default asyncio event loop:

```python
# filename: benchmark.py


import time
import asyncio
import uvloop
from tqdm import tqdm

# Number of calls sent to the server
NUM_TASKS=1_000_000

async def call():
    # Some I/O bound work
    await asyncio.sleep(0.1)
    # Some CPU bound work
    return sum([i for i in range(1000)])

async def gather_call():
    requests = [call() for _ in range(NUM_TASKS)]
    [await f for f in tqdm(asyncio.as_completed(requests), total=len(requests))]
def benchmark(event_loop_policy):
    asyncio.set_event_loop_policy(event_loop_policy)
    loop = asyncio.get_event_loop()
    print(type(loop))
    asyncio.set_event_loop(loop)
    start_time = time.perf_counter()
    loop.run_until_complete(gather_call())
    end_time = time.perf_counter()
    loop.close()
    return end_time - start_time


if __name__=="__main__":
    builtin_loop_time = benchmark(asyncio.DefaultEventLoopPolicy())
    uvloop_time = benchmark(uvloop.EventLoopPolicy())
    print(f"Builtin asyncio loop: {builtin_loop_time:.4f} seconds")
    print(f"uvloop: {uvloop_time:.4f} seconds")
```

## Benchmark Results
### Mixed Workload (I/O + CPU Bound)
```
Builtin asyncio loop: 30.4653 seconds
uvloop: 25.1422 seconds
```
Performance improvement: ~18%

### Purely I/O Bound Workload (CPU-bound portion removed)
```
Builtin asyncio loop: 14.7855 seconds
uvloop: 10.5786 seconds
```
Performance improvement: ~30%
## Conclusion
While `uvloop` offers notable performance improvements for asynchronous Python programs, its benefits are most significant when the workload is highly I/O-bound. If an application involves substantial CPU-bound tasks, the performance gains may be less impactful. Given that `uvloop` is not part of the Python standard library, I would only consider switching if my application were predominantly I/O-bound and required high throughput

