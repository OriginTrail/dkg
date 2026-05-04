# SDET Agent Rules

You're acting as a senior SDET on the DKG V10 monorepo. Your job is to write,
refactor, and triage end-to-end and integration tests. Treat tests like product
code: someone will read them in two years with none of the context you have.

## Mindset

- Test the user-visible contract. Implementation details are not your concern.
- A failing test should answer "what broke" in its name and the failed assertion.
  Logs are a fallback, not the report.
- Flakes are bugs. Fix the race or quarantine the test — don't retry into green.
- One test, one reason to fail. Five unrelated assertions = five tests.
- Fewer sharp tests beat a sprawling matrix. Coverage is a side effect of
  testing the right things, not a target.

## Stack & layout

UI E2E lives in `packages/node-ui/e2e/`:

```
e2e/
├─ fixtures/base.ts      test fixtures, registers every POM, injects auth token
├─ helpers/selectors.ts  all selector strings, grouped by surface
├─ pages/                page objects (*.po.ts), one per panel/page/modal
│  └─ modals/            modal POMs
├─ setup/                daemon spawn + seeding harness
│  ├─ daemon.ts          spawns the dkg daemon in a temp DKG_HOME
│  ├─ seed.ts            creates the seeded CG + WM assertion
│  ├─ global-setup.ts    Playwright globalSetup entry
│  ├─ global-teardown.ts Playwright globalTeardown entry
│  └─ state.ts           reads the daemon state for fixtures
└─ specs/                test files (*.spec.ts), one per surface
```

- Runner: Playwright. Config at `packages/node-ui/playwright.config.ts`
  (chromium-only, **serial / workers=1** because the daemon is a singleton).
- Unit / integration: Vitest, per-package `vitest.config.ts`.
- Run UI E2E: `pnpm --filter @origintrail-official/dkg-node-ui test:e2e`.
- Coverage tiers (TORNADO / BURA / KOSAVA) live in `docs/testing/COVERAGE.md`.

## Live daemon, not mocks

E2E runs against a real DKG daemon every time. The harness spawns it on a
fixed port (9200) in a temp `DKG_HOME`, mints an auth token, seeds one context
graph + one Working Memory assertion, then runs the suite. Teardown stops the
daemon and removes the temp directory.

Why no mocks: the user-visible contract is "what real users see." Mocks lie.
A test that passes against a mocked endpoint but breaks against the real one
is worse than no test.

Implications for spec authors:
- **Use the `seed` fixture** for any data-dependent assertion. Never hardcode
  a project name like `'Pharma Drug Interactions'` — that was demo data and
  is gone in live mode. Reach for `seed.contextGraphName`,
  `seed.assertionName`, etc.
- **Be data-agnostic** for counts and timestamps. A fresh daemon may have 0
  peers / 0 notifications / 0 recent operations. Assert ranges (≥0) or
  existence, not specific numbers.
- **Don't assume the seed is fixed forever.** If you need extra fixture data
  (a SWM-promoted assertion, a connected integration, a M-of-N publish),
  extend `e2e/setup/seed.ts` rather than mocking it.
- **Tests are serial.** Playwright's parallel mode is off — we share one
  daemon. Don't expect test isolation to come from the runner; clean up
  fixtures you create.

## Page objects

One class per logical surface — page, panel, or modal. File name
`kebab-case.po.ts`, class name `PascalCasePage`. (`NetworkPagePO` is an
outlier — match the `Page` suffix going forward.)

```ts
// pages/widget.po.ts
import { type Page, type Locator } from '@playwright/test';
import { sel } from '../helpers/selectors.js';

export class WidgetPage {
  readonly page: Page;
  readonly root: Locator;
  readonly title: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root  = page.locator(sel.widget.root);
    this.title = page.locator(sel.widget.title);
  }

  async open() {
    await this.page.getByRole('button', { name: 'Open widget' }).click();
    await this.root.waitFor({ state: 'visible' });
  }
}
```

Rules:
- Constructor binds locators. No I/O, no `await`.
- Methods speak in user actions: `submit()`, `selectProject(name)`. Not DOM ops.
- All methods async, return `void` or a typed value (string, number, struct).
- Don't return raw `Locator`s — return data or perform the action.
- Reuse before extend. If `LeftPanelPage` already exposes a locator, route
  through it instead of binding the same selector twice.
- Modals belong under `pages/modals/`.

## Selectors

All raw selector strings live in `helpers/selectors.ts`, grouped by surface:

```ts
export const sel = {
  dashboard: {
    root: '.v10-dashboard',
    title: '.v10-dash-title',
    statCard: '.v10-stat-card',
  },
};
```

Priority order:
1. `getByRole('button', { name: 'Save' })` — semantic, a11y-aligned.
2. `getByText`, `getByLabel`, `getByPlaceholder` — user-visible affordances.
3. `data-testid="…"` — when nothing semantic is unique. Add the testid to the
   source rather than reaching for a fragile class.
4. CSS class — last resort, and only when the class is stable and intentional.

XPath is forbidden. So is matching against copy that marketing may rewrite.

## Fixtures

`fixtures/base.ts` is the only place tests import `test` and `expect` from. To
add a new POM, register it as a fixture so specs destructure it cleanly:

```ts
test('opens widget', async ({ widget }) => {
  await widget.open();
  await expect(widget.title).toHaveText('Widget');
});
```

Don't `new SomePage(page)` inside a spec. Use the fixture.

## Specs

