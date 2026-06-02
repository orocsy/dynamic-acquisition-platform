# Pre-Phase-3.2 Consolidation Plan

**Status:** Proposed — awaiting review. No code written yet.
**Goal:** Resolve the 5 review findings before building Phase 3.2 (daemon health/start boundary), so the daemon client and every later slice (3.3–3.7) sit on consolidated, enforced foundations.
**Invariants held throughout:** core never imports product code; `runtime` stays browser-free; `contracts`/`safety` remain dependency-free leaves.

---

## TL;DR recommendation

| # | Item | Order | Effort | Blocks 3.2? | New dep |
|---|------|-------|--------|-------------|---------|
| 5 | Boundary lint (dependency-cruiser) | 1st | S | No (hygiene) | `dependency-cruiser` (dev) |
| 2+4 | Shared `src/safety/` leaf + ref delimiter guard | 2nd | M | **Yes** (daemon client reuses it) | none |
| 3 | Commit to brands (drop `\| string`) | 3rd | M | **Type convention** 3.2 builds on | none |
| 1 | Contracts single source of truth (zod) | 4th | L | No (matters at 3.4) | `zod` (runtime) |

**Total: ~3–4.5 days.** Only items 2 and 3 strictly gate 3.2 (one for code reuse, one for the ref-type convention the daemon client will adopt). Items 5 and 1 are "do now while we're in here" — 5 because it should guard the refactors that follow it, 1 because it's the heaviest and you may want to approve the runtime dep first.

---

## Recommended order & dependency rationale

```
C1: item 5  (lint/boundary guard)      ──┐ establishes the structural rule first,
C2: item 2+4 (safety leaf + delimiter) ──┤ so every refactor below is provably boundary-safe
C3: item 3  (enforce brands)           ──┤ and 3.2's new ref types land on the final convention
C4: item 1  (zod contracts SSOT)       ──┘ heaviest/riskiest, least coupled to 3.2 → last
```

- **5 before everything:** it's infra-only and turns "runtime stays browser-free / core never imports product" into a CI-enforced fact. Landing it first means the C2/C3/C4 refactors (which move files between layers) cannot silently violate a boundary — the guard catches it in `npm run lint`. Rules that reference `src/safety` simply match nothing until C2 creates it (dependency-cruiser does not error on no-match rules).
- **2 before 3.2:** the daemon client (`ensureHealthy`) must return *sanitized* health diagnostics and must keep raw debug websocket URLs out of public results (LLD §5.4/§5.6). That's exactly the redaction/sanitizer/opacity logic being consolidated. Build the client on the shared leaf, not a 5th copy.
- **3 before 3.2:** 3.2 introduces `BrowserDaemonRef`, `BrowserDaemonId`, `BrowserDaemonVersion`. Decide the brand convention before writing them so the daemon client isn't retrofitted later.
- **1 last:** Phase 3.2 is daemon health — it emits no `Evidence`, so the contracts SSOT doesn't block it. It becomes load-bearing at **3.4** (network→evidence bridge). It's the largest blast radius and adds the first runtime dependency, so it's the cleanest to isolate and the most reasonable to defer if you want to start 3.2 sooner.

> If you'd rather start 3.2 ASAP: the minimum viable prefix is **C1 → C2 → C3**, then start 3.2, and slot **C4 in immediately before 3.4**. Flagging that as an option; default plan does all four first per your instruction.

---

## Item 5 — Boundary enforcement + real lint  *(commit C1)*

**Problem:** the only thing enforcing "runtime stays browser-free" is a regex grep in `test/browser-types.test.js` (brittle: misses deeper paths, re-exports, cycles). `npm run lint` is `echo "lint not configured yet"`.

**Approach:** add **dependency-cruiser** (purpose-built for forbidden-import rules, one config, one devDep — lighter than standing up full ESLint just for this). Encode the architecture as rules:

- `runtime` → may not depend on `browser`, `discovery`, `adapters`, `planning`, `contracts`.
- `contracts` → leaf: may not depend on any other `src/*` (backend-neutral).
- `safety` (created in C2) → leaf: node builtins only.
- `browser` → may depend on `runtime` (types), `safety`; may not depend on `discovery`, `adapters`, `planning`.
- `discovery` → may depend on `contracts`, `safety`; not on `browser`/`runtime`.
- no module may import from `dist/`.

**Files touched**
- `package.json` — `lint` script → `depcruise src --config .dependency-cruiser.cjs`; add to `check` (`typecheck && lint && node scripts/check-contracts.js`); add `dependency-cruiser` devDep.
- `.dependency-cruiser.cjs` — new config (rules above).
- `test/browser-types.test.js` — keep the fast runtime-browser-free smoke test (it runs under `node --test` with zero extra tooling) **and** rely on cruiser as the authoritative structural check. Decision below if you'd rather delete the regex test.

