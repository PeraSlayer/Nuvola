# Testing & Validation Guidelines

> Rules for validating correctness, preventing regressions, and ensuring reliable behavior across the project.

---

# Purpose

Every code change must increase confidence in the system.

Testing is not limited to automated test suites.

Every implementation must be validated through reasoning, verification, and, where possible, automated execution.

---

# Testing Philosophy

The purpose of testing is not to prove that code works.

The purpose is to discover where it fails.

Assume every new implementation contains defects until proven otherwise.

---

# Validation Pyramid

Every change should be validated at multiple levels.

1. Static reasoning
2. Local verification
3. Integration validation
4. Performance validation
5. User-facing validation

Skipping layers increases regression risk.

---

# Think Before Testing

Before executing any test, answer:

What should happen?

What should never happen?

Which assumptions does this implementation make?

Which assumptions might be wrong?

Testing begins before code execution.

---

# Static Verification

Every implementation should first pass static review.

Verify:

* imports
* exports
* naming
* ownership
* data flow
* lifecycle
* error handling
* null handling
* edge cases

Many defects can be eliminated before running the application.

---

# Unit Testing

When practical, isolate logic into testable units.

Functions should be deterministic.

Avoid hidden dependencies.

Prefer pure functions whenever possible.

---

# Integration Testing

Verify interactions between systems.

Examples:

Streaming ↔ Cache

Visibility ↔ Renderer

Renderer ↔ GPU

Scheduler ↔ Loader

LOD ↔ Point Budget

Subsystems should cooperate without hidden coupling.

---

# Rendering Validation

Rendering changes should verify:

Correct image

Correct visibility

Correct LOD

Correct colors

Correct point count

Correct camera behavior

No visual artifacts

No unnecessary GPU work

---

# Streaming Validation

Streaming should verify:

Progressive loading

No blocking

Correct prioritization

Correct cache eviction

Correct node lifecycle

Memory limits respected

Streaming quality should improve over time.

---

# Performance Validation

Every performance-sensitive change should answer:

Frame time improved?

Memory increased?

GPU uploads increased?

CPU allocations increased?

Draw calls increased?

Performance regressions are functional regressions.

---

# Memory Validation

Check:

Memory ownership

Object lifetime

Resource disposal

GPU cleanup

CPU cleanup

Cache eviction

No leaks should remain.

---

# Error Handling Validation

Verify failure scenarios.

Examples:

Missing files

Corrupted metadata

Malformed point clouds

GPU upload failure

Out-of-memory conditions

Invalid node hierarchy

The application should fail gracefully.

---

# Edge Cases

Always test boundaries.

Examples:

Empty datasets

Single node

Extremely large datasets

Deep octrees

Very small point budgets

Very large point budgets

Rapid camera movement

Repeated loading and unloading

Edge cases reveal architectural weaknesses.

---

# Regression Prevention

Before completing any task ask:

What existing behavior could this break?

What assumptions changed?

Which modules depend on this behavior?

Regression prevention is as important as feature development.

---

# Deterministic Behavior

Given identical input:

The application should produce identical output.

Avoid:

Random ordering

Hidden state

Implicit side effects

Nondeterministic scheduling

Determinism simplifies debugging.

---

# Assertions

Use assertions for programmer errors.

Assertions should verify invariants.

Examples:

Node state transitions

Buffer ownership

Cache consistency

Internal assumptions

Assertions should not replace runtime error handling.

---

# Logging During Validation

Useful logging includes:

Streaming state

LOD selection

Visible nodes

Cache activity

GPU uploads

Scheduler decisions

Remove excessive logging after validation.

---

# Debug Tools

Useful debug visualizations include:

Bounding boxes

Visible nodes

LOD colors

Point budget overlays

Streaming queues

Cache statistics

GPU memory usage

Frame timing

Visualization accelerates debugging.

---

# Manual Testing Checklist

Before completing a feature verify:

* Application starts correctly.
* Existing scenes still load.
* Camera behaves correctly.
* Streaming remains progressive.
* No visible flickering.
* LOD transitions remain stable.
* Point budget enforced.
* Picking still works.
* UI remains responsive.
* Memory usage remains stable.
* GPU resources released correctly.

---

# Automated Testing

When automated tests exist:

Run them before considering a task complete.

If tests fail:

Do not ignore failures.

Identify root cause.

Correct implementation.

Re-run validation.

---

# Self Review

Before declaring success verify:

Correctness

Architecture

Naming

Performance

Memory

Error handling

Readability

Documentation

Every change should satisfy all categories.

---

# Code Review Questions

Ask yourself:

Would I approve this change?

Can another engineer understand it immediately?

Does it increase maintenance burden?

Does it duplicate existing behavior?

Could this be simplified?

If uncertainty remains, revise the implementation.

---

# Bug Investigation Workflow

When a defect is discovered:

Reproduce it.

Identify root cause.

Understand affected systems.

Implement minimal correction.

Validate against regressions.

Document important findings.

Avoid speculative fixes.

---

# Feature Completion Checklist

A feature is complete only when:

✓ Functionality works.

✓ Existing behavior preserved.

✓ Performance acceptable.

✓ Memory stable.

✓ Errors handled.

✓ Documentation updated.

✓ Self review completed.

✓ No obvious regressions remain.

---

# Final Principle

Code is not complete when it compiles.

Code is complete when it has been carefully reasoned about, validated against expected behavior, tested across normal and edge cases, and shown to preserve the integrity of the entire system.
