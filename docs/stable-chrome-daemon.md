# Stable Chrome Daemon

## Problem
Attaching to the user's real Chrome or `profile=user` causes multiple problems:
- remote debugging consent popups
- interference with the user's real browsing session
- multiple Chrome instances and profile lock confusion
- hard-to-recover daily workflow disruption

## Root cause
The popup problem persists as long as automation still defaults to attaching to the live user browser.

## Correct default
Automation should default to a dedicated Chrome daemon with its own persistent profile and lifecycle.

## Desired properties
- long-lived daemon process
- dedicated profile/data dir
- health checkable endpoint
- deterministic port
- explicit tab/page management
- not tied to the user's active Chrome session
- attach through stable CDP targets

## Current proven direction
- raw CDP page-target runner works against a dedicated daemon
- this avoids the unstable Playwright browser-context attach path
- it should become the default routine execution route

## Strategy implication
- `profile=user` should become opt-in discovery or bridge mode, not default execution mode
- browser daemon should be the infrastructure baseline

## Next daemon tasks
1. make daemon runner default
2. downgrade old user-browser attach paths to manual/explicit mode
3. unify daemon startup and health checks
4. document consent-popup avoidance as a first-class design requirement
