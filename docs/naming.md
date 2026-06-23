# Naming Conventions

> Rules for naming files, classes, functions, variables, constants, modules, and project-wide identifiers.

---

# Purpose

Naming is one of the most important aspects of software engineering.

Good names reduce the need for comments.

A well-named codebase is easier to understand, maintain, review, and extend.

Every identifier should communicate intent immediately.

---

# General Principles

Names should be:

* Explicit
* Predictable
* Consistent
* Searchable
* Domain-specific

Avoid names that require external explanation.

---

# Consistency Over Creativity

Always prefer existing project terminology.

If the repository already uses:

NodeCache

do not introduce:

CacheManager

NodeStorage

CacheController

All identifiers describing the same concept should use identical terminology.

---

# Domain Language

Prefer names that reflect the point cloud domain.

Examples:

PointCloud

Octree

Hierarchy

Node

LOD

Visibility

Streaming

Scheduler

Budget

Renderer

Traversal

Avoid generic software terminology when a domain-specific term exists.

---

# File Names

Files should describe exactly what they contain.

Examples:

VisibilityManager.js

StreamingScheduler.js

PointBudgetController.js

NodeCache.js

OctreeNode.js

Avoid:

Helpers.js

Utils.js

Functions.js

Misc.js

Common.js

NewStuff.js

Temporary.js

---

# Directory Names

Directories represent responsibilities.

Good:

renderer/

streaming/

octree/

visibility/

lod/

cache/

gpu/

Avoid:

helpers/

misc/

other/

tmp/

general/

---

# Classes

Classes represent nouns.

Good:

PointCloudNode

StreamingScheduler

VisibilityManager

RendererStatistics

Bad:

ManageNodes

ComputeLOD

RenderStuff

ProcessData

---

# Functions

Functions represent actions.

Good:

loadNode()

computeLOD()

updateVisibility()

renderFrame()

scheduleRequests()

Bad:

node()

data()

process()

run()

execute()

handle()

Functions should describe **what** they do, not **how** they do it.

---

# Boolean Functions

Boolean-returning functions should read like questions.

Examples:

isVisible()

hasChildren()

canUpload()

shouldRender()

isLoaded()

Avoid:

visible()

loaded()

render()

---

# Boolean Variables

Examples:

isLoaded

isVisible

hasChildren

canRender

shouldEvict

Avoid:

loadedFlag

visibleValue

stateBool

---

# Variables

Variable names should represent the stored value.

Good:

visibleNodes

loadedPoints

cameraPosition

gpuMemory

requestQueue

Bad:

list

array

data

value

object

item

---

# Loop Variables

Use meaningful names.

Good:

for (const node of visibleNodes)

for (const request of requestQueue)

Avoid:

i

j

x

obj

tmp

Use single-letter variables only for very small mathematical scopes.

---

# Collections

Plural names indicate collections.

Examples:

visibleNodes

loadedBuffers

pendingRequests

renderQueues

Never use singular names for arrays.

---

# Constants

Constants use UPPER_SNAKE_CASE.

Examples:

MAX_POINT_BUDGET

DEFAULT_CACHE_SIZE

MAX_UPLOADS_PER_FRAME

CACHE_EVICTION_THRESHOLD

Avoid unexplained numeric literals.

---

# Enumerations

Enum values should be descriptive.

Example:

NodeState

UNLOADED

LOADING

LOADED

UPLOADED

VISIBLE

EVICTED

Avoid numeric states without names.

---

# Interfaces

Interface names should describe capabilities.

Examples:

Renderable

Loadable

Disposable

Traversable

Avoid meaningless prefixes.

---

# Events

Events describe completed actions.

Examples:

nodeLoaded

frameRendered

cacheEvicted

streamingCompleted

Avoid:

load

render

cache

---

# Callbacks

Callback names should describe when they execute.

Examples:

onNodeLoaded

onFrameCompleted

onVisibilityChanged

Avoid:

callback

handler

function

---

# Temporary Variables

Avoid temporary variables whenever possible.

If required, they should still be descriptive.

Good:

currentNode

selectedLOD

parentBounds

Avoid:

tmp

temp

value2

newNode2

---

# Abbreviations

Avoid abbreviations unless universally understood.

Good:

renderer

visibility

configuration

position

Bad:

cfg

pos

mgr

vis

rnd

---

# Acronyms

Treat acronyms consistently.

Prefer:

GpuBuffer

CpuCache

LodManager

rather than inconsistent capitalization.

Follow the project's existing style if already established.

---

# Suffixes

Use suffixes consistently.

Examples:

Manager

Controller

Scheduler

Renderer

Cache

Loader

Statistics

Configuration

Avoid creating multiple suffixes for identical responsibilities.

---

# Prefixes

Avoid unnecessary prefixes.

Bad:

mNode

gRenderer

sCache

myCamera

currentCurrentNode

Use clean names instead.

---

# Symmetry

Related concepts should use parallel naming.

Example:

loadNode()

unloadNode()

scheduleRequest()

cancelRequest()

allocateBuffer()

releaseBuffer()

Symmetry improves discoverability.

---

# Avoid Ambiguity

Every identifier should have one meaning.

Do not reuse the same word for different concepts.

Example:

Node

should always refer to an octree node if that is the established terminology.

---

# Reserved Words

Avoid names that resemble JavaScript keywords.

Examples:

class

default

function

package

prototype

constructor

---

# API Stability

Public names are part of the API.

Changing exported names requires strong justification.

Prefer preserving stable identifiers.

---

# Self Review

Before introducing a new identifier ask:

Is it descriptive?

Is it consistent with existing names?

Can another engineer understand it immediately?

Does it follow the project's terminology?

Could it be confused with another concept?

If any answer is "no", rename it.

---

# Naming Anti-Patterns

Avoid introducing names such as:

Helper

Utils

Common

Manager2

RendererNew

Temp

Misc

Data

Object

Thing

Stuff

Info

Process

Handle

System

ManagerManager

These names communicate little or no intent.

---

# Final Principle

If a name requires a comment to explain its purpose, it is probably the wrong name.

A good identifier should allow another engineer to understand the surrounding code without additional explanation.
