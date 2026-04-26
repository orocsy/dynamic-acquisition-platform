# OpenCLI Runtime Analysis

## Status
Draft v1, based on direct inspection of `@jackwener/opencli@1.7.6` package contents on 2026-04-22.

## Goal
Answer these concrete questions with code-level evidence:
- Can OpenCLI be used in pieces, or is it only a whole-flow runtime?
- Where are its adapter/runtime/plugin boundaries?
- Which parts are good candidates for backend reuse?
- Which parts would create coupling or freedom loss if adopted directly?

---

# 1. Source inspected

Package inspected:
- `@jackwener/opencli@1.7.6`

Confirmed package metadata:
- npm package name: `@jackwener/opencli`
- version: `1.7.6`
- description: `Make any website or Electron App your CLI. AI-powered.`
- repository: `https://github.com/jackwener/opencli`
- entrypoint: `dist/src/main.js`
- module type: `ESM`

Key files inspected directly:
- `package.json`
- `dist/src/main.js`
- `dist/src/runtime.js`
- `dist/src/discovery.js`
- `dist/src/cli.js`
- `dist/src/registry.js`
- `dist/src/execution.js`
- `dist/src/capabilityRouting.js`
- `dist/src/plugin-manifest.js`
- `README.md`

---

# 2. High-confidence architectural findings

## 2.1 OpenCLI is strongly CLI-first
This is not just branding; the runtime is built around command discovery and command execution.

Evidence:
- `main.js` discovers commands from built-in and user directories
- `cli.js` builds a Commander-based program
- registry keys commands by `site/name`
- dynamic adapters are loaded into a central registry

Interpretation:
OpenCLI's main abstraction is a **registered command surface**, not a general-purpose internal service layer.

---

## 2.2 OpenCLI is modular internally, but the public operating surface is still command-oriented
This is an important nuance.

Internally, the package is separated into modules:
- `discovery.js`
- `execution.js`
- `registry.js`
- `runtime.js`
- `capabilityRouting.js`
- browser modules
- plugin modules

But externally, the primary usage model is still:
- install package
- register/discover commands
- run `opencli ...`

Interpretation:
It is **not** a pure monolith, but its stable public mental model is still whole-command/runtime oriented.

This means:
- wrapping it as a subprocess/CLI backend is realistic
- treating internal modules as a stable library API is much riskier

---

## 2.3 OpenCLI already has a plugin and user-extension model
This is a strong sign that it expects extension rather than only built-ins.

Evidence from code:
- built-in adapters live under package `clis/`
- user adapters live under `~/.opencli/clis/`
- plugins live under `~/.opencli/plugins/`
- plugin manifests use `opencli-plugin.json`
- `discoverPlugins()` scans plugin directories
- `ensureUserCliCompatShims()` creates package-resolution shims under `~/.opencli/node_modules/@jackwener/opencli`

Interpretation:
OpenCLI is designed to be extended.
That is good for reuse.

But:
its extension model is still extension **inside OpenCLI's world**, not necessarily inside ours.

---

## 2.4 Adapters are command registrations, not just data files
This matters because it affects reuse style.

Evidence:
- `registry.js` exports `cli(opts)` and `registerCommand(cmd)`
- commands are normalized into fields such as:
  - `site`
  - `name`
  - `strategy`
  - `browser`
  - `args`
  - `columns`
  - `func`
  - `pipeline`
  - `navigateBefore`
- README says YAML is supported conceptually, but current `discovery.js` warns that YAML is no longer supported at runtime and prefers `.js`

Interpretation:
The real runtime model appears to be **JS-first registered command objects**, even if the conceptual/documentation layer still talks about YAML/TypeScript.

This is important for us:
- OpenCLI is less of a general workflow engine than a command-registration engine
- its natural integration boundary is command-level, not arbitrary low-level function-level composition

---

## 2.5 Strategy is normalized into execution behavior early
OpenCLI has a strategy enum, but execution does not keep strategy as a high-level planner concept for long.

Evidence from `registry.js`:
- strategies include:
  - `public`
  - `local`
  - `cookie`
  - `header`
  - `intercept`
  - `ui`
- `normalizeCommand()` converts strategy into concrete fields:
  - `browser`
  - `navigateBefore`

Evidence from `capabilityRouting.js`:
- `shouldUseBrowserSession(cmd)` mostly checks normalized command fields and pipeline steps

Interpretation:
OpenCLI's strategy layer is useful, but it is not a rich separate planning model.
It quickly becomes execution configuration.

This is a key difference from our proposed architecture, where:
- evidence
- strategy
- plan
- backend choice

should remain explicit and reusable as first-class concepts.

---

## 2.6 Command execution is a single centralized path
Evidence from `execution.js`:
- `executeCommand()` is the central executor
- it handles:
  - arg preparation
  - hooks
  - browser session lifecycle if required
  - pre-navigation
  - timeouts
  - lazy adapter loading
  - pipeline or function execution
  - diagnostics

Interpretation:
This is good news for wrapping because:
- there is a clear command execution boundary

But it also means:
- OpenCLI's internal execution model is command-centric
- it is not obviously designed as a fine-grained external orchestration library

---

## 2.7 Browser session handling is opinionated but reusable at the command boundary
Evidence:
- `runtime.js` chooses `BrowserBridge` vs `CDPBridge`
- `browserSession()` manages connect/close lifecycle
- `cli.js` has a dedicated browser workspace model and target tab persistence
- README describes browser commands like `opencli browser open`, `click`, `type`, `wait`, `network`, `tab list`, etc.