**New deps:** `dependency-cruiser` (devDependency). Fits the near-zero-runtime-deps ethos — build/CI only, zero runtime footprint.

**Tests:** no behavior tests change. `npm run lint` becomes a real gate. May surface a pre-existing violation (good — fix in this commit if so). 58 tests unchanged (or 57 if we delete the regex test).

**Risk/blast radius:** very low — config + script.

---

## Item 2 — Shared `src/safety/` leaf  + Item 4 — ref delimiter guard  *(commit C2)*

**Problem (item 2):** the same security logic is copy-pasted with subtle drift:
- 3 URL sanitizers that don't even agree (`sanitizeUrlForEvidence` uses `origin+pathname`; `sanitizeRuntimeUrl` / `sanitizeBrowserUrl` use `search=''; hash=''` + `toString()`, which *preserves userinfo* `user:pass@host`).
- 4 credential/profile regex copies (`runtimeRedaction`, `browserRedaction`, `browserObservation`, `browserRef`) — superset drift = leak risk.
- 2 opacity predicates with different unsafe patterns (`isOpaqueBrowserRef` strict vs `isOpaqueBrowserSessionRef` loose); the loose one re-checks persisted refs in `inMemoryCheckpointStore`.

**Problem (item 4):** `createBrowserSessionRef` builds `daemon:${daemonId}:session:${runId}` but `isOpaqueBrowserRef` does **not** reject `:`. So `daemonId="a:b"` yields the ambiguous `daemon:a:b:session:run` — un-parseable in 3.6 resume recheck.

**Approach:** create `src/safety/` as a pure leaf (node builtins only):

```
src/safety/
  sanitizeUrl.ts       # ONE canonical sanitizer: origin + pathname (drops query, hash, userinfo)
  sensitivePatterns.ts # ONE SENSITIVE_KEY_PATTERN, SENSITIVE_HEADER_PATTERN, PROFILE_LIKE_VALUE_PATTERN (superset of all 4)
  opaqueRef.ts         # ONE isOpaqueRef(value) (superset unsafe pattern, INCLUDING the ':' delimiter) + makeStructuredRef()
  index.ts
```

- **Canonical sanitizer = `origin + pathname`** (matches discovery, strictly safer than the runtime/browser `toString()` variants — drops `user:pass@`). Recommend this; minor behavior decision below.
- **Opacity predicate = superset** of both current patterns (the stricter browser set wins) **plus `:`** so structured-ref delimiters can't appear inside parts (resolves item 4). `createBrowserSessionRef` validates each part with it and **throws** on a delimiter (recommend reject over escape: parts are ids we mint, rejecting is simpler and keeps the scheme parseable).
- **Redactor walk functions stay where they are for now** (`redactRuntimeData`, `redactBrowserDiagnosticData`) — they have genuinely different key policies (runtime's `SAFE_PERSISTED_METADATA_KEYS` / `browserSessionRef` exception vs browser's `BROWSER_REF_KEY_PATTERN`). They become thin wrappers that import the shared **patterns + sanitizer + predicate**. This kills the dangerous drift (the regexes/sanitizer) without over-coupling two layers' redaction semantics. A unified `createRedactor(options)` core is an optional later refactor, not this commit.

**Files touched**
- New: `src/safety/*` (above) + `test/safety.test.js`.
- `src/runtime/runtimeRedaction.ts` — import `sanitizeUrl`, patterns, `isOpaqueRef` from `safety`; delete local copies; `isOpaqueBrowserSessionRef`/`redactBrowserSessionRef` delegate to `safety`.
- `src/browser/browserRedaction.ts` — same; delete local sanitizer/patterns.
- `src/browser/browserObservation.ts` — import `SENSITIVE_HEADER_PATTERN` from `safety`.
- `src/browser/browserRef.ts` — `isOpaqueBrowserRef` → `safety.isOpaqueRef`; `createBrowserSessionRef` uses `safety.makeStructuredRef` with delimiter guard.
- `src/discovery/network/sanitizeUrlForEvidence.ts` — `sanitizeUrlForEvidence` re-exports `safety.sanitizeUrl`; keep `queryParamNames`/`pathnameSegments` local.

**New deps:** none.

**Boundary check:** `safety` imports only node builtins; `runtime`→`safety`, `browser`→`safety`, `discovery`→`safety` are all core→leaf (allowed). `runtime` still imports nothing browser-y → stays browser-free. Cruiser (C1) verifies this.

