// Static runtime-probe fixture for the packed-artifact export gate (#2165).
// Copied into the scratch consumer install and parameterized by
// PACK_GATE_CONFIG (JSON) — no generated source, so tooling can parse this
// file and the contract lives in data, not in strings.
const cfg = JSON.parse(process.env.PACK_GATE_CONFIG ?? '{}');
let bad = 0;

for (const [specifier, shouldResolve] of cfg.resolutionExpectations ?? []) {
  let resolved = true;
  try { import.meta.resolve(specifier); } catch { resolved = false; }
  if (resolved !== shouldResolve) {
    bad += 1;
    console.error(`resolution mismatch: ${specifier} resolved=${resolved}`);
  }
}

const barrel = await import(cfg.pkg);
const internal = await import(cfg.internalEntry);
// #2052 D-8 — the gate-read subpath is LOADED, not merely resolved. Resolver metadata can
// be correct while the packed JS lacks the functions its one consumer calls.
const gateRead = await import(cfg.gateReadEntry);

// IDENTITY-based leak detection: an authority export on the barrel is a leak
// under ANY name. Comparing values, not keys, catches aliased re-exports
// (`export { mint as createStorageOwner }`); primitives are skipped because
// identity cannot distinguish equal primitives exported independently.
const barrelEntries = Object.entries(barrel);
const leaks = [];
for (const [name, value] of Object.entries(internal)) {
  if (name === 'default') continue;
  if (!['function', 'object', 'symbol'].includes(typeof value) || value === null) continue;
  for (const [barrelName, barrelValue] of barrelEntries) {
    if (barrelValue === value) leaks.push(`${name} (as barrel export '${barrelName}')`);
  }
}

// The barrel's VALUE-EXPORT NAME SET is pinned exactly. Identity detection
// (above) catches re-exports; this catches NEW surface — including a wrapper
// function around the authority, which is not identity-equal and whose
// behavior no mechanical check can decide. Any addition or removal is a
// visible diff to scripts/pack-gate/barrel-value-exports.json in the same PR,
// never a silent change.
const actualNames = Object.keys(barrel).filter((n) => n !== 'default').sort();
const expectedNames = [...(cfg.barrelValueExports ?? [])].sort();
const added = actualNames.filter((n) => !expectedNames.includes(n));
const removed = expectedNames.filter((n) => !actualNames.includes(n));

const verdicts = [
  [added.length === 0 && removed.length === 0,
    `barrel value-export set matches the pinned snapshot (added: ${added.join(',') || '-'}; removed: ${removed.join(',') || '-'}) — intentional changes update pack-gate/barrel-value-exports.json in the same PR`],
  [typeof barrel[cfg.publicError] === 'function', 'barrel exports the public unowned-backend error'],
  [leaks.length === 0, `barrel exports no authority value under any name (leaked: ${leaks.join('; ')})`],
  [typeof internal[cfg.ownershipMint] === 'function', 'internal entry exports the ownership mint'],
  [!(cfg.publicError in internal), 'the public error is not doubled through the authority entry'],
  [(cfg.gateReadExports ?? []).every((n) => typeof gateRead[n] === 'function'),
    `gate-read entry exports its consumed surface (missing: ${(cfg.gateReadExports ?? []).filter((n) => typeof gateRead[n] !== 'function').join(',') || '-'})`],
];
for (const [ok, label] of verdicts) {
  if (!ok) {
    bad += 1;
    console.error(`runtime surface: ${label} — FAILED`);
  }
}
process.exit(bad === 0 ? 0 : 1);
