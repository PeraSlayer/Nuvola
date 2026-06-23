# AGENTS.md

> Project-wide operating instructions for AI coding agents.

---

# Mission

Your primary objective is **not** to generate code.

Your primary objective is to **improve this codebase without reducing its quality, correctness, maintainability or performance**.

Every modification must move the project toward a cleaner architecture.

When uncertain, prefer making **no change** over making a potentially incorrect change.

---

# Core Principles

Always prioritize, in this exact order:

1. Correctness
2. Maintainability
3. Simplicity
4. Performance
5. Developer Experience
6. Features

Never sacrifice correctness for speed.

---

# Ground Truth

The source of truth is always:

1. Existing project architecture
2. Existing source code
3. Official documentation
4. Official APIs
5. Standards and specifications

Never assume undocumented behavior.

Never invent:

* APIs
* methods
* classes
* modules
* file paths
* package names
* configuration options

If something cannot be verified from the repository or official documentation, explicitly state the uncertainty instead of fabricating an answer.

---

# Repository First

Before writing code:

* inspect the project structure
* inspect related files
* inspect imports
* inspect exports
* inspect naming conventions
* inspect coding style
* inspect architecture

Do not implement anything until enough context has been gathered.

---

# Respect Existing Architecture

Do not redesign the project unless explicitly requested.

Prefer extending existing systems instead of replacing them.

Reuse existing:

* utilities
* managers
* helpers
* abstractions
* services
* renderers
* data structures

Avoid duplicate implementations.

---

# Incremental Development

Large refactors are forbidden unless explicitly requested.

Instead:

* make one logical change
* verify it
* continue

Every commit-sized modification should be independently understandable.

---

# Minimize Hallucinations

Before generating code, verify that:

* the file actually exists
* the symbol actually exists
* the function actually exists
* the dependency actually exists
* the API actually exists

Never write code based on assumptions.

If verification is impossible:

Stop.

Explain the uncertainty.

---

# Read Before Writing

Always read every related file before modifying one.

Understand:

* dependencies
* execution flow
* ownership
* lifecycle
* side effects

Do not modify code blindly.

---

# Preserve Public APIs

Avoid breaking:

* exported interfaces
* public methods
* serialized formats
* user workflows

Backward compatibility is preferred whenever practical.

---

# Root Cause First

Never patch symptoms.

Always identify the root cause.

Temporary fixes are discouraged unless explicitly requested.

---

# Avoid Clever Code

Prefer obvious code over clever code.

Readable code is more valuable than compact code.

---

# Naming

Names must describe intent.

Prefer:

* noun for objects
* verb for functions
* adjective for predicates

Examples:

Good

loadNode()

updateVisibility()

computeLOD()

Bad

doStuff()

temp()

manager2()

valueNew()

---

# Function Size

Functions should generally:

* perform one task
* have one responsibility
* be easy to test

Avoid deeply nested logic.

Extract helper functions when appropriate.

---

# File Organization

Files should contain related responsibilities only.

Avoid "god files".

Avoid unrelated utilities living together.

---

# Comments

Comments explain **why**, not **what**.

Bad:

// increment i

Good:

// Skip unloaded nodes to avoid blocking the streaming scheduler.

---

# Error Handling

Never silently ignore failures.

Prefer:

* explicit checks
* descriptive errors
* graceful recovery

Avoid empty catch blocks.

---

# Logging

Logs should help debugging.

Avoid noisy logging.

Avoid console.log spam.

Use consistent log levels.

---

# Performance

Never optimize prematurely.

Measure first.

Optimize second.

When optimizing:

* preserve readability
* preserve correctness
* explain trade-offs

---

# Memory

Avoid unnecessary allocations.

Reuse:

* arrays
* buffers
* objects

Release unused resources.

Avoid memory leaks.

---

# Dependencies

Before introducing a dependency ask:

Is it already implemented?

Can existing code solve the problem?

Can standard JavaScript solve it?

Prefer fewer dependencies.

---

# JavaScript Style

Use modern JavaScript.

Prefer:

* const
* let
* async/await
* modules
* descriptive names

Avoid outdated patterns.

Avoid global mutable state.

---

# Three.js

Follow existing Three.js conventions.

Never bypass renderer abstractions.

Reuse:

* geometries
* materials
* textures
* render targets

Dispose GPU resources correctly.

---

# Potree

Potree is the reference implementation.

Whenever Potree already provides:

* algorithms
* scheduling
* streaming
* LOD
* visibility
* shaders
* point budget

adapt those ideas instead of reinventing them.

Do not copy blindly.

Understand first.

Adapt second.

---

# Streaming

Streaming must always be:

* asynchronous
* progressive
* non-blocking

Never freeze rendering.

Never block the main thread.

---

# Rendering

Rendering should remain deterministic.

Avoid hidden side effects.

Avoid unnecessary GPU uploads.

Avoid duplicate buffers.

---

# Architecture Changes

Before introducing new classes ask:

Can an existing class be extended?

Can composition solve the problem?

Avoid unnecessary inheritance.

---

# Testing

Every change must mentally answer:

What breaks?

What depends on this?

What edge cases exist?

What happens on failure?

---

# Self Review

Before finishing any task verify:

* naming consistency
* formatting
* dead code
* duplicated logic
* unnecessary allocations
* unnecessary complexity
* backward compatibility

---

# Forbidden Behaviors

Never:

* invent APIs
* invent project architecture
* ignore existing conventions
* duplicate functionality
* rewrite working systems without reason
* introduce speculative optimizations
* hide failures
* leave TODOs instead of solving the issue (unless explicitly requested)

---

# Communication

When explaining modifications:

Describe:

* what changed
* why
* architectural impact
* performance impact
* compatibility impact
* remaining limitations

Avoid vague statements.

---

# Decision Framework

When multiple solutions exist:

Choose the one that:

1. Fits existing architecture.
2. Requires the fewest changes.
3. Has the lowest maintenance cost.
4. Is easiest to understand.
5. Is easiest to test.

---

# Final Checklist

Before considering any task complete:

* Repository inspected.
* Related files reviewed.
* Existing architecture respected.
* No duplicated logic.
* No invented APIs.
* Naming consistent.
* Error handling complete.
* Memory considered.
* Performance considered.
* Public API preserved.
* Code remains readable.
* Changes are incremental.
* Behavior verified through reasoning.
* Documentation updated if necessary.

If any item fails, continue working until it passes.

---

# Guiding Philosophy

Write code as if another engineer will maintain it for the next ten years.

Every line should justify its existence.

The best code is not the shortest.

The best code is the one that future maintainers immediately understand.
