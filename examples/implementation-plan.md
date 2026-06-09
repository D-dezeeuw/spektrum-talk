# Spektrum — Reverse Implementation Plan

This document engineers the build order of Spektrum.
In dependency order: each phase only depends on phases above it, and every task
maps to a concrete piece of the implementation (`spektrum.js`, the
companions, the tests, and the tooling).

The engine is a single file (>1500 LOC), zero runtime dependencies, ESM-only,
with a per-file gzip size budget enforced in CI. Every mutation is recorded so
any past state is replayable, and the whole surface is designed to be driven by
an LLM agent (orient → speculate → explain → commit). Those four properties are
constraints, not features — they gate every task below.

Checklist legend: `[  ]` not started · `[ ~]` in progress · `[ x]` done.

----

## Phase 0: Project foundation & non-negotiable constraints

**Description:** Stand up the repository, tooling, and the constraints that
every later phase must respect. Spektrum's value proposition *is* its
constraints (tiny, auditable, zero-dep, deterministic, agent-native), so they
are encoded as gates from day one rather than retrofitted. The output of this
phase is an empty-but-buildable project: a package that resolves, lints,
typechecks, tests, builds, and size-checks — even before any engine code exists.

**Tasks (to-do list):**

[  ] Author constraint docs: Write `docs/constraints.md` (single file, zero runtime deps, enforced size budget, synchronous test surface, readability over micro-optimization, agent-native from day one) and `docs/philosophy.md` (non-goals: not an SPA framework, not an ORM, not a diff engine). These are the acceptance criteria for everything after.

[  ] Initialize the package: Create `package.json` — `"type": "module"`, `main`/`types`/`unpkg`/`jsdelivr` pointing at `spektrum.js`/`.d.ts`/`.min.js`, `"engines": { "node": ">=22" }`, MIT license, keywords, repository. Leave the `exports` map minimal for now (just `"."`); subpaths are added as companions land.

[  ] Pin dev-only toolchain: Add devDependencies — `esbuild` (minify/bundle), `eslint` v9 (flat config), `typescript` + `typedoc`, `@happy-dom/global-registrator` (DOM in tests). Zero runtime dependencies, ever.

[  ] Wire npm scripts: `test` (`node --test tests/*.test.js`), `lint` (`eslint .`), `typecheck` (`tsc --noEmit`), `build` (esbuild minify of `spektrum.js` + companions to `.min.js`, ESM, legal-comments stripped), `size` (`node scripts/size.js`), `start` (static server for the example), `docs` (typedoc).

[  ] Configure lint/type config: `eslint.config.js` flat config with browser + node globals (no-var, prefer-const, eqeqeq smart, unused-vars with underscore escape); `tsconfig.json` targeting ES2022, strict, DOM libs, `noEmit`, bundler resolution, including `.d.ts` and the type tests.

[  ] Build the size-budget enforcer: Write `scripts/size.js` as a zero-dep script that reads each `.min.js`, gzips with Node's built-in `zlib`, and asserts raw + gzip byte counts against per-file caps, exiting non-zero on breach. Every future cap bump must be justified in `CHANGELOG.md`.

[  ] Stand up the test harness: Establish `tests/` using `node:test`, with happy-dom globally registered for DOM-touching suites. No mocks, no fake timers — `tick()` is synchronous by design and tests exercise real behavior.

[  ] Add repo hygiene: `LICENSE` (MIT), `.editorconfig`, `.gitignore` (node_modules, build artifacts, `notes/`), `CONTRIBUTING.md`, `SECURITY.md`, `README.md` skeleton, and a CI workflow that runs test + lint + typecheck + build + size as merge gates.

----

## Phase 1: Pure utilities & the safe path layer

**Description:** Build the instance-independent foundation: module-level
constants and pure helpers that live *outside* the factory so multiple
instances don't each carry a copy. This is the dotted-path data layer
(`'user.email'` → nested object access/assignment) plus the security guards
(prototype-pollution rejection, `javascript:` scheme guard) that every higher
layer relies on. All of it is synchronous, side-effect-free, and unit-testable
in isolation.

**Tasks (to-do list):**

