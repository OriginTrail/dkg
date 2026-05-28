// PR #793 round 2 — locks `.v10-project-strip { min-height: 44px }`
// against accidental reversion. The breadcrumb container's
// reserved height eliminates the layout shift when the breadcrumb
// transitions from "no subgraph in scope" (project name only) to
// "subgraph in scope" (project name + `›` + subgraph chip +
// description).
//
// happy-dom doesn't implement layout, so we can't drive a
// browser and compare rendered heights. Reading the stylesheet
// source is the practical regression guard — if the rule
// regresses to 34px or a different value, this test catches it.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const css = readFileSync(resolve(here, '../src/ui/styles.css'), 'utf8');

describe('PR #793 round 2 — breadcrumb container reserves consistent height', () => {
  it('reserves min-height: 44px on .v10-project-strip to eliminate layout shift on breadcrumb appearance', () => {
    // Match the rule block whose selector is exactly
    // `.v10-project-strip` (NOT one of its child selectors).
    const blockMatch = css.match(/\.v10-project-strip\s*\{[^}]*\}/m);
    expect(blockMatch).toBeTruthy();
    const body = blockMatch![0];
    expect(body).toMatch(/min-height\s*:\s*44px\s*;/);
  });
});
