import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ONBOARDING_MARKER_REL,
  ONBOARDING_TRIGGER_TEXT,
  DESCRIPTION_OPEN,
  DESCRIPTION_CLOSE,
  buildOnboardingTrigger,
  extractDescription,
  onboardingMarkerPath,
  writeOnboardingMarker,
  hasOnboardingMarker,
  readOnboardingMarker,
  consumeOnboardingMarker,
  copyToClipboard,
} from './onboarding.mjs';

function mkRoot() {
  const root = mkdtempSync(join(tmpdir(), 'as-onboard-'));
  mkdirSync(join(root, 'agent-scope'), { recursive: true });
  return root;
}
function cleanup(root) { rmSync(root, { recursive: true, force: true }); }

test('ONBOARDING_MARKER_REL is stable, hidden, under agent-scope/', () => {
  assert.equal(ONBOARDING_MARKER_REL, 'agent-scope/.pending-onboarding');
});

test('ONBOARDING_TRIGGER_TEXT starts with the canonical prefix and covers the protocol', () => {
  assert.ok(ONBOARDING_TRIGGER_TEXT.length > 100);
  assert.ok(
    ONBOARDING_TRIGGER_TEXT.startsWith('agent-scope: start task onboarding'),
    'trigger must begin with the documented prefix',
  );
  assert.ok(ONBOARDING_TRIGGER_TEXT.includes('Smart onboarding protocol'));
  assert.ok(ONBOARDING_TRIGGER_TEXT.includes('AskQuestion'));
  assert.ok(ONBOARDING_TRIGGER_TEXT.includes('pnpm task create'));
});

test('buildOnboardingTrigger: without description → description-less trigger', () => {
  const t = buildOnboardingTrigger();
  assert.equal(t, ONBOARDING_TRIGGER_TEXT);
  assert.ok(!t.includes(DESCRIPTION_OPEN));
});

test('buildOnboardingTrigger: embeds the description in a fenced block', () => {
  const desc = 'Refactor peer sync in agent + core packages.';
  const t = buildOnboardingTrigger({ description: desc });
  assert.ok(t.includes(DESCRIPTION_OPEN));
  assert.ok(t.includes(DESCRIPTION_CLOSE));
  assert.ok(t.includes(desc));
  assert.ok(t.includes('DO NOT ask them to describe it again'));
});

test('buildOnboardingTrigger: preserves multi-line descriptions verbatim', () => {
  const desc = 'line one\nline two\n\nline four';
  const t = buildOnboardingTrigger({ description: desc });
  assert.ok(t.includes(desc));
});

test('buildOnboardingTrigger: trims leading/trailing whitespace on description', () => {
  const t = buildOnboardingTrigger({ description: '   hello   \n' });
  assert.ok(t.includes('hello'));
  assert.ok(!t.includes('   hello'), 'leading spaces should be trimmed');
});

test('buildOnboardingTrigger: empty string description → treated as missing', () => {
  const t = buildOnboardingTrigger({ description: '   \n  ' });
  assert.equal(t, ONBOARDING_TRIGGER_TEXT);
});

test('extractDescription: round-trips through a smart trigger', () => {
  const desc = 'Refactor peer sync\nwith workspace auth.';
  const t = buildOnboardingTrigger({ description: desc });
  assert.equal(extractDescription(t), desc);
});

test('extractDescription: returns empty string for a description-less trigger', () => {
  assert.equal(extractDescription(ONBOARDING_TRIGGER_TEXT), '');
});

test('extractDescription: tolerates nulls and non-strings', () => {
  assert.equal(extractDescription(null), '');
  assert.equal(extractDescription(undefined), '');
  assert.equal(extractDescription(''), '');
  assert.equal(extractDescription({}), '');
});

test('extractDescription: returns empty when markers are malformed (close before open)', () => {
  const bad = `${DESCRIPTION_CLOSE} text ${DESCRIPTION_OPEN}`;
  assert.equal(extractDescription(bad), '');
});

test('onboardingMarkerPath joins repo root with the relative marker path', () => {
  const root = mkRoot();
  try {
    assert.equal(onboardingMarkerPath(root), join(root, ONBOARDING_MARKER_REL));
  } finally { cleanup(root); }
});

test('marker: write creates the file with the given payload', () => {
  const root = mkRoot();
  try {
    writeOnboardingMarker(root, 'hello');
    assert.ok(existsSync(onboardingMarkerPath(root)));
    assert.equal(readFileSync(onboardingMarkerPath(root), 'utf8'), 'hello');
  } finally { cleanup(root); }
});

test('marker: write defaults to the canonical trigger text', () => {
  const root = mkRoot();
  try {
    writeOnboardingMarker(root);
    assert.equal(
      readFileSync(onboardingMarkerPath(root), 'utf8'),
      ONBOARDING_TRIGGER_TEXT,
    );
  } finally { cleanup(root); }
});

test('marker: hasOnboardingMarker reflects filesystem state', () => {
  const root = mkRoot();
  try {
    assert.equal(hasOnboardingMarker(root), false);
    writeOnboardingMarker(root, 'x');
    assert.equal(hasOnboardingMarker(root), true);
  } finally { cleanup(root); }
});

test('marker: readOnboardingMarker returns null when absent', () => {
  const root = mkRoot();
  try {
    assert.equal(readOnboardingMarker(root), null);
  } finally { cleanup(root); }
});

test('marker: readOnboardingMarker returns the payload when present', () => {
  const root = mkRoot();
  try {
    writeOnboardingMarker(root, 'payload-123');
    assert.equal(readOnboardingMarker(root), 'payload-123');
  } finally { cleanup(root); }
});

test('marker: consumeOnboardingMarker returns payload AND deletes the file (one-shot)', () => {
  const root = mkRoot();
  try {
    writeOnboardingMarker(root, 'once');
    assert.ok(existsSync(onboardingMarkerPath(root)));
    assert.equal(consumeOnboardingMarker(root), 'once');
    assert.equal(existsSync(onboardingMarkerPath(root)), false);
    assert.equal(consumeOnboardingMarker(root), null);
  } finally { cleanup(root); }
});

test('marker: consumeOnboardingMarker on missing file returns null without throwing', () => {
  const root = mkRoot();
  try {
    assert.equal(consumeOnboardingMarker(root), null);
  } finally { cleanup(root); }
});

test('copyToClipboard returns a structured result (never throws)', () => {
  const result = copyToClipboard('test payload');
  assert.ok(result && typeof result === 'object');
  assert.ok('ok' in result);
  if (result.ok) {
    assert.equal(typeof result.method, 'string');
  } else {
    assert.equal(typeof result.reason, 'string');
  }
});

test('copyToClipboard tolerates empty string input', () => {
  const result = copyToClipboard('');
  assert.ok(result && typeof result === 'object');
  assert.ok('ok' in result);
});
