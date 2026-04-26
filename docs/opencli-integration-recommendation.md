# OpenCLI Integration Recommendation

## Status
Draft v1, based on direct study of the available OpenCLI article/source material on 2026-04-22.

## Why this document exists
We need an honest answer to a practical question:

- if OpenCLI already overlaps heavily with our proposed low-level foundation,
- what should we reuse,
- what should we wrap,
- what should remain our own,
- and what is the safest architecture pattern for doing that?

This document answers that question directly.

---

# 1. Executive summary

## Bottom line
Do **not**:
- rebuild large overlapping low-level layers from scratch immediately
- fork OpenCLI early
- depend deeply on OpenCLI internal APIs
- let OpenCLI define our core contracts

Do:
- define **our own contracts first**
- treat OpenCLI as an **optional backend**
- wrap it behind a **facade + anti-corruption layer**
- use it where overlap is strong and modularity is sufficient
- keep AI harness, artifact/runtime contracts, and product orchestration on our side

## Best design pattern
The best pattern is:

## **Ports and Adapters + Anti-Corruption Layer + Backend Facade**

In plain language:
- our system owns the stable interface
- OpenCLI is one backend implementation
- all mapping between the two happens in a wrapper layer
- AI harness and product flows never depend directly on OpenCLI concepts

---

# 2. What we confirmed about OpenCLI from direct material

From the studied material, OpenCLI is not vague. It has a fairly clear shape.

## 2.1 Core idea
OpenCLI's philosophy is:
- stop fighting unstable GUI automation
- use the browser to discover the real underlying API
- reproduce the request directly when possible
- package that capability into a local callable CLI command

This is a strong fit with our own thinking.

## 2.2 Command/runtime surface
Material explicitly shows:
- `opencli list`
- `opencli cascade <url>`
- `opencli explore`
- `opencli synthesize`
- `opencli generate`
- `opencli record`

This confirms OpenCLI is very much **CLI-first** and **tool-surface-oriented**.

## 2.3 Strategy model
OpenCLI explicitly documents a five-tier auth/strategy ladder:
- `public`
- `cookie`
- `header`
- `intercept`
- `ui`

This strongly overlaps with the lower-level strategy thinking we were already developing.

## 2.4 Adapter model
OpenCLI supports:
- YAML adapters for simpler declarative flows
- TypeScript adapters for more complex scenarios

It also dynamically registers adapters from user-space paths like:
- `~/.opencli/clis/{site}/{command}.yaml`
- `~/.opencli/clis/{site}/{command}.ts`

This is important because it means:
- OpenCLI is not only a hardcoded command catalog
- it already has a plugin/adapter mentality
- it is intended to be extended

## 2.5 Browser/discovery model
The material explicitly describes an AI/agent exploration workflow involving:
- browser navigation
- page snapshot
- network request inspection
- simulated user interaction
- secondary request comparison
- `fetch(..., { credentials: 'include' })` validation

That means OpenCLI is not just a static CLI library. It has a discovery story.

## 2.6 Record and generation model
OpenCLI also has:
- `record` for capturing interactive/browser behavior and request sequences
- `synthesize` for generating candidate adapters
- `generate` for chaining explore -> synthesize -> register -> verify

This is highly relevant because it means OpenCLI is not merely a runtime, but also a CLI-generation workflow.

## 2.7 Current limitation explicitly stated
The material explicitly says OpenCLI currently has limitations around missing request payload capture for POST/PUT and therefore weaker support for write-operation command generation.

This is a crucial design signal.

---

# 3. Honest overlap analysis

## 3.1 Where overlap is high
These areas appear to have strong overlap with our proposed low-level foundation:

### A. Browser-assisted discovery
High overlap.
OpenCLI already thinks in terms of using a real browser to discover how a site works.

### B. Strategy selection
High overlap.
The public/cookie/header/intercept/ui ladder is very close to the strategy-family idea we were already moving toward.

### C. Adapterized command surface
High overlap.
OpenCLI already turns site capabilities into callable CLI commands via adapters.

### D. Explore/synthesize/generate methodology
Medium-to-high overlap.
This is close to our evidence -> toolchain thinking, though not identical.

### E. CLI exposure of capabilities
High overlap.
This directly supports our idea that non-AI layers should be CLI-fied so AI harness or scripts can compose them.

## 3.2 Where overlap is only partial
These areas overlap conceptually, but our system likely needs more:

### A. Discovery output model
OpenCLI appears discovery-oriented, but our system wants a normalized **evidence graph / evidence schema** that is reusable across AI harness, strategy, and product flows.

### B. Planning layer
OpenCLI has generation and strategy logic, but our intended **plan synthesis** layer appears more explicit and cross-domain.