**Tests:**
- **Possible behavior shift to verify:** canonicalizing to `origin+pathname` may change a few asserted URLs in `runtime-token-redaction.test.js` (e.g. default-port / trailing differences). `browser-redaction.test.js` already expects `https://example.com/account` (= origin+pathname) so it should pass unchanged. Plan: run, diff, update expectations only where the *new* output is the intended safer form.
- **New `test/safety.test.js`:** sanitizer (incl. userinfo stripping), each pattern, `isOpaqueRef`, and the **delimiter guard** (`createBrowserSessionRef({daemonId:'a:b',...})` throws).
- Net: 58 → ~58 + new safety cases; expect 0–2 expectation edits in runtime redaction.

**Risk/blast radius:** **medium** — touches 3 redaction sites + discovery, all security-sensitive. The real risk is redaction *behavior drift* if the superset pattern over/under-matches; mitigated by the existing 58 tests + new safety tests + a careful old-vs-new pattern coverage diff in the PR.

---

## Item 3 — Commit to brands (drop `| string`)  *(commit C3)*

**Decision: commit to brands** (recommended) rather than delete. Phase 3 threads several look-alike string refs (`BrowserDaemonId`, `PageTargetRef`, `BrowserSessionRef`, `BrowserObservationId`, `RunId`) through checkpoints and resume; nominal typing catches a whole class of "passed a pageTargetRef where a daemonId was expected" bugs that are realistic in that code. The `RunId` alias is *already* a pure brand and the runtime already typechecks — the regression is the `| string` on the **field declarations** (e.g. `RunCheckpoint.runId`, `browserSessionRef?: BrowserSessionRef | string`), which makes the brand decorative. We realign to the convention runtime's aliases already imply.

**Approach**
- Add one mint/cast helper in `src/safety/` (or a small `src/brand.ts`): `export const brand = <T extends string>(s: string) => s as T;` — used at trust boundaries (deserialization, fixtures) so committing to brands stays ergonomic.
- Drop `| string` from internal field declarations in `runtime/types.ts` and `browser/types.ts` / `browserObservation.ts`.
- Constructors return the **pure** brand: `createBrowserSessionRef(...): BrowserSessionRef` (no `| string`).
- At the JSON/fixture edges, cast once via `brand<T>()`.

**Files touched**
- `src/runtime/types.ts`, `src/browser/types.ts`, `src/browser/browserRef.ts`, `src/browser/browserObservation.ts`.
- `src/runtime/typeContractFixtures.ts` and any `.ts` fixtures assigning raw strings to branded fields → wrap with `brand<T>()` / `as T`. **This is the main blast radius** (compile-time only).
- `src/runtime/inMemoryCheckpointStore.ts` if it assigns refs.

**New deps:** none.

**Tests:** `.js` tests are **runtime-unaffected** — they pass plain strings and the functions still accept them at runtime; only `.ts` compilation tightens. So no behavior-test rewrites. `npm run typecheck` must stay green → fix `.ts` fixtures with casts. Optional: add a brand round-trip assertion. Net 58 unchanged.

**Risk/blast radius:** low–medium, **compile-time only**, mechanical. The work is finding every `.ts` site that feeds a raw string into a now-pure-branded field.

---

## Item 1 — Contracts single source of truth  *(commits C4a, C4b)*

**Problem:** `.ts` types and `.js` validators are maintained separately and drift (`Evidence` exists as both `contracts/evidence.schema.js` and `discovery/network/types.ts:91`). The `.js` validators are shallow — `validateEvidence` checks only top-level required keys + that arrays are arrays; the nested observation/requestFamily/strategySignal shapes the normalizer emits are **not validated at all**.

**Decision needed: zod vs ajv + ts-json-schema-generator. Recommend `zod`.** Why:
- **Single source of truth, zero drift:** define the schema once, `type X = z.infer<typeof XSchema>`. Types and runtime validation cannot diverge — which is the entire point of a contracts library.
- **Deep validation for free** — the actual upgrade we want.
- **Less machinery than the dependency-light route.** ajv + ts-json-schema-generator means: keep hand-written TS types as source, run a codegen step in build/CI, manage generated JSON-Schema artifacts, configure ajv. To get to *zero* runtime dep you'd use ajv-standalone (precompiled validators) — more build complexity for worse DX, on a 5-contract library maintained by one dev.
- **Honest tradeoff:** zod would be the project's **first runtime `dependency`** (today: only `@types/node` + `typescript`, both dev). For a library meant to be *consumed* by other projects, that propagates zod to consumers. I think that's justified here (zod is the de-facto standard for exactly this, small, well-maintained) — but it's a values call, so it's **decision #1 below**. If you want devDep-only, the fallback is ts-json-schema-generator (dev) + ajv-standalone (precompiled, ~zero runtime).

