# Task 5 — Steel ephemeral profile reviewer-fix report

## Scope

- Repository: `Daisuke134/steel-browser`
- Branch: `fix/ephemeral-session-profiles`
- Upstream base: `5880b48c1af107219ff3d904edbb8f6b76bea9b6`
- Initial implementation: `4d2b12f938782477429e3b4dfe164595277b1deb`
- Reviewer-fix implementation: `11584133bd828be15d2354c7ba1291702631f4e5`
- Production/provider/local-browser/Mac-loop actions: none

## Reviewer findings closed

| Finding | Implemented behavior | Regression evidence |
|---|---|---|
| Raw profile path logging | `userDataDir` is redacted at the launch logger boundary; browser-state and preference logs no longer interpolate profile paths | `cdp.service.log-safety.test.ts` |
| Release ordering | Release executes capture → shutdown → delete owned live profile → launch idle profile | call-order test in `session.service.test.ts` |
| Failure cleanup | Owned live/idle profiles are attempted exactly as owned resources across mkdir, launch, capture, shutdown, and idle-launch failures; ownership fields return to `null` on failure | failure-path tests in `session.service.test.ts` |
| Caller-owned safety | Explicit `userDataDir` and `persist` profiles are never registered as owned and are never deleted | explicit/persist tests in `session.service.test.ts` |
| Missing CDP lifecycle split | Added `captureSessionContext()`, `shutdownSession()`, and `launchIdle()` boundaries; compatibility `endSession()` delegates through them | focused suite and API build |

## RED

Command:

```text
./node_modules/.bin/vitest run api/src/services/session.service.test.ts api/src/services/cdp/cdp.service.log-safety.test.ts
```

Observed before implementation:

```text
Test Files  2 failed (2)
Tests       9 failed | 8 passed (17)
```

The failures covered missing capture/shutdown/idle calls and order, missing mkdir/capture/shutdown/idle-launch cleanup, missing launch-option redaction, and raw `getBrowserState` path logging.

## GREEN verification

Focused:

```text
./node_modules/.bin/vitest run api/src/services/session.service.test.ts api/src/services/cdp/cdp.service.log-safety.test.ts
Test Files  2 passed (2)
Tests       17 passed (17)
```

Full API:

```text
npm test -w api
Test Files  11 passed (11)
Tests       90 passed | 2 skipped (92)
```

Build:

```text
npm run build -w api
tsc && npm run copy:templates && npm run copy:fingerprint
exit 0
```

The first build attempt exposed a test-only TypeScript mock-signature mismatch at `session.service.test.ts:146`; the mock was typed to accept the same path/options parameters as `rm`, then focused tests, the full API suite, and the build were rerun and passed.

## Gate state

Implementation and local verification are complete. No deployment or live browser/provider action was performed. The branch is stopped at the scoped re-review gate.

---

## Fix round 4/5 — termination ownership and bounded failure logs

### Root cause and control-flow decision

| Evidence | Root cause | Decision |
|---|---|---|
| `CDPService` handled file-protocol violations with direct `endSession(SECURITY_VIOLATION)` calls | The CDP layer bypassed `SessionService` profile ownership and relaunched the fixed default profile | Route every internal termination event through a reason-bearing SessionService callback |
| The default disconnect handler called `CDPService.endSession()` | Disconnect used `session_end`, skipped owned deletion, and relaunched `steel-chrome` | Add `browser_disconnect` and run the same owned release lifecycle |
| Concurrent explicit release and disconnect each ran their own lifecycle | There was no single-flight release boundary | Coalesce concurrent release calls with one shared release promise |
| `getBrowserState()` and owned cleanup logging retained raw Error message/cause objects | A filesystem error could carry a temporary or caller-owned profile path into logs | Emit fixed bounded messages and fixed cleanup errors without causes |

