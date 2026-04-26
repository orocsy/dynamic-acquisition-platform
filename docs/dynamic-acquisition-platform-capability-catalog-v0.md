# Dynamic Acquisition Platform — Capability Catalog v0

**Status:** Draft v0  
**Purpose:** Define the first stable capability namespace and an initial platform-owned catalog slice.

---

# 1. Why this step exists

The previous document defined the capability catalog as a concept.

This document makes that concept concrete enough to guide:
- platform implementation
- backend wrapper mapping
- plan synthesis
- future CLI/tool surfaces
- product-flow integration

This step deliberately stays above low-level code.
It is a naming, boundary, and ownership step.

---

# 2. Design intent

We are doing this now because the system will become messy very quickly if capability IDs are allowed to emerge from:
- provider files
- backend command names
- AI-generated descriptions
- product-specific terminology

The platform needs one stable vocabulary.

That vocabulary must be:
- backend-neutral
- product-neutral
- composable
- explainable in plans
- easy to map to wrappers and executors

---

# 3. Capability ID rules

## 3.1 Format

Capability IDs use dot-separated namespaces:

```text
<domain>.<subdomain>.<action>[.<variant>]
```

Examples:
- `discover.har.parse`
- `discover.browser.network.capture`
- `evidence.request_family.infer`
- `strategy.acquire.select`
- `plan.acquire.build`
- `execute.request.replay`
- `render.document.pdf`
- `artifact.bundle.write`
- `validate.artifact.contract`

---

## 3.2 Naming rules

### Rule 1 — Use platform semantics, not backend verbs
Good:
- `discover.browser.network.capture`

Bad:
- `opencli.browser.network`

### Rule 2 — Use action words only at the leaf
Good:
- `artifact.bundle.write`

Bad:
- `write.artifact.bundle`

### Rule 3 — Prefer functional meaning over implementation detail
Good:
- `execute.request.replay`

Bad:
- `execute.fetch.with_cookie`

### Rule 4 — Do not encode product names in core capabilities
Bad:
- `cloud-provider.note.export`
- `career.jobs.fetch`

Those belong in provider adapters or product flows, not the core catalog.

---

# 4. Top-level capability domains

## 4.1 `intent`
Interpret and normalize acquisition objectives.

## 4.2 `discover`
Collect raw or semi-normalized observations from targets.

## 4.3 `evidence`
Transform observations into structured evidence.

## 4.4 `strategy`
Rank and select acquisition strategies.

## 4.5 `plan`
Synthesize executable plans from intent, evidence, and available capabilities.

## 4.6 `execute`
Perform acquisition actions that move the workflow forward.

## 4.7 `render`
Transform captured or replayed content into target presentation artifacts.

## 4.8 `artifact`
Materialize, package, annotate, and persist output bundles.

## 4.9 `validate`
Check contract compliance and domain-specific correctness.

## 4.10 `control`
Resume, checkpoint, re-plan, or inspect runtime state.

---

# 5. Initial catalog slice

This is the first recommended platform-owned catalog slice.
It is intentionally broad enough to support `consumer workflow`, `production workflow`, and future dynamic acquisition work.

---

## 5.1 Intent capabilities

### `intent.acquire.normalize`
Normalize a user or workflow acquisition request into a platform intent object.

**Inputs**
- raw request
- workflow context
- optional product hints

**Outputs**
- normalized intent
- requested outputs
- target scope

**Notes**
- deterministic first
- AI harness may enrich in assist/explore/orchestrate modes

---

### `intent.acquire.classify`
Classify the acquisition shape.

**Examples**
- single page capture
- course capture
- search-and-collect
- export-and-validate
- recurring workflow run

---

## 5.2 Discovery capabilities

### `discover.har.parse`
Parse HAR into normalized observation candidates.

### `discover.browser.session.open`
Open or attach to a usable browser session.

### `discover.browser.snapshot.capture`
Capture browser state or page snapshot information.

### `discover.browser.network.capture`
Capture network observations from a browser context.

### `discover.browser.storage.capture`
Capture relevant browser storage observations.

### `discover.browser.cookie.capture`
Capture cookie-presence observations and auth hints.

### `discover.page.dom.capture`
Capture DOM-derived observations from a target page.

### `discover.site.capabilities.list`
List known platform/provider/backend capabilities relevant to the target.

### `discover.flow.trigger`
Trigger a page flow to surface hidden requests or export paths.

**Why this matters**
This capability prevents discovery from being reduced to passive capture only.
Some systems require stimulation to reveal the real acquisition surface.

---

## 5.3 Evidence capabilities

### `evidence.observation.normalize`
Normalize raw observations into stable observation objects.

### `evidence.entity.resolve`
Resolve entities from observations.

### `evidence.request_family.infer`
Infer grouped request families from network evidence.

