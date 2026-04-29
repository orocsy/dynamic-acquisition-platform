# Dynamic Acquisition Platform — Diagram Pack

This file indexes the editable Excalidraw sources that accompany the system design.

> Note (2026-04-26): the diagram pack received a readability pass to reduce text cut-off risk in Excalidraw runtime rendering (smaller fonts, safer line breaks, re-centered labels).

## Diagram files

1. **High-level architecture**
   `dynamic-acquisition-platform-high-level.excalidraw`

2. **Module interactions**
   `dynamic-acquisition-platform-module-interactions.excalidraw`

3. **Backend composition**
   `dynamic-acquisition-platform-backend-composition.excalidraw`

4. **Failure and re-planning loop**
   `dynamic-acquisition-platform-failure-replanning.excalidraw`

5. **Product integration map**
   `dynamic-acquisition-platform-product-integration.excalidraw`

6. **Phase 2 runtime lifecycle**
   `dynamic-acquisition-platform-phase2-runtime-lifecycle.excalidraw`

7. **Phase 2 human intervention and resume sequence**
   `dynamic-acquisition-platform-phase2-human-resume-sequence.excalidraw`

## Suggested usage

- Use the **high-level architecture** diagram for executive and overview sections.
- Use **module interactions** when discussing platform boundaries and internal responsibilities.
- Use **backend composition** when explaining why backend choice is capability-level instead of run-level.
- Use **failure and re-planning** when discussing checkpoints, fallback behavior, and AI-assisted orchestration.
- Use **product integration** when presenting how `consumer workflow`, `production workflow`, and future systems consume the platform.
- Use **Phase 2 runtime lifecycle** when explaining checkpoint statuses, recoverable waits, expiry, cancellation, and terminal outcomes.
- Use **Phase 2 human intervention and resume sequence** when explaining why notifications/subscriptions are best-effort and explicit `resumeRun` is the durable continuation path.

## Next detailed design package to produce after review

- Evidence schema
- Capability catalog schema
- Plan schema
- Backend routing policy
- AI harness intervention contract
- OpenCLI wrapper mapping