[  ] Define module constants: `MUSTACHE` regex (`{{ expr }}`), a namespaced `warn()` that prefixes `[spektrum]` and always returns `undefined` (so `return warn(...)` from guards can't smuggle a value back), `JS_SCHEME` regex, and `KEY_GATE` (maps `enter`/`esc`/`tab`/`shift`/`cmd` to `ev.key` matches or `ev` properties).

[  ] Implement the prototype-pollution guard: `SAFE_KEY(k)` rejecting `__proto__`/`prototype`/`constructor`. Thread it through every path walk, merge, and clone so attacker-controlled strings (persisted paths, JSON payloads) can't reach `Object.prototype`.

[  ] Implement path read helpers: `getPathObj(obj, path)` (reduce over dotted segments, null-safe) and `isPath(obj, path)` (every segment resolves AND is `SAFE_KEY`). Export `getPathObj` — companions need it.

[  ] Implement path write helpers: `createNestedObjects(obj, path)` (materialize *intermediate* segments only — never the leaf, which previously polluted state with `{}` placeholders that bindings read back as `"[object Object]"`) and `setPathValue(obj, path, value)` (walk creating parents, assign leaf). Both bail on unsafe segments.

[  ] Implement structural merge & clone: `deepMerge(target, source)` (recursive in-place; merges plain objects, overwrites arrays/primitives — supports sub-path array edits like `{items: {1: {...}}}`) and `deepClone(v)` (owns its whole object graph so stored snapshots can't be aliased and corrupted by later live mutation).

[  ] Implement small pure utilities: `clearObject(obj)` (delete all own keys in place), `parseValue(s)` (coerce a `data-value` string: `""`→undefined, bool literals, numeric, else string), `callAll(fns)` (invoke a cleanup list), plus `histId(el)`/`fnVal(el, v)` helpers for built-in fns.

[  ] Test the path & safety layer: Unit tests for round-tripping nested paths, array sub-path merges, NaN/Infinity pass-through in clone, and explicit prototype-pollution attempts via `__proto__`/`constructor` paths and JSON keys.

----

## Phase 2: Expression engine & path extraction

**Description:** Templates contain real JS expressions (`{{ user.name.toUpperCase() }}`,
`:disabled="loading"`). This phase compiles those to functions and — critically
— extracts the *state paths* each expression reads, which is what makes
fine-grained reactivity possible (a binding only re-runs when a path it
actually references changes). Compilation is cached and CSP-escapable via
`precompile()`. Scope translation (loop aliases → real state paths) is wired
here but consumed later by `data-each`.

**Tasks (to-do list):**

[  ] Build the compile cache: `evalCache` Map with `EVAL_CACHE_LIMIT` (500) and FIFO eviction (`cacheSet`) so long-running pages minting many distinct expressions stay bounded. Map insertion order gives FIFO for free.

[  ] Implement `evalExpr(expr)`: Normalize dotted-numeric segments (`grid.1.0` → `grid[1][0]`) so JS can parse indices, compile via `new Function('state','scope', 'with (state) with (scope||{}) { return (expr); }')` — scope is the inner `with` so loop variables shadow state on collision — and wrap in an inner try/catch so not-yet-populated paths render `undefined` instead of throwing.

[  ] Add the CSP escape hatch: Export `precompile(source, fn)` that seeds the cache directly, so build-time tooling can register every expression and `new Function` is never reached under strict CSP. On compile failure, `warn()` and return a `() => undefined` stub.

[  ] Implement path extraction: `extractPaths(expr, scope)` — strip string literals first (honoring backslash escapes) so identifiers inside quotes don't leak as subscriptions, scan with an `IDENT` regex (lookbehind so `a.b.c` is one path not three), and filter `RESERVED` heads (`Math`, `JSON`, `true`, `Array`, …). Over-subscribing to a dead path is benign, so the reserved list stays conservative.

[  ] Wire scope translation: Add the module-level `scopePaths` WeakMap (scope object → alias→state-path map) and `eachHosts` WeakSet. In `extractPaths`, rewrite aliased heads (`item.name` → `users.3.name`) and skip scope-only metadata vars (`index`, `$first`) — those carry no path and are re-rendered explicitly by the list binder.

[  ] Implement `applyClass(el, v)`: Accept string (overwrite `className`), array (filter + join), or object (toggle per key via `classList.toggle`). Pulled out as a pure helper because `:class` needs it.

[  ] Implement the text-node walker: `walkTextNodes(root, visit)` — a hand-written iterative (explicit-stack) DFS, because happy-dom's TreeWalker returns nothing for `SHOW_TEXT` filters, and recursion risks stack overflow on pathological depths. Push children in reverse for left-to-right order.

[  ] Test the expression layer: Tests for dotted-numeric normalization, scope shadowing, reserved-word filtering, string-literal stripping, cache eviction at the limit, and `precompile()` cache hits bypassing `new Function`.

----

## Phase 3: Reactive core — factory, state/delta/tick, mutators, systems, hooks

**Description:** The heart of the engine. `createSpektrum(opts)` returns an
isolated instance owning its own state, delta, history, systems, fns, refs, and
intents. Mutations land in `appStateDelta`; `tick()` drains the delta to
quiescence, merging into `appState` and firing only the systems whose
subscribed paths intersect the delta. This is the reactive loop everything else
plugs into. (History *recording* happens here too, but replay/time-travel is
Phase 5.)

**Tasks (to-do list):**

[  ] Scaffold the factory: `createSpektrum(opts = {})` reading `historyLimit`, `snapshotEvery`, `forkLimit` (default 50). Declare instance state: `appState`, `appStateDelta`, `history`, `snapshots`, `forks`, `systems`, `fns`, `refs`, `intents`, `cursor`, `replaying`, and the multi-subscriber hook Sets.

[  ] Implement multi-subscriber hooks: `sub(set)` factory producing `onError`/`onRecord`/`onFork` — each appends a subscriber and returns an unsubscribe; passing `null` clears all. (Pre-1.0 single-handler-replace silently collided when, e.g., autoSave overwrote a user's onRecord.) Add `safeFire(handlers, name, ...args)` isolating each subscriber's throw.

[  ] Implement the record path: `checkPath` (materialize parents in both delta and state), `applyEntry(e)` (checkpoints are inert markers; `set` assigns; `add` accumulates on the latest numeric value — delta, then state, else 0), and `record(entry)` (apply → push → advance cursor; fire `onRecord`, but NOT during replay).

[  ] Implement the public mutators: `setValue(path, value, id?)` (absolute write, id defaults to `set:<path>`), `addValue(path, value, id?)` (additive numeric, id defaults to `add:<path>`), `trigger(id, path, value)` (back-compat alias for `addValue` with the old argument order), and `checkpoint(name, metadata)` (tagged marker, no state effect). Reject empty paths with a warn.

[  ] Implement subscriptions: `addSystem(paths, fn)` storing `{ paths, fn, topKeys, active }` (precompute `topKeys` for cheap delta pre-filtering; `active` flag lets `tick()` skip systems unsubscribed mid-tick) and returning an unsubscribe. Alias `watch = addSystem`; add `removeSystem(fn)`.

[  ] Implement `defineFn(name, fn, meta?)`: Register a `data-fn`-callable handler, attaching optional `{ description, input, output, examples }` meta to the function for `describe()`/MCP introspection.

[  ] Implement `tick()`: Loop while the delta is non-empty — snapshot matching systems (topKeys intersect delta keys AND a subscribed path resolves in the delta), merge delta into state, clear delta, then run the matched-and-still-active systems. Writes during a run are caught by the next pass (fan-out). Cap at 1024 iterations; on overflow raise an `E_TICK_OVERFLOW` error through onError (or warn), clear the delta, and bail.

[  ] Implement error routing & invocation: `routeErr(err, fn, msg)` (onError fan-out or namespaced console.error fallback), `runSystem(sys)` (run one system, route throws), and `callFn(name, fn, ...args)` (invoke a data-fn, routing BOTH sync throws and async-promise rejections — otherwise async handler rejections vanish as unhandled-promise warnings).

[  ] Implement the pump & resets: `run()` (rAF-driven `tick()` loop), `resetState()` (drain cleanups, wipe state/refs/history/snapshots/forks, preserve systems+fns+hooks), and `reset()` (resetState + clear systems; warn on active systems).

[  ] Test the reactive core: Tests for delta→state merge, subscription path matching (whole-object vs leaf), additive accumulation within a tick, fan-out across passes, the 1024-iteration cap, multi-subscriber hook fan-out + unsubscribe, and sync/async error routing.

----

## Phase 4: Derived & async state

**Description:** Two higher-level primitives built on subscriptions:
`computed()` for synchronously-derived values and `addAsync()` for promise-backed
resources that record their lifecycle into history (so a fetch replays without
re-issuing the network call). Both have a subtle shared wrinkle — they write
into *both* state and delta so mid-tick reads see fresh values — which is worth
isolating in its own phase with focused tests.

**Tasks (to-do list):**

[  ] Implement `computed(path, deps, fn)`: Reject self-referential derivations at registration (`path` overlapping any dep — equal/ancestor/descendant — would feed its own delta and burn the iteration cap; throw `E_COMPUTED_SELF_DEP`). Prime synchronously from current state, then re-derive on dep changes, writing the result to BOTH `appState` (mid-tick reads see it) and the delta (fan-out to later passes still fires).

[  ] Implement `addAsync(path, fn)`: Set `${path}.loading`/`.error`/`.data` through `setValue` as the promise progresses (so each phase records and replays). Register the runner in `asyncRunners[path]`. Skip the initial fetch when `${path}` already holds a settled load cycle (the post-`loadHistory` replay case) but keep the runner registered.

[  ] Implement `refresh(path)`: Re-invoke the runner registered under `path` (returns the run Promise, or undefined if never registered) so callers can refetch without holding the handle returned by `addAsync`.

[  ] Test derived & async state: Tests for computed priming + re-derivation, self-dep rejection, the mid-tick fresh-read guarantee, async loading/error/data transitions, settled-skip on re-registration, and `refresh()` re-running the loader.

----

## Phase 5: Time travel — history, snapshots, forks, replay, serialize

**Description:** This is the property that distinguishes Spektrum: every
mutation is in `history`, so `replay(n)` rebuilds any past state. This phase
adds the memory-bounding machinery (`historyLimit` trimming, `snapshotEvery`
for O(K) replay), the branch-preservation model (`forks` from
mutate-while-scrubbed-back), and portable `serialize()`. It extends `record()`
and adds `replay()` on top of the Phase 3 core.

**Tasks (to-do list):**

[  ] Add snapshot capture to `record()`: When `snapshotEvery` is set and `history.length % K === 0`, push `{ index, state: deepClone(stateSnapshot()) }`. Use `stateSnapshot()` (`appState` ⊕ pending delta) so the snapshot reflects what replay lands on, and `deepClone` so it owns its arrays against later in-place mutation.

[  ] Add history trimming to `record()`: When `historyLimit` is exceeded, drop a chunk (`max(1, limit/16)`) at a time to amortize splice cost, decrement `cursor`, and shift/re-index affected snapshots. Document that replay below the surviving window is undefined.

[  ] Implement the fork path in `record()`: On mutate-while-scrubbed-back (`cursor < history.length`), truncate the future, capture the dropped tail on `forks` (`{ entries, forkedAt, ts }`, trimmed to `forkLimit`, skipped when `forkLimit === 0`), invalidate ahead-of-cursor snapshots, and fire `onFork`.

[  ] Implement `replay(n)`: Clamp `n`, set `replaying = true`, wipe state/delta, fast-forward to the latest snapshot `≤ n` (deepClone it in), re-apply entries `startIdx…n` with a `tick()` each, then re-fire every system against the final state (so bindings whose paths left state during the scrub clear stale DOM). Reset `replaying` in a finally-equivalent.

[  ] Implement history views & serialize: `checkpointsOf()` (filtered view: checkpoints + their index, exposed as the `checkpoints` getter), `cursor`/`replaying` getters, and `serialize(opts?)` (default `{ state, history, cursor }`; `includeHistory: false` for state-only; `includeForks: true` to include dropped tails).

[  ] Test time travel: A dedicated branches suite — replay idempotency, snapshot fast-forward correctness vs naive replay, historyLimit trimming + cursor/snapshot re-indexing, fork capture on scrubbed-back mutation, `forkLimit` trimming, and serialize round-trip shapes.

----

## Phase 6: DOM bindings — text, attrs, conditionals, model, ref, intent, action

**Description:** The declarative layer. Each binder wires one directive on one
element and returns an unsubscribe; `bindReactive()` is the shared primitive
that registers a system and fires one initial render (no pre-tick flicker).
This phase covers every per-element directive *except* `data-each` (Phase 7),
plus the built-in `data-fn` handlers. After this phase a flat (non-list) app is
fully reactive.

**Tasks (to-do list):**

[  ] Implement `bindReactive(paths, render, scope?)`: Register the render as a system and immediately invoke it against `stateSnapshot()` (state ⊕ delta) so bindings show post-first-tick values at bind time. Thread `scope` through to the render for loop-variable resolution.

[  ] Implement `bindText(node, scope)`: Remember the original template per text node in a WeakMap (so a data-each re-bind doesn't read the prior render as the new template), bail if no `{{`, extract the union of paths across all placeholders, and re-render by replacing each `MUSTACHE` with its evaluated value (null/undefined → `''`). Text nodes only.

[  ] Implement `bindAttrs(el, scope)`: For each `:attr`, route `:class`/`:className` through `applyClass`, rewrite `javascript:` schemes to `#` on URL-bearing props (`href`/`src`/`action`/`formaction`/`background`/`cite`/`poster`/`data`), map lowercased prop names back via `PROP_ALIAS` (`innerhtml`→`innerHTML`), and route hyphenated names through `setAttribute`/`removeAttribute` (null clears). Property write by default, not `setAttribute`.

[  ] Implement `bindIf(el, scope)`: `data-if` toggles `el.style.display` (`''` vs `'none'`) on truthiness — Vue `v-show` semantics; children stay bound.

[  ] Implement `bindModel(el, scope)`: Parse trailing reserved modifiers (`.lazy`/`.number`/`.trim`) off the right of the path, resolve the path through scope, detect checkboxes (`change` + `.checked`) vs inputs (`input` + `.value`), write state→element reactively, and write element→state through `setValue` on the chosen event with the modifier coercions applied.

[  ] Implement `bindRef(el)` and `bindIntent(el)`: `data-ref="name"` exposes the element on `refs` (cleanup only clears if it still owns the slot). `data-intent="verb.noun"` pushes into `intents[name]` (array; multiple elements per intent) — a pure semantic marker for agent lookup, no behavior. Both return cleanups that splice/delete correctly.

[  ] Implement `bindAction(el, scope)`: Resolve the `data-fn` handler (warn on unknown). Support `data-action="cycle"` (subscribe to `data-id` as a path; requires `data-id`) and `event[.modifier]*` (DOM listener). Parse modifiers: behavior (`prevent`/`stop`/`once`/`self`), listener options (`capture`/`passive`), and key gates (`enter`/`esc`/`tab`/`shift`/`cmd`). Invoke via `callFn` with `(el, state, delta, value, event?, scope?)`.

[  ] Register built-in fns: `setValue`, `addValue`+`trigger` (shared handler), `setText`, `setStyle`, `toggle` — each resolving `data-id` through `resolvePath(scope)` so row-relative ids (`item.count`) work inside a list. `data-value` is read once at bind time (intentionally non-reactive).

[  ] Test the binding layer: A DOM suite covering text interpolation re-render, `:attr` property writes + class forms + URL-scheme rewriting + kebab/alias routing, `data-if` show/hide, two-way `data-model` with every modifier, ref/intent registration + cleanup, and every `data-action` modifier including key gates and `cycle`.

----

## Phase 7: List rendering — `data-each` + the `bindDOM` scan

**Description:** The most intricate binder, given its own phase. `data-each`
supports two authoring forms (container and `<template>`), three reconciliation
behaviors, nesting, and keyed DOM-identity preservation across reorder. It
depends on the scope machinery (Phase 2) and recursively calls `bindDOM` on each
clone. This phase also implements `bindDOM` itself — the top-level scan that
orchestrates all binders in the correct pass order and prevents outer walks from
re-entering inner clones.

**Tasks (to-do list):**

[  ] Implement scope construction: `makeScope(outer, varName, i, items, arrayPath)` building the per-iteration scope (`varName`→item, `index`/`$index`/`$first`/`$last`/`$path`), merging outer scope for nesting (inner shadows on collision), and registering the alias→path map in `scopePaths` (kept off the scope object so `with` can't leak it). Add `resolvePath(path, scope)` to translate row-relative paths to absolute.

[  ] Implement `data-each` form detection: In `bindEach(el, outerScope)`, resolve the array path through scope, read `data-as`/`data-key`, detect `<template>` vs container form, compute the host/anchor pair (template → parent + anchor-before-tag; container → element itself), extract the element template (warn if none), detach the inline container template, and mark the host in `eachHosts`.

[  ] Implement no-key reconciliation: Track `prev` items; on change compute the shared identity-equal prefix and fast-path push (append tail) / pop (remove tail), falling back to full wipe+rebuild on interior change. This optimizes the append-only 90% case (feeds, logs) without keys.

[  ] Implement keyed reconciliation: Evaluate the key expression per item (item bound under `varName`), maintain a `key → { clone, cleanup, index }` cache plus an ordered `live` list, build clones on first sight, and on index change tear down + re-bind the *same* clone with a fresh scope (preserving DOM identity so focus/scroll/input survive reorder). Warn on duplicate keys; remove clones whose keys vanished. Accept `data-stable-key` as a back-compat no-op.

[  ] Implement clone lifecycle helpers: `buildClone` (clone template, set `contain: layout style`, recursively `bindDOM(clone, scope)`), `wipeAll`, `appendFrom`, and `insertAt` (form-agnostic insertion within the owned region), with `live`/`cleanups` bookkeeping so the template-form host's sibling content is never touched.

[  ] Implement `bindDOM(root, scope)`: Idempotency via `boundRoots` WeakSet (skipped on scoped clone re-binds), an `ownedByEach(n)` guard (skip nodes under an inner each-host strictly between them and root), and the fixed pass order — (1) `[data-each]` first (detach templates before other scans enter them), (2) text nodes, (3) one combined element walk doing `:attr` + `data-if`/`model`/`ref`/`intent`/`action` + `data-cloak` strip, including the root element itself. Collect every cleanup into both the local destroy list and instance `allCleanups`; return a `destroy()`.

[  ] Test list rendering: Tests for both authoring forms (including inside `<table>`/`<select>`), no-key push/pop/interior-rebuild, keyed reorder preserving DOM identity + input state, duplicate-key warning, nested `data-each` with outer-alias resolution, non-array type warnings, and `bindDOM` idempotency + correct destroy teardown.

----

## Phase 8: Agent surface — describe / explain / attempt / findByIntent

**Description:** The reason Spektrum exists for an LLM reader. The engine is
small enough to fit in a model's context; these four methods turn that into a
complete operational manifest plus speculative-execution affordances. This is
the orient → speculate → explain → commit workflow that lets an agent drive the
app as a first-class user, with a clean audit trail and safe rollback.

**Tasks (to-do list):**

[  ] Implement `describe()`: Return a one-call manifest — `state`, `cursor`, `historyLength`, `forkCount`, `snapshotCount`, `options`, `systems` (paths + name), `fns` (name + declared meta), `refs`, `intents` (name→count), and `checkpoints`. Cheap: no serialization of history entries themselves.

[  ] Implement `explain(opts?)`: Return a history slice `[from, to)` where each entry is annotated with `triggers` — the systems whose subscribed paths intersect the entry's path. Note in the docs that the subscriber set is the *current* registry, not a historical record (the two coincide for an agent reading its own recent edits).

[  ] Implement `attempt(name, fn)`: Drop an `attempt:<name>` checkpoint, capture `cursor` as the rollback point, create an `AbortController`, run `fn(signal)`, and return a handle `{ result, signal, commit(), discard() }`. `commit()` records an `:commit` checkpoint; `discard()` aborts the signal and `replay()`s back to the start. Guard against double-settle with a `done` flag. Support nesting.

[  ] Implement `findByIntent(name)`: Return a *copy* of `intents[name]` (so callers iterate without racing the registry), empty array when absent. Document that triggering an intent should call the underlying mutator directly rather than synthesizing DOM events.

[  ] Test the agent surface: Tests for the `describe()` manifest shape, `explain()` trigger annotation, `attempt()` commit (records checkpoint) vs discard (replays back, entries land on forks, signal aborts), nested attempts, and `findByIntent` copy semantics. Capture the end-to-end orient→speculate→explain→commit flow in `AGENTS.md`.

----

## Phase 9: Singleton, public exports & TypeScript declarations

**Description:** Assemble the instance's public API object, expose a default
singleton with named re-exports for the common single-instance case, and
hand-author the `.d.ts` that types the whole surface. Types are drift-gated:
a type-test file imports every export and exercises real usage, and `tsc`
catches divergence between source and declarations in CI.

**Tasks (to-do list):**

[  ] Assemble the instance API: Return the public object from `createSpektrum` — live references (`appState`, `appStateDelta`, `history`, `snapshots`, `forks`, `refs`, `intents`), getters (`cursor`, `replaying`, `checkpoints`), and every method (mutators, subscriptions, lifecycle, time-travel, serialize, agent surface).

[  ] Create the default singleton: `const _default = createSpektrum(); export default _default;` plus a destructured named re-export of the full surface, so single-instance apps can `import { setValue, bindDOM, run } from 'spektrum'`.

[  ] Hand-author `spektrum.d.ts`: Type every public export — path-stringly-typed mutators, `SpektrumInstance`, hook return types, the `describe()`/`explain()` manifest shapes, and `createSpektrum` options. Keep it in lockstep with the source by hand (no auto-gen).

[  ] Add the type-drift gate: Write `tests/types/spektrum.types.ts` importing every public export, exercising representative call patterns, and pinning negative cases with `@ts-expect-error`. Wire `tsc --noEmit` over it into CI so type drift fails the build.

----

## Phase 10: Companion — `spektrum/persist`

**Description:** First and smallest companion (~110 LOC). Round-trips history
through Web Storage so an app survives reloads. It subscribes to `onRecord` for
hands-off auto-saving and replays on load. This is the template for all
companions: a single file under `companions/`, its own `.d.ts`, its own test
suite, its own size cap, and a new entry in the `exports` map — nothing leaks
into the core bundle.

**Tasks (to-do list):**

[  ] Implement save/load: `saveHistory(key?)` serializing history to localStorage and `loadHistory(key?)` restoring + replaying it, reusing the engine's `serialize()`/`replay()` so persisted async fetches don't re-issue.

[  ] Implement `autoSave`: Subscribe to `onRecord` (optionally debounced) to persist automatically, returning a stop handle, with a `maxEntries` gate to bound storage. Verify it composes with other `onRecord` subscribers thanks to the multi-subscriber hooks from Phase 3.

[  ] Wire the subpath: Add `companions/spektrum-persist.js` + `.d.ts`, register `"./persist"` in the `exports` map, set its size cap in `scripts/size.js`, and document the storage shape in `docs/modules.md`.

[  ] Test persist: Save/load round-trip, autoSave debounce + stop, `maxEntries` trimming, and coexistence with a user-registered `onRecord`.

----

## Phase 11: Companion — `spektrum/devtools`

**Description:** The dev-time time-travel UI (~160 LOC): a floating scrubber +
state panel that lets you rewind through history and watch state move. It reads
`history`/`cursor` and drives `replay()`. Pure dev affordance — never shipped to
production, never depended on by the core.

**Tasks (to-do list):**

[  ] Implement the scrubber panel: Mount a floating, position-configurable panel rendering a history slider bound to `cursor` and driving `replay(n)` on scrub, plus a live state display.

[  ] Implement mount/unmount lifecycle: A `mount()` returning a teardown that removes listeners and DOM, and an option to dock as a tab (forward-compatible with the Phase 14 dock).

[  ] Wire the subpath: Add the file + `.d.ts`, register `"./devtools"`, set its size cap, and document options in `docs/modules.md` and `docs/time-travel.md`.

[  ] Test devtools: Panel mount/unmount, scrubber→replay interaction, and state-display updates.

----

## Phase 12: Companion — `spektrum/compile` & the strict-CSP path

**Description:** Build-time tooling (~100 LOC) that makes Spektrum deployable
under a strict CSP with no `unsafe-eval`. It scans HTML for every expression and
emits a module of `precompile()` calls so `new Function` is never reached at
runtime. This closes the loop on the expression engine's CSP escape hatch from
Phase 2.

**Tasks (to-do list):**

[  ] Implement expression extraction: `extractExpressions(htmlString)` scanning for `{{ }}`, `:attr`, and `data-if` expressions across the markup, deduplicated.

[  ] Implement source emission: `emitPrecompileSource(exprs)` producing a JS module of `precompile(source, fn)` calls (using the same `with(state)` form, a language feature not eval) to import before `bindDOM()`.

[  ] Wire the subpath & document: Add the file + `.d.ts`, register `"./compile"`, and write `docs/csp.md` with the end-to-end build-step recipe.

[  ] Test compile: Extraction coverage across directive types, emitted-module correctness, and a round-trip proving the precompiled cache hits before `new Function`.

----

## Phase 13: Companions — `spektrum/mcp` & `spektrum/agent`

**Description:** The agent-integration stack. `spektrum/mcp` (~280 LOC) turns
the Phase 8 agent surface into an SDK-agnostic MCP tool catalog; `spektrum/agent`
(~565 LOC) is an in-page LLM chat panel that drives the app through that
catalog. Both are gated deny-by-default on writes — agent access to state is
opt-in, never implicit.

**Tasks (to-do list):**

[  ] Implement `createTools(spektrum, opts?)`: Emit plain MCP tool definitions (no SDK lock-in) over state-read, `setValue`/`addValue`/`trigger`, `describe`, `explain`, `attempt`, `replay`, `checkpoint`. Gate writes deny-by-default; support `protectedPaths` (string prefix + RegExp) and `allowAllPaths`. Each tool exposes a `handler` to hand to any MCP server SDK.

[  ] Implement the in-page agent panel: `mount()` rendering an LLM chat UI wired to Anthropic/OpenAI/OpenRouter, using the MCP catalog as its internal tool set, with a configurable system prompt, `protectedPaths`, and API key in localStorage. Default to the latest Claude models for the Anthropic provider.

[  ] Wire the subpaths: Add both files + `.d.ts`, register `"./mcp"` and `"./agent"`, set size caps, and document provider config + the deny-by-default posture in `docs/modules.md` and `SECURITY.md`.

[  ] Test the agent stack: MCP tool catalog tests (protected paths via prefix + RegExp, deny-by-default, write gating) and in-page agent tests (provider selection, system prompt, tool routing, state binding).

----

## Phase 14: Companions — `spektrum/inspect` & `spektrum/dock`

**Description:** Developer-experience tooling. `spektrum/inspect` (~520 LOC) is a
hover-to-inspect bindings panel + mutation tracer + static linter; `spektrum/dock`
(~280 LOC) is a shared tabbed container so multiple dev companions live in one
UI without coupling to each other. These round out the dev-time surface.

**Tasks (to-do list):**

[  ] Implement the inspector: `mount()` with Elements (hover→binding tooltip), Mutations (filterable tracer over `onRecord`), and Lint tabs, plus UI-free helpers `readBindings()`, `whoSubscribesTo()`, and `lint()` (flag stray `{{}}` in plain attributes and undefined `data-fn` references).

[  ] Implement the dock: `mount()` creating a collapsible edge container, a `registerPanel()` API so companions opt in without coupling, and `findDock()` auto-discovery so devtools/inspect/agent can self-attach as tabs.

[  ] Wire the subpaths & document: Add both files + `.d.ts`, register `"./inspect"` and `"./dock"`, set size caps, document in `docs/modules.md`, and retire the historical `docs/inspect-design.md` to the archive.

[  ] Test inspect & dock: Inspector element/mutation/lint behavior and dock register/activate/close + integration with the other companions.

----

## Phase 15: Build, size budget, docs, example app & release

**Description:** Final hardening and the public-facing surface. Produce the
minified bundles, lock the size caps, write the documentation set and the
reference example, and assemble the release artifacts. This phase makes the
project shippable and keeps it shippable (CI gates, changelog discipline).

**Tasks (to-do list):**

[  ] Produce & cap the bundles: Run the esbuild `build` over the core + every companion, then set each per-file raw + gzip cap in `scripts/size.js`, with a `CHANGELOG.md` rationale entry for every cap. Confirm the core lands at ~13 KB min / ~5.5 KB gzip.

[  ] Write the documentation set: `docs/api.md` (every export with examples), `docs/bindings.md` (all directives, modifiers, URL safety, `data-cloak`), `docs/time-travel.md`, `docs/modules.md` (per-companion API), `docs/trade-offs.md`, and a `docs/README.md` index. Keep them hand-written — each page answers a real question.

[  ] Build the reference example: `example/index.html` + `example/app.js` exercising the full surface — two isolated instances, counter + basket with keyed `data-each`, persist, devtools, and the agent panel — runnable via `npm start`.

[  ] Author the agent tutorial: Write `AGENTS.md` — the full orient/speculate/explain/commit walkthrough against the basket demo, plus the author checklist (`data-intent` on interactive elements, `defineFn` metadata, exposing the instance).

[  ] Finalize release infrastructure: Complete `README.md` (pitch, quick start, docs index, shields), the CI gates (test + lint + typecheck + build + size), the `files` allow-list in `package.json` (ship only `spektrum.js`/`.min.js`/`.d.ts` + `companions/`), and `typedoc.json`. Tag and publish.