Interpretation:
OpenCLI already exposes browser primitives in a way that AI agents can drive.

This is highly reusable for us at the tool/backend level.

But the browser runtime is still shaped around OpenCLI's own daemon/bridge/workspace conventions.
So we should assume:
- usable as a backend surface
- risky to adopt as our browser state model directly

---

## 2.8 OpenCLI supports external CLI passthrough and CLI hub behavior
Evidence:
- README explicitly documents `opencli gh`, `opencli docker`, `opencli obsidian`, etc.
- `cli.js` imports external CLI loading and execution helpers

Interpretation:
This is very relevant to our design because it proves OpenCLI is already comfortable acting as:
- a capability hub
- a wrapper around other command systems

This aligns with our multi-backend composition idea.

---

# 3. Can OpenCLI be used in pieces?

## Short answer
### Yes, but mostly at the **command/backend surface**, not safely at deep internal API level.

## What seems realistically reusable in pieces
### A. CLI/backend invocation
Very plausible.
We can call `opencli ...` as an external backend.

### B. Browser primitive invocation via CLI
Also plausible.
`opencli browser ...` provides a tool surface that AI or orchestration layers can invoke.

### C. Adapter execution
Plausible if a needed capability already exists as an adapter command.

### D. Plugin/adapter generation workflow
Potentially useful, but likely still best treated as an OpenCLI-native subsystem rather than our own core authoring model.

## What is less safe to treat as reusable pieces
### A. Internal imports like `dist/src/execution.js`
Possible technically, but not recommended as a stable integration strategy.

### B. Internal registry as our source of truth
Bad idea. It would let OpenCLI's command model shape our core too much.

### C. Internal runtime/session assumptions
Likely too opinionated for us to adopt directly without coupling.

---

# 4. Where are the boundaries?

## 4.1 Stable-ish external boundary
The most stable-looking boundary is:

## the `opencli` executable and its command surface

Why:
- that's the intended product interface
- docs and README are built around it
- upgrade pressure is more likely to preserve CLI semantics than internal module structure

## 4.2 Semi-stable extension boundary
The second boundary is:
- `~/.opencli/clis/`
- `~/.opencli/plugins/`
- plugin manifests

This is stable enough if we ever want to author OpenCLI-native extensions.
But this should still be treated as **OpenCLI-side extension**, not our core architecture.

## 4.3 Unstable/high-coupling boundary
The least safe boundary is:
- direct imports from `dist/src/*.js`

Reasons:
- not documented as public library API
- internal refactors could break imports
- would raise maintenance cost sharply

---

# 5. What this means for our architecture

## 5.1 OpenCLI should be treated as a backend, not as our contract owner
Because OpenCLI is command-centric, the safest model is:
- our contracts stay ours
- OpenCLI fulfills some capabilities behind a wrapper

This strongly supports:
- ports/adapters
- anti-corruption layer
- our own facade/tool surface

## 5.2 We should not try to make our toolchain equal to OpenCLI's command registry
That would be a subtle trap.

Our toolchain needs:
- cross-backend composition
- explicit plan model
- backend selection per capability
- artifacts/validation/runtime semantics
- AI harness intervention

OpenCLI's command system is useful, but too narrow to be our top-level abstraction.

## 5.3 We can still use OpenCLI as an important implementation substrate
Especially for:
- browser-assisted discovery
- browser action primitives
- site commands that already exist
- fast adapter experiments
- optional agent-driven website operations

This is valuable, and we should not ignore it.

---

# 6. Reuse candidates vs no-go areas

## 6.1 Strong backend-reuse candidates
- `opencli browser ...` primitives
- `opencli list` / command discovery as a source of backend capability inventory
- existing built-in adapters for supported sites
- external CLI hub behavior where relevant
- optional OpenCLI-side adapter authoring workflow for experiments

## 6.2 Weak or risky reuse candidates
- direct imports from internal JS modules in `dist/src/`
- OpenCLI registry as our own capability catalog
- OpenCLI execution model as our plan model
- OpenCLI browser workspace/session state as our runtime state model

## 6.3 Areas we should keep firmly ours
- evidence schema
- capability catalog
- plan schema
- backend-selection policy
- artifact contracts
- validators
- run-meta/resume semantics
- AI harness modes and intervention points
- product orchestration

---

# 7. Honest conclusion

## Can OpenCLI be called in pieces?
Yes — **at the command/tool boundary**.
That is the right level to start from.

## Is OpenCLI only a whole-flow runtime?
Not completely. Internally it is modular, and externally it already exposes many granular browser commands.
But its core operating model is still command-centric, not "your embedded orchestration library".

## Should we deep-import internal modules?
No. That would create exactly the maintenance burden we want to avoid.

## Best integration interpretation
OpenCLI is best treated as:

## **a modular command backend with browser/discovery strengths**

not as:
- our core contract layer
- our planner
- our runtime owner
- our artifact/validation framework

That is the honest line.

---

# 8. Recommendation derived from runtime study

Use OpenCLI like this:

1. **Wrap the CLI surface first**
2. **Map its commands into our capability model**
3. **Let our planner choose when to call it**
4. **Keep runtime state, evidence, artifacts, and orchestration on our side**
5. **Only consider deeper integration later if repeated evidence proves it is worth the coupling**

This is the lowest-regret path.
