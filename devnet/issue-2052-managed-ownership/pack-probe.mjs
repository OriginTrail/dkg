// #2165 acceptance probe — runs against the PACKED TARBALL extracted into
// ./node_modules, not against the source tree. import.meta.resolve() exercises
// Node's real exports-map resolution without executing the module graph, so a
// missing registry dep cannot masquerade as a resolution verdict.
const results = [];
const probe = (label, specifier, expectation) => {
  try {
    const resolved = import.meta.resolve(specifier);
    results.push({ label, specifier, resolved: resolved.replace(/.*node_modules/, '<nm>'), outcome: 'RESOLVED' });
  } catch (error) {
    results.push({ label, specifier, outcome: 'REFUSED', code: error?.code ?? String(error) });
  }
  return results[results.length - 1].outcome === expectation;
};

let ok = true;
ok &= probe('public barrel', '@origintrail-official/dkg-storage', 'RESOLVED');
ok &= probe('documented internal entry', '@origintrail-official/dkg-storage/internal/managed-oxigraph-ownership-v1', 'RESOLVED');
ok &= probe('deep import of ownership internals (THE issue)', '@origintrail-official/dkg-storage/dist/managed-oxigraph-ownership-v1-internal.js', 'REFUSED');
ok &= probe('arbitrary deep dist import', '@origintrail-official/dkg-storage/dist/store-priority-scheduler.js', 'REFUSED');
ok &= probe('extensionless deep import', '@origintrail-official/dkg-storage/dist/managed-oxigraph-ownership-v1-internal', 'REFUSED');
ok &= probe('package.json probe', '@origintrail-official/dkg-storage/package.json', 'REFUSED');

for (const r of results) console.log(JSON.stringify(r));
console.log(ok ? 'PACK-PROBE: ALL EXPECTATIONS MET' : 'PACK-PROBE: FAILURES PRESENT');
process.exit(ok ? 0 : 1);