### C. Backend composability
OpenCLI exposes commands and adapters, but it is not yet proven that its internal pieces are separable enough for fully mixed backend composition.

## 3.3 Where overlap is low
These are areas we should assume we own:

### A. AI harness
This is a major differentiator.
OpenCLI material shows agent-assisted exploration ideas, but our target architecture wants AI harness as a first-class runtime control plane.

### B. Artifact contracts and validation runtime
OpenCLI is about generating callable command interfaces.
Our needs include:
- manifests
- run-meta
- validators
- resumable state
- PDFs, HTML, JSON, media bundles, XLSX trackers
- production-grade result contracts

That is materially different.

### C. Product orchestration across domains
We need one substrate serving:
- content acquisition
- course capture
- broad multi-site research
- production workflow production workflows

That is beyond a simple CLI-generation framework.

### D. Cross-layer re-planning and intervention
Our architecture wants optional AI intervention at intent, discovery, evidence, strategy, plan, and execution layers.
This is not obviously what OpenCLI itself is designed to be.

---

# 4. What OpenCLI likely is, architecturally

The most honest framing is:

## OpenCLI is best understood as a **tool-oriented automation substrate**

It appears to provide:
- browser-assisted discovery
- strategy-aware execution selection
- adapter generation
- command registration
- reusable local CLI surface

This is valuable.

But it does **not** appear, from current evidence, to be the full system we want.

It is more likely to be:
- a strong lower or middle layer
- not the whole acquisition operating system

---

# 5. So does reusing OpenCLI affect our toolchain layer?

## Yes, but in the right design it affects implementation, not ownership.

This distinction is important.

### Wrong model
"If we use OpenCLI, our toolchain layer becomes OpenCLI."

This is the model to avoid.

### Correct model
"Our toolchain layer stays ours. Some toolchain steps may be implemented by OpenCLI-backed capabilities."

Meaning:
- our capability catalog remains ours
- our toolchain planning remains ours
- our CLI/API surface remains ours
- OpenCLI is one backend that powers some capabilities

So yes, reuse affects the tool layer **under the hood**, but it should not take ownership of the toolchain abstraction itself.

---

# 6. Are tools meant to be composable across backends?

## Yes. They should not be tied to a single backend.

This is one of the most important architecture decisions.

A toolchain should be able to mix capabilities from different backends, for example:
- OpenCLI-backed discovery
- native render-to-PDF
- native artifact packager
- provider-specific downloader
- future specialized replay backend

So the model should be:

```text
toolchain = ordered composition of capabilities
capability implementation = chosen from one backend
backend = replaceable implementation source
```

This means:
- a plan is not “use OpenCLI”
- a plan is “use capability A, B, C, D”
- each capability may be fulfilled by OpenCLI, native code, or another backend

That is the right level of flexibility.

---

# 7. Recommended design pattern

## 7.1 Core pattern
Use:

## **Ports and Adapters + Anti-Corruption Layer + Facade**

### Ports
Our system defines ports such as:
- `DiscoveryBackend`
- `ExecutionBackend`
- `RecordingBackend`
- `BrowserBackend`
- `CapabilityProvider`

### Adapters
Implement adapters such as:
- `OpenCliDiscoveryBackend`
- `OpenCliExecutionBackend`
- `NativeBrowserBackend`
- `NativeArtifactBackend`

### Anti-Corruption Layer
This layer maps:
- OpenCLI command inputs -> our capability inputs
- OpenCLI command outputs -> our evidence / artifact / result contracts
- OpenCLI errors -> our normalized failure semantics

### Facade
Expose only our own stable interfaces to:
- AI harness
- product flows
- scripts
- humans

The facade may present commands like:
- `discover-target`
- `classify-pattern`
- `build-plan`
- `run-plan`
- `validate-artifacts`
- `capture-article`

Internally, some of these may use OpenCLI.
But the caller should not be forced to think in raw OpenCLI terms.

---

# 8. Recommended backend model

## 8.1 Do not make backend choice global
A run should not be forced into a single backend.

That would be too rigid.

## 8.2 Make backend choice capability-level
Each capability should be able to say:
- preferred backend
- fallback backend
- unsupported backends

Example:

```json
{
  "capability": "discover.http-patterns",
  "preferred": ["opencli", "native"],
  "fallback": ["browser-cdp"],
  "constraints": ["requires-browser-session"]
}
```

This allows mixed plans like:
- discovery via OpenCLI
- rendering via native Chrome print-to-PDF
- asset packaging via native code
- validation via our own runtime

## 8.3 Backend selection should be explicit in the planner
The planner should consider:
- capability availability
- output compatibility
- trust/stability
- performance
- control/freedom cost