### `evidence.auth_hint.infer`
Infer auth requirements and available auth context.

### `evidence.flow.candidate.infer`
Infer candidate acquisition flows from evidence.

### `evidence.gap.detect`
Detect missing information that weakens or blocks planning.

### `evidence.readiness.score`
Produce readiness scores for strategy and execution.

---

## 5.4 Strategy capabilities

### `strategy.acquire.rank`
Rank candidate strategies based on evidence and policy.

### `strategy.acquire.select`
Select the primary strategy and alternates.

### Initial strategy families
- `public_request_replay`
- `authenticated_request_replay`
- `browser_action_export`
- `browser_render_extract`
- `mixed_discover_then_replay`
- `enumerate_then_capture`

These strategy IDs are not capabilities; they are strategy values used by planning.

---

## 5.5 Planning capabilities

### `plan.acquire.build`
Build an executable plan from intent, evidence, strategy, and catalog availability.

### `plan.acquire.patch`
Patch an existing plan after failure, enrichment, or policy change.

### `plan.backend.route`
Choose a backend per capability step.

### `plan.fallback.attach`
Attach fallback branches to a plan.

---

## 5.6 Execution capabilities

### `execute.request.replay`
Replay a normalized request using an eligible backend.

### `execute.browser.action`
Execute a browser action sequence needed for capture or export.

### `execute.site.command`
Invoke a known site/backend command through a wrapper.

### `execute.download.asset`
Download and persist a discovered asset.

### `execute.export.collect`
Collect an explicit export from a surfaced product flow.

### `execute.enumeration.collect`
Collect a set of discovered items before later capture.

---

## 5.7 Render capabilities

### `render.document.html`
Materialize a normalized HTML document artifact.

### `render.document.pdf`
Render a PDF artifact from approved input sources.

### `render.bundle.assets`
Materialize referenced assets into a bundle.

---

## 5.8 Artifact capabilities

### `artifact.manifest.write`
Write the platform manifest describing outputs and provenance.

### `artifact.bundle.write`
Write the artifact bundle to its run directory.

### `artifact.run_meta.write`
Write run metadata including routing and validation summaries.

### `artifact.checkpoint.write`
Persist runtime checkpoint state.

---

## 5.9 Validation capabilities

### `validate.artifact.contract`
Validate required outputs against the selected artifact contract.

### `validate.document.pdf_readable`
Verify a PDF is readable and not trivially broken.

### `validate.bundle.complete`
Verify a bundle is structurally complete.

### `validate.domain.expectations`
Run product/domain-specific validations.

---

## 5.10 Control capabilities

### `control.run.resume`
Resume from persisted checkpoint state.

### `control.plan.replan`
Initiate deterministic or AI-assisted re-planning.

### `control.run.inspect`
Inspect runtime state, failures, and step outputs.

---

# 6. Backend mapping guidance

This catalog is platform-owned, but some capabilities have obvious initial backend tendencies.

## Likely OpenCLI-backed first
- `discover.browser.session.open`
- `discover.browser.snapshot.capture`
- `discover.browser.network.capture`
- `discover.flow.trigger`
- `execute.site.command`
- some forms of `execute.browser.action`

## Likely native/platform-owned first
- `discover.har.parse`
- `evidence.*`
- `strategy.*`
- `plan.*`
- `render.document.pdf`
- `artifact.*`
- `validate.*`
- `control.*`

This follows the already chosen rule:
**own the contracts and routing logic; wrap OpenCLI where its capability surface is strongest.**

---

# 7. Provider specialization rule

Provider-specific logic may exist, but it must attach in one of these places only:
- evidence enrichers
- strategy hints
- backend adapters
- product-flow orchestration

It must not create provider-branded core capabilities.

### Good
- a cloud document provider evidence enricher that improves `evidence.request_family.infer`
- a authenticated content portal adapter that implements `execute.site.command`

### Bad
- adding `cloud-provider.note.discover` as a core capability
- adding `authenticated-learning-portal.pdf.export` as a core capability

This is how we prevent the core from getting polluted.

---

# 8. Why this step is foundational

This step solves three problems:

## Problem 1 — Architecture drift
Without stable capability names, plans become prose and wrappers become one-off glue.

## Problem 2 — Backend contamination
Without a platform catalog, OpenCLI command names or provider method names will leak upward and reshape the architecture.

## Problem 3 — AI ambiguity
Without a stable capability vocabulary, the AI harness cannot intervene in a bounded, explainable way.

---

# 9. Immediate next design step

The next useful step after this document is to define the first concrete machine-readable schemas for:
- normalized intent
- evidence object
- plan object
- plan step object
- artifact contract object
- structured failure object

That will turn the catalog from architectural vocabulary into implementation-ready contracts.
