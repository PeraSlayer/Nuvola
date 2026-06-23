# Performance Engineering Guidelines

> Rules for writing high-performance, scalable, and maintainable code throughout the project.

---

# Purpose

Performance is a feature.

However, performance should never come at the expense of correctness or maintainability.

The objective is to build a renderer that scales to extremely large datasets while remaining predictable and easy to evolve.

Optimize only what matters.

---

# Performance Philosophy

The primary performance objective is **stable frame time**, not maximum FPS.

A renderer that maintains a consistent 60 FPS is preferable to one that fluctuates between 30 and 120 FPS.

Favor deterministic performance over benchmark peaks.

---

# Performance Priorities

Always optimize in this order:

1. Algorithmic complexity
2. Memory access patterns
3. Allocation behavior
4. GPU workload
5. CPU workload
6. Micro-optimizations

Never optimize syntax before optimizing algorithms.

---

# Measure Before Optimizing

Never optimize based on intuition.

Before changing performance-critical code:

* identify the bottleneck
* profile execution
* estimate expected improvement
* verify results after implementation

Assumptions are not measurements.

---

# Complexity

Prefer better algorithms over faster implementations of poor algorithms.

Examples:

Good

O(n log n)

Better than

O(n²)

regardless of implementation language.

Always evaluate algorithmic complexity first.

---

# Memory Access

Modern CPUs are limited more by memory bandwidth than arithmetic performance.

Favor:

* sequential access
* contiguous memory
* cache-friendly layouts

Avoid random memory access whenever practical.

---

# Data Locality

Store related data together.

Avoid fragmented object graphs.

Prefer structures that improve cache locality.

Access memory sequentially whenever possible.

---

# Allocation Rules

Memory allocation is expensive.

Inside performance-critical code:

Avoid:

new Array()

new Map()

new Set()

new Object()

temporary closures

temporary lambdas

temporary vectors

Allocate once.

Reuse many times.

---

# Render Loop

The render loop should ideally perform zero heap allocations.

Every frame should reuse existing memory whenever possible.

Garbage collection pauses reduce frame stability.

---

# Garbage Collection

Minimize GC pressure.

Prefer:

* object pools
* reusable buffers
* typed arrays
* persistent collections

Avoid creating thousands of temporary objects every frame.

---

# Typed Arrays

Use typed arrays for numerical data.

Examples:

Float32Array

Uint8Array

Uint16Array

Uint32Array

Int32Array

Typed arrays improve:

* memory locality
* predictable layout
* GPU compatibility

---

# Object Pools

Frequently created objects should be pooled.

Examples:

Nodes

Requests

Temporary vectors

Bounding boxes

Matrices

Queues

Pools reduce allocation overhead.

---

# Buffer Pools

GPU buffers should be reused.

Avoid recreating:

Vertex Buffers

Index Buffers

Textures

Framebuffers

Allocate once.

Update incrementally.

---

# CPU Performance

CPU time should primarily be spent on:

Visibility

Scheduling

LOD

Minimal state updates

Avoid expensive repeated computations.

Cache derived values whenever practical.

---

# GPU Performance

The GPU should spend time rendering.

Not waiting.

Not re-uploading.

Not changing state unnecessarily.

Minimize:

Shader switches

Texture bindings

Framebuffer changes

Uniform updates

Draw calls

---

# Draw Calls

Reduce draw calls whenever possible.

Strategies include:

Batching

Instancing

Indirect rendering

State sorting

Avoid splitting work unnecessarily.

---

# GPU Uploads

Uploading data is expensive.

Only upload:

New data

Modified data

Never upload identical buffers twice.

Reuse GPU memory.

---

# Incremental Updates

Prefer incremental work.

Instead of rebuilding everything:

Update only what changed.

Examples:

Visibility

LOD

Streaming queues

GPU buffers

Caches

Incremental systems scale significantly better.

---

# Streaming Performance

Streaming should remain asynchronous.

Loading should never block rendering.

Prefer:

Background loading

Incremental decoding

Prioritized requests

Request batching

Streaming should improve visual quality progressively.

---

# Visibility

Invisible nodes should consume almost no CPU or GPU resources.

Avoid processing data that cannot contribute to the final image.

Cull as early as possible.

---

# LOD

LOD should reduce work.

Never introduce LOD systems that increase total rendering cost.

The purpose of LOD is to decrease:

Rendered points

GPU bandwidth

CPU work

Memory usage

---

# Point Budget

The point budget is a hard limit.

Never exceed it.

Reducing visual fidelity is preferable to dropping frame rate.

The renderer should degrade gracefully under load.

---

# Caching

Caching should reduce repeated work.

Do not cache values that are inexpensive to recompute.

Cache only:

Expensive computations

Decoded nodes

GPU resources

Traversal results

Frequently accessed metadata

Every cache must have:

Ownership

Size limits

Eviction policy

---

# Branch Prediction

Avoid deeply nested branching in performance-critical code.

Prefer predictable execution paths.

Simplify hot loops whenever practical.

---

# Sorting

Sorting is expensive.

Avoid sorting every frame.

Sort only when necessary.

Reuse previous ordering whenever possible.

---

# Parallelism

Background threads should perform:

Loading

Decoding

Parsing

Decompression

The render thread should remain focused on rendering.

Avoid synchronization points inside the render loop.

---

# Synchronization

Locks are expensive.

Minimize lock contention.

Prefer:

Immutable data

Double buffering

Message passing

Atomic operations where appropriate

Avoid blocking threads unnecessarily.

---

# Temporary Objects

Avoid creating temporary:

Vectors

Matrices

Bounding boxes

Arrays

inside frequently executed code.

Reuse preallocated instances.

---

# Logging

Logging inside hot paths is forbidden.

Debug logging should be removable without affecting release performance.

---

# Exceptions

Exceptions should represent exceptional situations.

Do not use exceptions for control flow.

---

# Profiling

Useful metrics include:

Frame time

CPU frame time

GPU frame time

Visible nodes

Visible points

GPU uploads

CPU allocations

Memory usage

Cache hit rate

Streaming latency

Queue length

Performance should always be observable.

---

# Benchmarking

When comparing implementations:

Use identical datasets.

Use identical camera paths.

Use identical settings.

One variable should change at a time.

Avoid anecdotal performance claims.

---

# Premature Optimization

Do not optimize code that:

Runs rarely

Is not measurable

Does not affect frame time

Does not affect memory

Clarity is often more valuable than tiny speed improvements.

---

# Performance Review Checklist

Before completing any performance-sensitive change, verify:

* Algorithmic complexity evaluated.
* Profiling performed or reasoning documented.
* No unnecessary allocations.
* No duplicated work.
* Incremental updates preferred.
* Typed arrays used where appropriate.
* GPU uploads minimized.
* Draw calls not increased unnecessarily.
* Point budget respected.
* Visibility computed efficiently.
* Streaming remains asynchronous.
* Caches bounded and documented.
* Logging removed from hot paths.
* Memory ownership understood.

---

# Performance Anti-Patterns

Avoid:

* Per-frame allocations
* Rebuilding arrays every frame
* Re-uploading unchanged buffers
* Recomputing identical values
* Global mutable state
* Large monolithic update functions
* Blocking I/O on the render thread
* Excessive object creation
* Hidden quadratic algorithms
* Over-engineered optimizations without measurement

---

# Final Principle

The fastest code is often the code that **does less work**.

Prefer reducing work over accelerating unnecessary work.

A predictable, scalable renderer is more valuable than one optimized for isolated benchmarks.
