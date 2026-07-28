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
