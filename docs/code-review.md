# Code Review Guidelines

> Mandatory review process for every code change before it is considered complete.

---

# Purpose

Every code modification must undergo a structured review before completion.

The goal of code review is not only to find bugs, but to improve:

* correctness
* maintainability
* readability
* architecture
* performance
* consistency

Every change should leave the codebase in a better state than before.

---

# Review Philosophy

Review your own work as if it were submitted by another engineer.

Be skeptical.

Assume mistakes exist until they have been ruled out.

Never approve code simply because it compiles.

---

# Review Order

Always review changes in the following order:

1. Correctness
2. Architecture
3. Public API
4. Performance
5. Memory
6. Error Handling
7. Readability
8. Documentation
9. Style

Do not begin with formatting.

Formatting is the final step.

---

# Correctness Review

Ask:

Does the implementation actually solve the requested problem?

Are all execution paths correct?

Could this produce incorrect output?

Could any state become inconsistent?

Does it preserve existing behavior?

Correctness always takes priority.

---

# Architectural Review

Verify:

* responsibilities remain separated
* ownership is explicit
* no duplicated logic
* no unnecessary abstractions
* existing architecture respected
* dependency direction preserved

Architecture should become simpler, not more complex.

---

# API Review

Review every public interface.

Questions:

Did any exported symbol change?

Will existing users still work?

Is backward compatibility preserved?

Are parameter names consistent?

Could a future contributor understand this API?

Breaking public APIs requires strong justification.

---

# Dependency Review

Before introducing any new dependency ask:

Is native JavaScript sufficient?

Does an equivalent module already exist?

Will this dependency increase maintenance cost?

Can it be removed later?

Prefer reducing dependencies over adding them.

---

# Duplication Review

Search for similar implementations.

Never introduce duplicate:

Algorithms

Utilities

Managers

Renderers

Helpers

Caches

Schedulers

One concept should have one implementation.

---

# Complexity Review

Ask:

Did this implementation become simpler?

Did nesting increase?

Were unnecessary abstractions introduced?

Can another engineer understand this within a few minutes?

Complexity is technical debt.

---

# Naming Review

Every identifier should answer:

What does this represent?

What responsibility does it have?

Would another engineer immediately understand it?

Rename unclear identifiers before merging.

---

# Readability Review

Read the code from top to bottom.

Verify:

Logical flow

Clear structure

Consistent formatting

Reasonable function length

Obvious responsibilities

Good code should require minimal explanation.

---

# Function Review

Every function should answer:

Does it perform one task?

Are parameters minimal?

Are return values clear?

Are side effects explicit?

Can this function be tested independently?

---

# State Review

Review mutable state carefully.

Questions:

Who owns this state?

Who modifies it?

Can two systems modify it simultaneously?

Can stale data exist?

Hidden state causes subtle bugs.

---

# Memory Review

Verify:

Memory ownership

GPU ownership

Resource cleanup

Object lifetime

Cache eviction

Temporary allocations

Memory leaks are correctness bugs.

---

# Performance Review

Review:

Allocations

GPU uploads

Draw calls

Sorting

Traversal

Synchronization

Rendering cost

Prefer doing less work over optimizing unnecessary work.

---

# Render Loop Review

The render loop should remain lightweight.

Inside the render loop avoid:

Heap allocations

Blocking I/O

Repeated sorting

Repeated uploads

Repeated object creation

The render loop should perform predictable work.

---

# Error Handling Review

Every failure path should answer:

What happens?

Can recovery occur?

Is the error logged?

Does the application remain usable?

Never ignore failures silently.

---

# Concurrency Review

Review asynchronous code carefully.

Questions:

Can race conditions occur?

Can stale data be rendered?

Can requests complete out of order?

Can shared state become inconsistent?

Concurrency bugs are difficult to diagnose.

---

# Streaming Review

Verify:

Streaming remains asynchronous.

Progressive refinement preserved.

Scheduler remains deterministic.

Priority rules respected.

No blocking introduced.

Streaming should improve visual quality continuously.

---

# Renderer Review

The renderer should:

Consume prepared data.

Not compute visibility.

Not schedule loading.

Not own streaming.

Responsibilities must remain separated.

---

# Potree Review

When modifying point cloud systems ask:

Does Potree already solve this?

Is the implementation compatible?

Did unnecessary divergence occur?

Can upstream concepts still be recognized?

Prefer adaptation over reinvention.

---

# Documentation Review

Verify:

Public APIs documented.

Architecture changes documented.

Behavior changes documented.

Configuration documented.

Documentation should evolve together with code.

---

# Dead Code Review

Search for:

Unused variables

Unused imports

Unused functions

Unused classes

Unused constants

Commented-out code

Remove unused code immediately.

---

# Debug Review

Remove:

Temporary logging

Debug variables

Development-only comments

Experimental code

Debug code should never remain in production.

---

# Testing Review

Review expected behavior.

Verify:

Normal cases

Boundary cases

Failure cases

Large datasets

Repeated operations

Regression risk

Every important path should be mentally validated.

---

# Security Review

Never trust external input.

Validate:

Files

Metadata

Configuration

Network data

User input

Fail safely when validation fails.

---

# Consistency Review

Check:

Naming

Formatting

Directory structure

Module organization

Architectural style

The new code should feel like it has always belonged in the repository.

---

# Review Checklist

Before approving any change verify:

✓ Correctness confirmed.

✓ Existing architecture preserved.

✓ No duplicated logic.

✓ No invented APIs.

✓ Public interfaces stable.

✓ Memory ownership explicit.

✓ Resources disposed correctly.

✓ Performance impact evaluated.

✓ Streaming unaffected.

✓ Renderer responsibilities preserved.

✓ Error handling complete.

✓ Naming consistent.

✓ Readability maintained.

✓ Documentation updated.

✓ Debug code removed.

✓ Dead code removed.

✓ Regression risk considered.

---

# Common Review Failures

Reject implementations that:

* duplicate existing systems
* introduce speculative abstractions
* add unnecessary complexity
* ignore project conventions
* create hidden coupling
* allocate excessively
* block rendering
* invent APIs
* ignore error handling
* leak resources
* bypass architectural boundaries

These issues must be corrected before the change is considered complete.

---

# Approval Criteria

A change is ready only if:

* It solves the intended problem.
* It introduces no known regressions.
* It integrates naturally with the existing architecture.
* It remains understandable without external explanation.
* Another engineer could confidently maintain it.

Meeting these criteria is more important than delivering quickly.

---

# Final Principle

The best code review question is:

**"If I encountered this code for the first time six months from now, would I immediately understand why it exists, how it works, and why it was implemented this way?"**

If the answer is **no**, the implementation is not yet finished.