**Approach (zod path)**
- Add `zod` to `dependencies`.
- Convert `src/contracts/*.schema.js` → `.ts`: `export const EvidenceSchema = z.object({...}); export type Evidence = z.infer<typeof EvidenceSchema>; export function validateEvidence(x: unknown): { ok: boolean; errors: string[] } { const r = EvidenceSchema.safeParse(x); return r.success ? {ok:true,errors:[]} : {ok:false, errors: r.error.issues.map(...)} }`. **Keep the `{ok, errors}` return shape** so `check-contracts.js` and `normalizeNetworkEvidence` consume it unchanged.
- **Centralize `Evidence`:** `contracts` owns it (via `z.infer`); `discovery/network/types.ts` imports it and deletes its local copy → kills the dup.
- `src/contracts/index.js` → `index.ts`; delete `validate.js` (zod replaces the hand-rolled helpers).
- **`scripts/check-contracts.js`:** currently `require('../src/contracts')` (source `.js`). After conversion, contracts compile to `dist/` → point it at `../dist/contracts` and ensure `check` builds first: `check` = `build && lint && node scripts/check-contracts.js` (or `typecheck && lint && build && ...`).

**Files touched**
- All of `src/contracts/` (5 schemas + index; remove `validate.js`).
- `src/discovery/network/types.ts` (`Evidence`/`EvidenceObservation` → import from contracts), `normalizeNetworkEvidence.ts` (drop the `as ValidationResult` cast).
- `scripts/check-contracts.js`, `package.json` (`zod` dep + `check` script).

**Tests:**
- **`contracts.test.js`** — currently exercises shallow validators; **rewrite/expand** to cover deep validation (valid + targeted invalid cases per contract). Biggest test change.
- **`network-evidence-normalizer.test.js`** — **risk:** turning on deep validation may reject evidence the normalizer currently emits if its output doesn't fully conform. Plan: align the zod schema with the *actual* emitted shape (or fix the emitter), then confirm green. This is the main correctness payoff and the main risk.
- New: per-contract zod unit tests.

**Risk/blast radius:** **high** (largest) — contract layer + both consumers + check script + first runtime dep. Split into **C4a** (introduce zod, migrate schemas keeping equivalent shallow behavior + repoint check-contracts — stays green) and **C4b** (tighten to deep validation, centralize `Evidence`, fix any normalizer fallout) so each commit is reviewable and green.

---

## Commit-by-commit (each green: typecheck + lint + `node --test` + check)

| Commit | Scope | Gate |
|--------|-------|------|
| **C1** | `chore(lint): dependency-cruiser boundary rules + real lint script` (item 5) | lint passes, 58 tests |
| **C2** | `refactor(safety): shared redaction/sanitizer/opacity leaf + guard ref delimiter` (items 2+4) | 58 + safety tests; verify redaction expectations |
| **C3** | `refactor(types): enforce ref brands, drop \| string` (item 3) | typecheck green after fixture casts; 58 tests |
| **C4a** | `feat(contracts): migrate schemas to zod (behavior-equivalent), repoint check` (item 1a) | 58 tests, check ok |
| **C4b** | `feat(contracts): deep validation + single Evidence source of truth` (item 1b) | expanded contracts tests; normalizer green |

Run `timeout 120 node --test --test-force-exit` per commit if the runner ever hangs on open handles.

---

## Decisions I need from you before starting

1. **Item 1 — runtime dep?** Approve **`zod`** as the project's first runtime `dependency` (recommended), or require devDep-only → I use **ts-json-schema-generator + ajv-standalone** instead.
2. **Item 3 — brands:** confirm **commit to brands** (recommended) vs **delete brands** (treat refs as plain `string`, lean on zod for content validation).
3. **Item 2 — canonical URL sanitizer:** **`origin + pathname`** (recommended, drops `user:pass@`) vs preserve current `toString()` behavior. (I'll default to origin+pathname unless you object.)
4. **Item 5 — tool & the regex test:** **dependency-cruiser** (recommended) vs ESLint `no-restricted-imports` vs both; and keep or delete the existing regex boundary test in `browser-types.test.js`. (Default: dependency-cruiser, keep the test as a fast smoke.)
5. **Scope option:** do all 4 before 3.2 (your stated plan) vs minimum prefix **C1→C2→C3**, start 3.2, slot **C4 before 3.4**.

Defaults if you don't weigh in: zod, commit-to-brands, origin+pathname, dependency-cruiser + keep test, all four before 3.2.
