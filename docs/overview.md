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

## Why this exists
Past work across production workflow, authenticated learning portal, and authenticated content authoring workflow/authenticated content portal showed that good results came when we accidentally approximated this model, but without a unified architecture or explicit methodology.
