# Architecture Options

## Option 1: Per-project browser stacks
Each project owns its own browser logic.

### Pros
- Fastest short-term changes
- Low migration overhead

### Cons
- Repeated bugs and duplicated logic
- Popup/profile issues reappear in every project
- Hard to build shared methodology

## Option 2: Shared browser-core inside current workspace/repo set
Create a shared core for daemon management, browser bridge, strategy selection, state, and adapters, while each project keeps its own task flow.

### Pros
- Best balance for current stage
- High reuse without premature platformization
- Lets production workflow, content acquisition, authenticated learning portal, and authenticated content authoring workflow share the same stable primitives

### Cons
- Boundaries still need discipline

## Option 3: Separate automation platform repo
Extract the shared browser core into its own repo with contracts, CLI, and plugin interface.

### Pros
- Cleanest long-term platform boundary
- Easier reuse across many repos

### Cons
- Higher upfront architecture cost
- Risk of overbuilding too early

## Option 4: Use OpenCLI as primary underlying runtime
Adopt OpenCLI heavily for runtime, adapters, and discovery.

### Pros
- Reuses existing ecosystem and methodology
- Strong fit with browser-discovery to CLI-execution workflow

### Cons
- Must accept or adapt to OpenCLI’s modeling choices
- May not map directly to PDF/Excel/tracker outputs
- Likely still needs custom orchestration around it

## Recommendation
Use **Option 2 now**.
- Build a shared browser-core / automation-core first.
- Study OpenCLI deeply and borrow or integrate selectively.
- Revisit Option 3 after the shared core stabilizes.
