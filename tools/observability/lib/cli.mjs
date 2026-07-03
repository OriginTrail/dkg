// Shared CLI boundary for the observability tool pair (generator + verifier):
// one optional positional, declared value flags, declared boolean flags —
// unknown flags, missing/flag-shaped values and extra positionals all fail
// loudly with the caller's usage line, so the two scripts cannot drift apart
// as render options grow. Command-specific requiredness stays in the caller.
export function parseCliArgs({ argv, usage, valueFlags = [], boolFlags = [] }) {
  const opts = { positional: null };
  for (const f of boolFlags) opts[f] = false;
  const die = (msg) => { console.error(`${msg}\n${usage}`); process.exit(1); };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlags.includes(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) die(`${a} requires a value`);
      opts[a] = v;
    } else if (boolFlags.includes(a)) {
      opts[a] = true;
    } else if (a.startsWith('--')) {
      die(`unknown flag ${a}`);
    } else if (opts.positional === null) {
      opts.positional = a;
    } else {
      die(`unexpected extra argument ${a}`);
    }
  }
  return opts;
}

/** Validate a Prometheus label name (the node-profile CLI contract). */
export function assertPromLabel(label, usage) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(label)) {
    console.error(`--prom-node-label must be a valid Prometheus label name, got: ${label}\n${usage}`);
    process.exit(1);
  }
}
