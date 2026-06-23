# Potree Integration Guidelines

> Rules for integrating, extending, and maintaining Potree-based functionality.

---

# Purpose

Potree is the project's primary reference implementation for rendering massive point clouds.

The objective is **not** to rewrite Potree.

The objective is to **understand, adapt, and integrate** its proven architecture into this project while preserving the project's own structure.

Whenever Potree already provides a mature solution, prefer adapting that solution over designing a new one.

---

# Guiding Principles

Always prioritize:

1. Reuse
2. Adaptation
3. Compatibility
4. Maintainability
5. Performance

Never rewrite a proven algorithm without a measurable benefit.

---

# Potree Is the Reference

When implementing any point cloud feature, first determine whether Potree already solves the problem.

Examples include:

* octree traversal
* streaming
* point budget
* visibility
* LOD
* hierarchy loading
* node scheduling
* GPU upload
* shaders
* picking
* Eye Dome Lighting
* clipping
* classifications
* measurements

If Potree already implements the feature correctly:

* study it
* understand it
* adapt it

Do not create an independent implementation unless there is a documented technical reason.

---

# Understand Before Porting

Never copy code blindly.

Before adapting any subsystem:

* understand its inputs
* understand its outputs
* understand its invariants
* understand why the algorithm exists
* identify project-specific assumptions

The goal is architectural compatibility, not mechanical translation.

---

# Preserve Project Architecture

Potree should integrate into the existing architecture.

Avoid forcing the project to imitate Potree's directory layout or class hierarchy.

Prefer:

* adapters
* wrappers
* composition
* dependency injection

instead of invasive rewrites.

---

# One Source of Truth

Every concept should have a single implementation.

Examples:

* one visibility algorithm
* one streaming scheduler
* one point budget implementation
* one node cache
* one renderer

Never maintain competing implementations.

---

# Supported Features

The implementation should support, where applicable:

* metadata.json
* hierarchy.bin
* octree.bin
* LAZ/LAS conversion pipeline
* RGB colors
* intensity
* classification
* return number
* source ID
* elevation coloring
* adaptive point size

Future features should extend these systems rather than replace them.

---

# Octree

The octree is the core data structure.

Do not replace it with an alternative hierarchy unless explicitly requested.

Each node should own only the information necessary for:

* hierarchy
* bounds
* loading state
* GPU state
* visibility state

Avoid mixing rendering logic into the octree itself.

---

# Node Lifecycle

Every node should move through well-defined states.

Example:

Unloaded

↓

Requested

↓

Loading

↓

Decoded

↓

GPU Uploaded

↓

Visible

↓

Cached

↓

Evicted

Transitions should be explicit and deterministic.

---

# Streaming

Streaming must always be progressive.

Requirements:

* asynchronous
* incremental
* interruptible
* prioritised
* memory aware

Never load the entire dataset before rendering.

The user should see progressively improving quality.

---

# Point Budget

Point budget controls rendering cost.

Never exceed the configured budget.

When the budget is exceeded:

* reduce visible nodes
* lower LOD
* prioritize important nodes

Never reduce frame rate by ignoring the point budget.

---

# LOD

LOD decisions should consider:

* projected screen size
* camera distance
* node depth
* visibility
* traversal priority

Avoid distance-only heuristics.

LOD should remain stable during camera movement to avoid visual popping.

---

# Visibility

Visibility determination should include:

* frustum culling
* hierarchical culling
* node priority
* traversal order

Invisible nodes should not consume rendering resources.

---

# Scheduler

Loading requests should be prioritised.

Priority factors include:

* visible first
* closest first
* largest projected size
* camera direction
* current LOD requirements

The scheduler should remain deterministic.

---

# GPU Upload

Uploading data to the GPU is expensive.

Batch uploads whenever practical.

Avoid:

* repeated allocations
* duplicate buffers
* unnecessary uploads

Reuse GPU resources whenever possible.

---

# Cache

Caching should exist at multiple levels.

Examples:

CPU cache

GPU cache

Decoded node cache

Request cache

Recently visible node cache

Use LRU or another documented eviction policy.

---

# Memory Management

Large point clouds require predictable memory usage.

Memory should have configurable limits.

When limits are reached:

* evict least valuable nodes
* preserve visible nodes
* avoid sudden spikes

Never rely solely on garbage collection.

---

# Shaders

Reuse Potree shader concepts where appropriate.

Supported rendering modes should include:

* RGB
* elevation
* intensity
* classification
* source ID
* return number
* adaptive point size

Avoid shader duplication.

---

# Eye Dome Lighting

Eye Dome Lighting should remain a rendering feature.

Its implementation should not leak into unrelated systems.

EDL must be optional.

---

# Picking

Picking should remain independent from rendering.

Requirements:

* deterministic
* accurate
* non-destructive

Avoid coupling picking logic with scene updates.

---

# Camera Independence

Streaming, LOD, and visibility should depend on camera state.

Camera implementations should remain replaceable.

Avoid embedding camera-specific logic inside rendering systems.

---

# Threading

Loading and decoding should occur outside the rendering thread whenever possible.

Rendering must never stall because of I/O.

---

# Performance

Always profile before rewriting an algorithm.

Prefer improving scheduling over increasing complexity.

Avoid micro-optimisations that reduce readability.

---

# Naming

Use descriptive names.

Examples:

PointCloudNode

VisibilityManager

StreamingScheduler

PointBudgetController

NodeCache

Avoid generic names such as:

Manager

Helper

Util

System2

NewRenderer

---

# Extensibility

Every subsystem should support future features.

Examples:

* compression
* alternative storage backends
* cloud streaming
* WebGPU
* multi-cloud rendering

Design interfaces that can evolve without breaking existing implementations.

---

# Documentation

Whenever adapting a Potree algorithm, document:

* original purpose
* project-specific changes
* reasons for modifications
* expected behaviour
* known limitations

Future contributors should understand why the implementation differs from upstream.

---

# Validation Checklist

Before completing any Potree-related change, verify:

* Existing implementation studied.
* No duplicated subsystem introduced.
* Project architecture respected.
* Streaming remains progressive.
* Point budget enforced.
* LOD remains stable.
* Scheduler deterministic.
* GPU uploads minimized.
* Cache policy documented.
* Memory usage bounded.
* Public APIs preserved.
* Performance impact evaluated.

---

# Final Principle

Potree has solved many hard problems over years of development.

Treat it as a mature engineering reference, not as code to rewrite.

Every deviation from Potree's proven design must have a clear, documented, and measurable technical justification.