So planning is not just “what steps”, but also “which backend fulfills each step”.

---

# 9. Should we start from native or OpenCLI?

## Honest answer
We should **not** start from a fully native rebuild of overlapping layers.

That would be wasteful before we prove OpenCLI is insufficient.

## But we also should not start by making OpenCLI the core.
That would give away too much control too early.

## Best starting point
Start with:

### 1. Our contracts
Define:
- evidence schema
- capability catalog
- plan schema
- artifact contract

### 2. One OpenCLI backend wrapper
Implement a thin wrapper for a small set of overlapping capabilities first.

### 3. Native implementations only where we already know we need them
Examples:
- PDF/render bundles
- manifests/run-meta/validators
- specialized packaging
- flows that OpenCLI clearly does not cover well

This gives us the most signal with the least unnecessary rebuilding.

---

# 10. Recommended wrapper architecture

```text
+-------------------------------------------------------------------+
|                        AI Harness / Product Flows                  |
|        consumer workflow | production workflow | future crawlers        |
+----------------------------------+--------------------------------+
                                   |
                                   v
+-------------------------------------------------------------------+
|                      Our Capability / Plan Facade                  |
|  discover-target | classify-pattern | build-plan | run-plan        |
+----------------------------------+--------------------------------+
                                   |
                                   v
+-------------------------------------------------------------------+
|                         Our Core Contracts                         |
|  evidence schema | capability catalog | plan schema | artifacts    |
+-------------------+--------------------+---------------------------+
                    |                    |
         +----------+----------+   +-----+---------------------------+
         |                     |   |                                 |
         v                     v   v                                 v
+------------------+  +-------------------+  +------------------+  +------------------+
| OpenCLI Adapter  |  | Native Adapter    |  | Other Backend(s) |  | Future Backends  |
| discover/record  |  | render/package    |  | replay/browser   |  | provider-specific |
| cascade/explore  |  | validate/state    |  | specialized      |  | or external tools |
+------------------+  +-------------------+  +------------------+  +------------------+
```

This is the recommended model.

---

# 11. What should remain ours no matter what

These should remain owned by our system:
- evidence schema
- capability catalog
- plan schema
- artifact contracts
- runtime state and resume semantics
- validators
- AI harness interfaces and modes
- product orchestration

If any of these become OpenCLI-shaped, we will lose too much freedom.

---

# 12. What can plausibly be OpenCLI-backed

These are the strongest candidates for OpenCLI-backed capability implementations:
- browser-assisted exploration
- initial strategy probing (`cascade`-style logic)
- adapterized command invocation for supported sites
- generated or recorded read-oriented command surfaces
- reusable discovery routines for known patterns

These should be treated as candidate backend features, not our source of truth.

---

# 13. What is likely not a good fit for OpenCLI-backed ownership

These are poor candidates for handing over to OpenCLI as a primary owner:
- product-specific artifact packaging
- run-meta and validator semantics
- cross-product orchestration
- AI harness control logic
- write-heavy flows requiring complete payload fidelity unless OpenCLI proves stronger than current evidence suggests
- exact output contracts like NotebookLM packs, merged PDFs, XLSX trackers, or business-specific manifests

---

# 14. Go / no-go criteria for using OpenCLI in a given area

## Go if
- the capability is highly overlapping
- it can be called independently without adopting the whole runtime
- input/output can be mapped cleanly to our contracts
- the maintenance cost is acceptable
- the freedom loss is low

## No-go if
- OpenCLI forces its own model into our core contracts
- the capability only works by adopting its whole flow/runtime
- output mapping is lossy or awkward
- stability depends on deep internal APIs
- it blocks mixed-backend composition

---

# 15. Practical recommendation

## Immediate recommendation
Proceed with an **OpenCLI fit study and wrapper-first architecture**, not with full native rebuilding.

## First implementation sequence
1. define our contracts
2. define capability-to-backend mapping model
3. build a thin OpenCLI wrapper for a small discovery subset
4. prove mixed-backend composition
5. keep native ownership for artifacts/validation/runtime

This gives us the right signal with the least lock-in.

---

# 16. Final answer to the design question

## Best honest solution
The best solution is **not**:
- full OpenCLI dependence
- full rewrite
- fork-first

The best solution is:

## **Own the contracts, expose our own tool surface, and let OpenCLI serve as one backend for strongly overlapping capabilities.**

That gives us:
- reuse where reuse is rational
- freedom where freedom matters
- a path to AI harness on top
- mixed-backend composition
- minimal unnecessary rebuilding

This is the architecture that best matches both the overlap reality and our longer-term goals.
