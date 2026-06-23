# Architecture Guidelines

> Architectural principles, invariants, and design rules for the entire project.

---

# Purpose

Architecture exists to reduce complexity.

Every implementation decision should make the project easier to understand, extend, and maintain.

The architecture should naturally guide development rather than restrict it.

When in doubt, preserve architectural integrity over introducing new features.

---

# Architectural Philosophy

The system should evolve organically.

Avoid revolutionary changes.

Prefer evolutionary improvements.

Every change should make the architecture more coherent than before.

---

# Core Principles

Every subsystem must maximize:

* Cohesion
* Separation of concerns
* Predictability
* Explicit ownership
* Composability
* Testability

Every subsystem should minimize:

* Coupling
* Hidden dependencies
* Shared mutable state
* Side effects
* Global knowledge

---

# Single Responsibility

Each module should have one clear purpose.

Examples:

StreamingScheduler

→ decides loading order

VisibilityManager

→ determines visibility

Renderer

→ renders

NodeCache

→ manages cached nodes

PointBudgetController

→ limits rendering cost

Avoid classes that perform multiple unrelated tasks.

---

# Explicit Ownership

Every resource must have a clearly defined owner.

Examples:

GPU Buffers

CPU Memory

Octree Nodes

Streaming Requests

Textures

Shader Programs

Ownership should never be ambiguous.

---

# Dependency Direction

Dependencies should always point toward lower-level abstractions.

Avoid circular dependencies.

Avoid mutual knowledge between subsystems.

Higher-level systems coordinate.

Lower-level systems execute.

---

# Composition Over Inheritance

Prefer composition whenever practical.

Inheritance should represent a true "is-a" relationship.

Do not inherit merely to reuse code.

Favor small reusable components.

---

# Stable Interfaces

Public interfaces should change rarely.

Internal implementations may evolve.

External behavior should remain stable.

Preserve backward compatibility whenever possible.

---

# Information Hiding

Each subsystem should expose only what is necessary.

Internal implementation details should remain private.

Reduce surface area.

Smaller APIs are easier to maintain.

---

# Separation of Concerns

Each concern belongs to exactly one subsystem.

Examples:

Loading

Scheduling

Visibility

LOD

Rendering

Picking

Caching

Configuration

Avoid mixing responsibilities.

---

# One Source of Truth

Every concept should exist only once.

Examples:

Visibility

Point Budget

Streaming Queue

Camera State

Renderer State

Cache Policy

Never maintain multiple competing implementations.

---

# Layered Architecture

The system should follow clear layers.

Application

↓

Controllers

↓

Managers

↓

Core Algorithms

↓

Rendering

↓

GPU

Lower layers should not depend on higher layers.

---

# Data Flow

Data should move in one direction whenever possible.

Input

↓

Processing

↓

Scheduling

↓

Rendering

↓

Presentation

Avoid cyclic data flow.

---

# Lifecycle Management

Every object should have a predictable lifecycle.

Create

↓

Initialize

↓

Use

↓

Update

↓

Dispose

Objects should never remain in undefined states.

---

# Deterministic Behavior

Given identical inputs:

The application should produce identical outputs.

Avoid hidden randomness.

Avoid implicit state changes.

Avoid order-dependent behavior.

---

# Extensibility

New functionality should extend the architecture.

It should not require rewriting existing systems.

Prefer extension points.

Avoid modifying stable code unnecessarily.

---

# Configuration

Behavior should be configurable.

Implementation should not depend on hardcoded values.

Configuration belongs in dedicated configuration modules.

---

# Error Boundaries

Failures should remain localized.

One failing subsystem should not destabilize unrelated systems.

Recover gracefully whenever practical.

---

# Asynchronous Systems

Asynchronous work should remain isolated.

Examples:

File Loading

Network Requests

LAZ Decoding

GPU Upload Preparation

Rendering should consume completed work.

Rendering should never own asynchronous operations.

---

# Memory Ownership

Every allocation should have:

One owner

One lifecycle

One disposal path

Avoid shared ownership.

Avoid implicit destruction.

---

# Cache Design

Caches exist to improve performance.

They should never become sources of truth.

Cached data should always be reproducible.

Eviction policies should be deterministic and documented.

---

# Renderer Isolation

Rendering is a consumer.

It should not decide:

LOD

Visibility

Scheduling

Streaming

Loading

The renderer renders.

Nothing more.

---

# Streaming Isolation

Streaming decides:

What loads

When it loads

What unloads

Rendering should never influence loading decisions directly.

---

# LOD Isolation

LOD determines geometric detail.

It should not upload buffers.

It should not render.

It should not load files.

Each subsystem performs one job.

---

# Visibility Isolation

Visibility determines:

Visible

Invisible

Priority

Traversal

It should not modify rendering resources.

---

# Communication Between Systems

Subsystems should communicate through explicit interfaces.

Avoid direct manipulation of internal state.

Prefer messages, events, or well-defined APIs.

---

# Coupling Rules

High cohesion.

Low coupling.

If changing one subsystem requires modifying many unrelated systems, the architecture is degrading.

---

# Complexity Budget

Every new abstraction introduces complexity.

Before creating one ask:

Does it reduce overall complexity?

Can an existing abstraction solve the problem?

Would a new contributor understand this immediately?

Avoid unnecessary abstraction layers.

---

# Architectural Invariants

The following must always remain true:

Rendering never blocks.

Streaming is asynchronous.

LOD is deterministic.

Visibility is deterministic.

Point Budget is enforced.

Memory ownership is explicit.

GPU resources are disposable.

Public APIs remain stable.

Subsystems have clear responsibilities.

No duplicated algorithms exist.

Breaking these invariants requires a documented architectural justification.

---

# Refactoring Policy

Refactor only when it measurably improves:

Readability

Maintainability

Performance

Correctness

Avoid refactoring solely for aesthetic reasons.

---

# Review Questions

Before merging any architectural change ask:

Does this simplify the system?

Does this reduce coupling?

Does this improve maintainability?

Does this preserve compatibility?

Can another engineer understand this quickly?

If any answer is "no", reconsider the design.

---

# Long-Term Thinking

Design every subsystem as if it will still exist five years from now.

Optimize for future maintainers rather than short-term convenience.

Temporary shortcuts become permanent technical debt.

---

# Final Principle

Architecture is the foundation of every future feature.

A feature can always be added later.

A degraded architecture becomes exponentially harder to repair.

Every change should leave the project structurally stronger than it was before.
