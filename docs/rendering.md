# Rendering Architecture & Performance Guidelines

> Rules governing the rendering pipeline, GPU resource management, and frame execution.

---

# Purpose

The renderer is the heart of the application.

Every rendering change must preserve:

* correctness
* determinism
* scalability
* maintainability
* performance

A renderer that is difficult to reason about is considered a bug, even if it produces the correct image.

---

# Rendering Philosophy

Rendering should be viewed as a data pipeline.

Each frame transforms data through a series of deterministic stages.

The pipeline should never rely on hidden state or implicit side effects.

A frame should always be reproducible from the same inputs.

---

# Core Principles

Prioritize, in order:

1. Correctness
2. Stable frame time
3. Predictable memory usage
4. Low CPU overhead
5. Low GPU overhead
6. Maximum throughput

Peak FPS is less important than stable frame pacing.

---

# Renderer Responsibilities

The renderer is responsible only for:

* submitting GPU work
* managing GPU resources
* coordinating rendering passes
* presenting the final image

It should not contain business logic.

It should not own application state.

It should not perform unrelated computations.

---

# Separation of Responsibilities

Each subsystem should have a single responsibility.

Examples:

StreamingScheduler

→ decides what should be loaded

VisibilityManager

→ decides what should be visible

PointBudgetController

→ decides how many points may be rendered

Renderer

→ renders visible nodes

Cache

→ owns cached resources

Avoid overlapping responsibilities.

---

# Frame Pipeline

Each frame should follow a deterministic order.

Example:

1. Update camera
2. Update streaming priorities
3. Process completed loading jobs
4. Update visibility
5. Compute LOD
6. Enforce point budget
7. Upload pending GPU resources
8. Execute rendering passes
9. Present frame

Avoid changing execution order without understanding downstream effects.

---

# Frame Determinism

Rendering should not depend on random execution order.

Avoid:

* unordered iteration
* non-deterministic scheduling
* implicit mutations

The same scene should produce the same frame.

---

# GPU Resource Ownership

Every GPU object must have a clear owner.

Examples:

* vertex buffers
* index buffers
* textures
* framebuffers
* render targets
* shader programs

Ownership must be explicit.

Avoid shared mutable ownership.

---

# GPU Lifetime

Each GPU resource should follow a predictable lifecycle.

Allocate

↓

Upload

↓

Use

↓

Reuse

↓

Dispose

Never leak GPU resources.

---

# Buffer Management

Buffers should be reused whenever possible.

Avoid:

* allocating every frame
* recreating VBOs
* unnecessary uploads
* duplicate vertex buffers

Reuse is preferable to recreation.

---

# Upload Strategy

GPU uploads are expensive.

Batch uploads whenever practical.

Avoid uploading identical data twice.

Only upload data that has changed.

---

# Render Passes

Each render pass should have one responsibility.

Examples:

Geometry Pass

EDL Pass

Picking Pass

Debug Pass

UI Pass

Avoid passes that perform unrelated work.

---

# Draw Calls

Minimize draw calls.

Strategies include:

* batching
* instancing
* indirect drawing (where supported)
* reducing state changes

Never increase draw calls without measurable benefit.

---

# State Changes

GPU state changes are expensive.

Minimize:

* shader switches
* framebuffer changes
* texture bindings
* blend mode changes
* depth state changes

Group similar work together.

---

# Shader Guidelines

Shaders should remain:

* modular
* readable
* reusable

Avoid duplicating shader logic.

Prefer parameterization over copy-paste.

---

# Uniform Management

Uniforms should be updated only when necessary.

Avoid setting identical values every frame.

Cache frequently used state.

---

# Point Clouds

Point cloud rendering must remain scalable.

Rendering cost should scale primarily with:

* point budget
* visible nodes
* screen coverage

Not with total dataset size.

---

# Level of Detail

LOD selection must occur before rendering.

The renderer should receive only the nodes selected for the current frame.

Rendering code should not decide visibility.

---

# Visibility

Visibility decisions belong outside the renderer.

The renderer consumes visibility results.

It does not compute them.

---

# Streaming Integration

Rendering must tolerate incomplete data.

Missing nodes are expected.

The renderer should gracefully display progressively refined content.

Never stall waiting for streaming.

---

# Memory Budget

CPU memory and GPU memory should have configurable limits.

Rendering should degrade gracefully when limits are reached.

Never assume unlimited memory.

---

# CPU Work

Avoid expensive per-frame CPU work.

Examples:

Avoid:

* rebuilding arrays
* repeated sorting
* repeated allocations
* repeated object creation

Prefer:

* persistent structures
* incremental updates
* cached results

---

# Allocation Rules

Inside the render loop:

Avoid:

new Array()

new Map()

new Set()

temporary objects

temporary closures

Allocate once.

Reuse many times.

---

# Typed Arrays

Prefer typed arrays for numerical data.

Examples:

Float32Array

Uint32Array

Uint16Array

Typed arrays improve cache locality and reduce GC pressure.

---

# Garbage Collection

Large garbage collection pauses negatively affect frame pacing.

Avoid creating garbage during rendering.

Aim for allocation-free render loops.

---

# Cache Locality

Store related data together.

Avoid fragmented memory layouts.

Sequential memory access is preferred.

---

# Asynchronous Work

I/O

Decoding

Decompression

Parsing

should occur outside the render thread whenever possible.

Rendering should never block on asynchronous operations.

---

# Error Handling

Rendering failures should be recoverable where possible.

A failed node upload should not crash the renderer.

Log failures with sufficient context.

---

# Debug Features

Debug rendering should remain isolated.

Examples:

Bounding boxes

Node IDs

LOD visualization

Wireframe

Performance overlays

Debug features should never affect release performance when disabled.

---

# Instrumentation

The renderer should expose measurable statistics.

Examples:

Frame time

Visible nodes

Visible points

GPU uploads

CPU memory

GPU memory

Cache hit rate

Streaming queue length

Draw calls

Triangles

Points rendered

Performance should be observable.

---

# Optimization Strategy

Before optimizing:

Measure.

Profile.

Understand.

Then optimize.

Never optimize based on intuition alone.

---

# Architectural Invariants

These rules must always remain true.

* Rendering never blocks on I/O.
* Rendering never computes visibility.
* Rendering never decides LOD.
* Rendering never owns streaming.
* Rendering consumes prepared data.
* GPU resources have explicit ownership.
* Uploads are incremental.
* Resource lifetime is deterministic.
* Every frame follows the same execution pipeline.

Breaking these invariants requires a documented architectural justification.

---

# Self Review Checklist

Before completing any rendering-related change, verify:

* No unnecessary allocations.
* No duplicated GPU resources.
* No redundant uploads.
* No unnecessary state changes.
* No render-thread blocking.
* Stable frame pipeline preserved.
* Visibility handled externally.
* LOD handled externally.
* Memory ownership documented.
* Resource cleanup implemented.
* Performance impact evaluated.
* Code remains readable.

---

# Final Principle

A great renderer is not the one that draws the most frames per second.

A great renderer is predictable, deterministic, scalable, and easy to evolve.

Every optimization must preserve these qualities.
