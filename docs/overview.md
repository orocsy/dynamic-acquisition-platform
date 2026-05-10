# Overview

## Goal
Build a stable browser automation foundation where the browser is a long-lived infrastructure service, not a one-off disposable session.

## Core direction
- Default to a dedicated stable Chrome daemon, not the user's daily Chrome.
- Use the browser for discovery, auth bridge, lazy-load triggering, and request observation.
- Prefer API/cookie/header/intercept execution over long-term DOM-only automation when possible.
- Separate shared browser core from task-specific flows.

## Immediate implications
- Eliminate default attach to `profile=user` for routine automation.
- Reduce or remove remote debugging consent popups by avoiding the user's live Chrome as the default target.
- Promote the stable daemon runner path as the primary execution path.

## Working model
- Browser daemon layer
- Browser bridge layer
- Strategy engine
- Adapter layer
- Task flow layer
- Artifact/state layer

## Phase 3 documentation package

Phase 3 starts with docs before implementation, mirroring the Phase 2 approach:

- `phase3-browser-daemon-integration-design.md` — browser daemon integration design
- `phase3-implementation-breakdown.md` — 3.1–3.7 implementation slices and gates
- `phase3-low-level-design.md` — module/API/test-level design for each Phase 3 slice
- `browser-daemon-runtime-boundary.md` — runtime/browser boundary and policy rules
- `phase3-testing-validation-plan.md` — unit, fixture, daemon smoke, and manual auth validation plan

Phase 3's core rule: the dedicated daemon becomes the default execution backend, while `profile=user` remains explicit/manual bridge mode only.

## Why this exists
Past work across production workflow, authenticated learning portal, and authenticated content authoring workflow/authenticated content portal showed that good results came when we accidentally approximated this model, but without a unified architecture or explicit methodology.