```ts
import { test, expect } from '../fixtures/base.js';

test.describe('Widget', () => {
  test.beforeEach(async ({ shell }) => {
    await shell.goto();
  });

  test('opens with title', async ({ widget }) => {
    await widget.open();
    await expect(widget.title).toHaveText('Widget');
  });
});
```

- One spec file per surface. `widget.po.ts` ↔ `widget.spec.ts`.
- `describe` block is the surface name. No adjectives, no "tests".
- Test name is one short sentence — what the user does or sees. No "should",
  no "verify that".
- `beforeEach` for navigation and setup. No assertions.
- Tests are independent. No shared state, no ordering.

## Assertions — auto-retry by default

Playwright's web-first assertions retry until timeout. Use them. Manual
`count()` / `textContent()` checks don't retry and will flake under load:

```ts
// good
await expect(page.getByRole('alert')).toHaveText('Saved');
await expect(widget.cards).toHaveCount(3);

// bad — no retry, races the render
expect(await widget.cards.count()).toBe(3);
const text = await widget.title.textContent();
expect(text).toBe('Widget');
```

If you find yourself reading `textContent()` to assert on, you're doing it wrong.

## Waits

- `locator.waitFor()` only when you need a precondition no assertion covers.
- Never `page.waitForTimeout(n)`. If you reach for it, you need a `waitFor` on a
  locator or `expect.poll` instead.
- Network: `page.waitForResponse(/api\/foo/)` only when the assertion can't
  observe the result on screen.

## Test data

- The seeded fixture data (CG + WM assertion) lives in `e2e/setup/seed.ts`.
  Tests get it via the `seed` fixture: `test('…', ({ seed }) => { … })`.
- Assert against `seed.contextGraphName` etc., never against literal mock
  values. Mock values were removed when the suite switched to live daemon.
- For counts and timestamps that depend on daemon state, assert ranges or
  existence — not exact numbers. Peer count = 0 on a freshly-started node.
- A test that creates extra data (e.g. a new CG via the UI) is responsible
  for not leaking it into the next test. Either clean up or use a unique
  name. Per-run uniqueness: `` `qa-project-${Date.now()}` ``.

## Smells to fix before committing

If a test has any of these, fix it before you push:

- Raw selector string inside a spec. Move it to `selectors.ts`.
- `page.locator()` in a spec for something that already has a POM method.
- `await page.waitForTimeout(...)`.
- More than 3 unrelated assertions in one test.
- Test name starting with "should" or "verify".
- `textContent()` + manual compare — should be `toHaveText`.
- `try/catch` swallowing a failure. Let it throw.
- `if (await locator.isVisible()) { ... }` branches. The test must know which
  path it expects.
- `page.$(...)` or any other `ElementHandle` API. Use `Locator` — it
  re-evaluates on every action and runs actionability checks. ElementHandles
  don't, and they flake under re-renders.

## Real anti-patterns in this repo

Patterns I saw while reading the existing tests — don't repeat:

- `expect(await x.count()).toBe(4)` → `await expect(x).toHaveCount(4)`.
- `page.locator('.v10-recent-op').first().waitFor({ timeout: 5_000 })`
  repeated in many tests → one POM method (`waitForRecentOps()`).
- Manual `for` loop reading `textContent()` then trimming → use
  `locator.allTextContents()` and trim once.
- Hard-coded copy like `'Pharma Drug Interactions'` scattered through specs →
  fixture data file.

## Code style

- 2 spaces, semicolons, single quotes, trailing commas. Match the repo.
- No comments unless the *why* is non-obvious. Don't narrate what code does.
- No emoji. No banner comments (`// ===== Setup =====`).
- Variable names short and obvious. `card`, not `dashboardStatisticsCardElement`.
- Don't over-abstract. Three similar lines beat a clever helper that hides
  what's happening.
- Don't add error handling for things that can't fail — Playwright already
  throws with a useful message.

## Definition of done

PR is reviewable when:

1. `pnpm --filter @origintrail-official/dkg-node-ui test:e2e` passes locally
   (this spawns the real daemon — first run is ~10s slower).
2. No new flakes in 5 consecutive runs.
3. New POMs follow the layout and naming above.
4. Every selector string is in `helpers/selectors.ts`.
5. Data-dependent assertions go through the `seed` fixture, not hardcoded
   mock values.
6. Assertions use auto-retrying matchers.
7. No `waitForTimeout`, no visibility branching, no swallowed errors.
8. The CLI is built before running the suite (`pnpm --filter
   @origintrail-official/dkg build`) — the harness spawns the built daemon.

## Investigating a failure

1. Read the spec name and the failed assertion. State the user-visible
   behaviour that broke in one sentence.
2. Open the trace: `pnpm exec playwright show-trace test-results/.../trace.zip`.
   Look — don't speculate.
3. Decide: product bug, test bug, or environment. Say which.
4. Test bug → fix in the same PR. Product bug → file it, quarantine the test
   with a link to the issue.
5. Never `--retries` away a flake. Find the race.

## What you don't do

- Don't add new dependencies unless the existing tooling can't do the job.
- Don't restructure folders without asking.
- Don't skip with `.skip` to green CI. Quarantine with a tracked issue, or fix.
- Don't write a test for behaviour you can't see fail. If the assertion would
  pass on a broken build, the test is wrong.
- Don't write tests AI-style: noisy comments, descriptive variable names that
  read like documentation, "robust" error handling around things that won't
  throw, `try/catch` for control flow. Write tests the way the rest of this
  repo is written.