Puppeteer documents its `Disconnected` event as: “Emitted when Puppeteer gets disconnected from the browser instance.” This is treated as an input event, not as a second owner of the browser lifecycle. Source: [Puppeteer BrowserEvent](https://pptr.dev/api/puppeteer.browserevent).

### Behavioral RED

Initial focused command:

```text
./node_modules/.bin/vitest run api/src/services/session.service.test.ts api/src/services/cdp/cdp.service.log-safety.test.ts
Test Files  2 failed (2)
Tests       6 failed | 17 passed (23)
```

The observed failures proved:

- temporary and caller-owned profile paths leaked through browser-state failure logs;
- a cleanup Error cause exposed an owned profile path;
- file-protocol and disconnect termination executed capture → shutdown → fixed `steel-chrome` launch, with no owned live deletion;
- caller-owned security termination preserved the caller directory but still reused the fixed idle profile.

The concurrent explicit-release/disconnect test separately failed with two captures, two shutdowns, the fixed launch, and the owned launch. The added file-protocol log test separately failed for both temporary and explicit paths before the bounded log change.

### Implemented behavior

| Finding | Behavior after fix | Regression evidence |
|---|---|---|
| Security and disconnect bypass | `CDPService` dispatches `security_violation` or `browser_disconnect` to the reason-bearing handler installed by `SessionService` | real CDP request/disconnect entry tests in `session.service.test.ts` |
| Fixed idle fallback | Compatibility `CDPService.endSession()` now requires an owned idle directory and cannot fall back to `defaultLaunchConfig` | lifecycle tests prove the only termination launch uses a distinct `steel-idle-*` directory |
| Ordering and ownership | Termination executes capture → shutdown(reason) → delete all owned live/previous-idle dirs → launch a distinct owned idle dir | exact event-array assertions |
| Double release | Concurrent explicit release and disconnect await one release promise | race regression test asserts one capture, delete, and idle launch |
| Caller-owned safety | Explicit and persisted profiles remain outside the ownership registry and are not deleted on security termination | explicit security termination regression |
| Failure log safety | Browser-state, file-protocol, and profile-cleanup failures emit fixed messages without raw Error/cause fields | temporary and explicit path log tests |

### Fresh verification

Focused:

```text
./node_modules/.bin/vitest run api/src/services/session.service.test.ts api/src/services/cdp/cdp.service.log-safety.test.ts
Test Files  2 passed (2)
Tests       26 passed (26)
```

Full API:

```text
npm test -w api
Test Files  11 passed (11)
Tests       99 passed | 2 skipped (101)
```

Build:

```text
npm run build -w api
tsc && npm run copy:templates && npm run copy:fingerprint
exit 0
```

`git diff --check` also exited zero.

### Self-review

| Risk | Result |
|---|---|
| Callback recursion/deadlock | Owned shutdown sets the CDP shutdown guard; a racing external disconnect is coalesced by SessionService |
| Double release | Covered by the explicit-release/disconnect race test |
| Delete before capture | Exact order assertion requires capture before shutdown and deletion |
| Caller-owned deletion | Explicit and persisted profiles remain non-owned; the security test asserts no removal |
| Fixed idle fallback | Internal termination entry points never call direct CDP end; compatibility end rejects a missing owned idle dir |
| Log leaks | Tests inspect complete logger argument structures, including Error causes, for temporary and explicit paths |

### Gate state and concerns

The scoped Steel code, API tests, and TypeScript build pass. No image build, deployment, production/provider browser action, or local browser/Mac-loop action was performed. Live container lifecycle behavior and the production continuity proof remain outside this fork gate and must be verified by the parent Task 5 workflow.

---

## Fix round 5/5 — real event wiring, fail-closed disconnect, and complete path-log bounds

### Root cause evidence

| Finding | Reproduced root cause | Decision |
|---|---|---|
| Real Chrome extraction logs | `ChromeContextService` interpolated `userDataDir`, derived LevelDB/session-storage paths, and reader exception messages | Keep paths only as reader inputs; use fixed bounded lifecycle logs and fixed outward extraction errors |
| Plugin/shutdown logs | `PluginManager` and `CDPService.shutdown()` interpolated caught `Error` values, allowing a profile path in the message/cause chain to reach logs | Preserve hook/plugin identity and shutdown stage, but never log caught exception objects/messages |
| Request/response/disconnect lifecycle proof | Round 4 called private handlers directly and replaced capture/shutdown with event-array stubs | Extract the production listener registration into `wirePageEventHandlers` / `wireBrowserEventHandlers`; test emitted events through those exact listeners while keeping real `ChromeContextService`, `captureSessionContext`, `shutdownSession`, and `launchIdle` |
| Pre-handler disconnect rejection | Puppeteer `Browser` is an `EventEmitter`; the async `disconnected` listener rejected when no termination handler was configured | Catch inside the listener-owned path, perform bounded shutdown, emit a fixed log, and never relaunch the fixed profile |

Node documents that EventEmitter listeners are called synchronously and “Any values returned by the called listeners are ignored and discarded.” A rejected Promise therefore needs an explicit owned catch at this boundary. Source: [Node.js Events](https://nodejs.org/api/events.html#asynchronous-vs-synchronous).

### Behavioral RED

Initial log/disconnect RED:

```text
./node_modules/.bin/vitest run api/src/services/session.service.test.ts api/src/services/cdp/cdp.service.log-safety.test.ts
Test Files  2 failed (2)
Tests       4 failed | 26 passed (30)
```

The failures showed both temporary and explicit paths plus derived storage paths in real `ChromeContextService` logs, profile paths from real plugin/shutdown-hook failures, and one captured `unhandledRejection` from an unconfigured disconnect.

Actual-listener RED after replacing the round-4 test entry points:

```text
Test Files  1 failed | 1 passed (2)
Tests       6 failed | 25 passed (31)
```

Five failures were the missing production page/browser wiring seams used by the real launch path; the sixth was the old event-array expectation in the concurrency regression and was replaced with interface and call-order assertions.

### Implemented behavior

| Finding | Behavior after fix | Regression evidence |
|---|---|---|
| Real extraction secrecy | Real `ChromeContextService` receives the true reader path but logs no full path, basename, derived path, Error message, or cause | two real-service tests with temporary and explicit profiles |
| Plugin/shutdown secrecy | Real plugin and shutdown-hook failures emit bounded messages without caught Error data | real `BasePlugin` + real `CDPService.shutdown()` regression |
| File request/response | Both actual page listeners deliver `security_violation` to `SessionService` single-flight | EventEmitter request and response regressions |
| Browser disconnect | Actual browser listener delivers `browser_disconnect`; pre-handler disconnect performs shutdown and resolves without `unhandledRejection` | configured and unconfigured EventEmitter regressions |
| Ordered owned lifecycle | Real capture → real shutdown(reason) → owned deletion → real idle-launch interface, with browser launch mocked only at the external boundary | invocation-order assertions for request, response, and disconnect |
| Fixed profile exclusion | No internal termination launch uses `/tmp/steel-chrome`; explicit/persist profiles remain caller-owned | termination and ownership regressions |

### Startup fixed-profile inspection

| Evidence | Result |
|---|---|
| `browser.ts` launches the default configuration only from the server `onListen` hook | It is startup/idle state, before a tenant session |
| `browser-session.ts` constructs `SessionService` during plugin registration and installs the reason-bearing termination handler before `onListen` runs | The startup browser is not left with the pre-handler disconnect path during normal server startup |
| `SessionService.startSession()` assigns an implicit tenant a fresh `steel-session-*` directory | Tenant state is directed to an owned ephemeral profile |
| `isSimilarConfig()` explicitly compares `currentUserDataDir === nextUserDataDir` | The fixed startup profile cannot be reused for a tenant profile; CDP closes it before launching the distinct session directory |

No concrete path was found for the startup fixed profile to receive tenant `sessionContext` through the `SessionService` lifecycle, so no startup-profile behavior was broadened in this round.

### Fresh verification

Focused:

```text
./node_modules/.bin/vitest run api/src/services/session.service.test.ts api/src/services/cdp/cdp.service.log-safety.test.ts
Test Files  2 passed (2)
Tests       31 passed (31)
```

Full API:

```text
npm test -w api
Test Files  11 passed (11)
Tests       104 passed | 2 skipped (106)
```

Build:

```text
npm run build -w api
tsc && npm run copy:templates && npm run copy:fingerprint
exit 0
```

`git diff --check` also exited zero.

### Self-review

| Risk | Result |
|---|---|
| Listener behavior diverges between tests and launch | Production launch calls the same two wiring methods exercised by the EventEmitter tests |
| Path escapes through nested errors | Test failures carry both path-bearing messages and causes; complete captured logger arguments exclude full path, basename, and derived paths |
| Request listener creates another unhandled rejection | The production listener owns a terminal catch with a fixed message |
| Pre-handler disconnect launches fixed profile | It calls `shutdown(browser_disconnect)` only; no launch or profile allocation occurs |
| Termination mocks hide ordering | Capture, shutdownSession, and launchIdle run their production implementations; only filesystem/readers/browser launch are bounded external fakes |
| Startup default profile receives tenant state | Fresh tenant directories differ, and config reuse compares `userDataDir` |

### Gate state and concerns

`DONE_WITH_CONCERNS`: scoped Steel source, focused/full API tests, build, and diff check pass. No image build/deploy, production/provider browser action, or local browser/Mac-loop action was performed. Live container continuity remains the parent workflow’s post-fork gate.
