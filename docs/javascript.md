# JavaScript Coding Standards

> Project-wide JavaScript conventions and engineering guidelines.

---

# Purpose

This document defines how JavaScript code must be written throughout the project.

The goal is to maximize:

* readability
* maintainability
* correctness
* performance
* consistency

Consistency is more important than personal preference.

---

# General Philosophy

Write JavaScript that is easy to understand.

Prefer explicit code over clever code.

Every function should communicate its purpose through its structure.

Future maintainers should understand the code without reading additional documentation.

---

# Language Version

Use modern ECMAScript.

Prefer language features that are widely supported and already used in the repository.

Avoid introducing syntax that differs significantly from the existing codebase unless there is a clear architectural benefit.

---

# Modules

Always use ES Modules.

Prefer:

```javascript
import { Loader } from "./Loader.js";
```

Avoid legacy module systems unless already required by the project.

Keep imports organized:

1. Standard library
2. Third-party packages
3. Internal modules
4. Relative imports

Remove unused imports immediately.

---

# Variables

Use `const` by default.

Use `let` only when reassignment is required.

Never use `var`.

Bad:

```javascript
var points = [];
```

Good:

```javascript
const points = [];
```

---

# Naming

Names must describe intent.

Variables:

```javascript
pointCount
visibleNodes
loadedPoints
gpuMemory
```

Avoid:

```javascript
a
b
tmp
foo
bar
thing
value2
```

---

# Functions

Functions should perform one task.

Aim for:

* one responsibility
* descriptive name
* limited branching
* limited side effects

Prefer:

```javascript
computeVisibleNodes()
```

Instead of:

```javascript
processEverything()
```

---

# Parameters

Limit parameter count.

If a function requires many options, use an object.

Prefer:

```javascript
render({
    camera,
    renderer,
    scene
});
```

instead of:

```javascript
render(scene, camera, renderer, width, height, options);
```

---

# Return Values

Functions should return one clear result.

Avoid mixing:

* return values
* mutation
* global state

in the same function.

---

# Pure Functions

Prefer pure functions whenever practical.

Pure functions are:

* deterministic
* easier to test
* easier to reason about
* easier to optimize

---

# Async Code

Always prefer:

```javascript
async
await
```

instead of deeply nested Promise chains.

Avoid callback pyramids.

Always handle rejected promises.

---

# Error Handling

Never swallow errors.

Bad:

```javascript
catch (e) {}
```

Good:

```javascript
catch (error) {
    logger.error(error);
    throw error;
}
```

Only recover from errors when recovery is intentional.

---

# Objects

Prefer small objects with clear responsibilities.

Avoid objects that manage unrelated concerns.

---

# Classes

Use classes only when state and lifecycle justify them.

Do not introduce classes for simple utility functions.

Prefer composition over inheritance.

---

# State

Keep mutable state localized.

Avoid global mutable objects.

Document ownership of shared state.

---

# Side Effects

Keep side effects isolated.

Examples:

* file loading
* rendering
* GPU uploads
* DOM manipulation
* logging

Business logic should remain independent whenever possible.

---

# Collections

Prefer:

* Map
* Set

instead of large object dictionaries when keys are dynamic.

Choose data structures intentionally.

---

# Loops

Prefer readability.

Use:

```javascript
for...of
```

when iterating collections.

Avoid unnecessary nested loops.

When processing very large datasets, prefer indexed loops if profiling demonstrates a measurable benefit.

---

# Optional Chaining

Use optional chaining only when absence is expected.

Do not hide programming mistakes.

Bad:

```javascript
node?.children?.forEach(...)
```

when node should never be null.

---

# Null Handling

Be explicit.

Avoid mixing:

* null
* undefined
* false
* 0

Document nullable values.

---

# Magic Numbers

Never embed unexplained constants.

Instead:

```javascript
const MAX_POINT_BUDGET = 10_000_000;
```

instead of:

```javascript
budget = 10000000;
```

---

# Configuration

Configuration belongs in dedicated configuration modules.

Avoid scattering constants throughout the project.

---

# Comments

Comments explain decisions.

Never explain obvious syntax.

Bad:

```javascript
// increment counter
counter++;
```

Good:

```javascript
// Prevent rapid LOD oscillation during camera movement.
```

---

# Code Duplication

Before writing new code ask:

Does something equivalent already exist?

Reuse existing helpers whenever possible.

Duplicate logic creates maintenance problems.

---

# Performance

Optimize only after understanding the bottleneck.

Before optimizing ask:

* Is this actually slow?
* Is profiling available?
* Will readability suffer?

Avoid premature optimization.

---

# Memory

Large point cloud applications allocate significant memory.

Prefer:

* object reuse
* typed arrays
* buffer pools
* preallocated collections

Avoid unnecessary temporary allocations inside render loops.

---

# Immutability

Prefer immutable data where practical.

Mutate only when ownership is clear.

---

# File Size

Prefer files with one clear responsibility.

If a file becomes difficult to navigate, split it into cohesive modules.

---

# Directory Structure

Group code by responsibility rather than by type whenever possible.

Example:

```
renderer/
    RenderScheduler.js
    VisibilityManager.js
    PointBudget.js

streaming/
    Loader.js
    Cache.js
    RequestQueue.js
```

instead of:

```
utils/
helpers/
misc/
```

---

# API Design

Public APIs should remain stable.

Changes to exported interfaces require careful evaluation.

Breaking changes should be avoided unless explicitly requested.

---

# Refactoring

Refactor only when there is measurable value.

Every refactoring should improve at least one of:

* readability
* maintainability
* performance
* correctness

Avoid refactoring solely for stylistic reasons.

---

# Self Review

Before completing any JavaScript change verify:

* No unused variables.
* No duplicated logic.
* No unnecessary allocations.
* No hidden side effects.
* No invented APIs.
* No dead code.
* Clear naming.
* Consistent formatting.
* Correct error handling.
* Async code properly awaited.
* Public APIs preserved.

---

# Final Principle

The goal is not to write impressive JavaScript.

The goal is to write JavaScript that another engineer can understand immediately, modify safely, and maintain confidently for years.
