/** MCP snapshots and admission checkpoints share the Studio repository's database and lifecycle. */
export function createStudioMcpRepository(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS studio_saved_native (
    ka_ref TEXT PRIMARY KEY, compiled_json TEXT NOT NULL, published_json TEXT NOT NULL,
    withdrawn INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS studio_tool_runs (
    account_id TEXT NOT NULL, run_key TEXT NOT NULL, request_hash TEXT NOT NULL,
    ka_ref TEXT NOT NULL, workflow_sha256 TEXT NOT NULL, actor_json TEXT NOT NULL,
    is_agent INTEGER NOT NULL, status TEXT NOT NULL, version_id TEXT, execution_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, input_sha256 TEXT,
    PRIMARY KEY(account_id,run_key));
    CREATE UNIQUE INDEX IF NOT EXISTS studio_agent_slot ON studio_tool_runs(account_id)
    WHERE is_agent=1 AND status IN ('admitted','running','unconfirmed');`);
  // Old admissions have no evidence of their normalized input. Never backfill it
  // from a retry or from the execution being inspected; retain their reservations.
  if (!db.prepare('PRAGMA table_info(studio_tool_runs)').all().some(c => c.name === 'input_sha256'))
    db.exec('ALTER TABLE studio_tool_runs ADD COLUMN input_sha256 TEXT');
  const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
  const decodeRun = value => {
    if (!value) return;
    // SQL names stop here. Both native verification paths receive this same
    // checkpoint, including nulls from incomplete or legacy admissions.
    /** @type {import('./studio-native-execution.mjs').NativeExecutionCheckpoint} */
    const checkpoint = { executionId: value.execution_id, versionId: value.version_id,
      runKey: value.run_key, inputDigest: value.input_sha256 ?? null };
    return { accountId: value.account_id, runKey: value.run_key, requestHash: value.request_hash,
      kaRef: value.ka_ref, workflowSha256: value.workflow_sha256, actor: JSON.parse(value.actor_json),
      isAgent: !!value.is_agent, status: value.status, createdAt: value.created_at, updatedAt: value.updated_at,
      checkpoint };
  };
  const run = (accountId, key) => decodeRun(db.prepare('SELECT * FROM studio_tool_runs WHERE account_id=? AND run_key=?').get(accountId, key));
  const matchingRun = (accountId, key, requestHash) => {
    const prior = run(accountId, key);
    if (prior && prior.requestHash !== requestHash) throw fail('STUDIO_RUN_KEY_CONFLICT');
    return prior;
  };
  function reserveRun({ accountId, runKey, requestHash, inputDigest, kaRef, workflowSha256, actor }) {
    if (!/^[a-f0-9]{64}$/.test(inputDigest ?? '')) throw new Error('Native admission requires an input digest.');
    const prior = matchingRun(accountId, runKey, requestHash);
    if (prior) return false;
    const now = Date.now();
    try {
      db.prepare(`INSERT INTO studio_tool_runs
        (account_id,run_key,request_hash,ka_ref,workflow_sha256,actor_json,is_agent,status,created_at,updated_at,input_sha256)
        VALUES (?,?,?,?,?,?,?,'admitted',?,?,?)`).run(accountId, runKey, requestHash, kaRef, workflowSha256,
        JSON.stringify(actor), actor.startedBy ? 1 : 0, now, now, inputDigest);
      return true;
    } catch (error) {
      if (String(error.code).startsWith('ERR_SQLITE') && /UNIQUE constraint/.test(error.message)) {
        if (matchingRun(accountId, runKey, requestHash)) return false;
        throw fail('STUDIO_BUSY', 429);
      }
      throw error;
    }
  }
  return {
    recordSavedNative(compiled, published) {
      const snapshot = { definition: compiled.definition, grant: compiled.grant, mode: compiled.mode, kaRef: compiled.kaRef,
        ...([7, 8].includes(compiled.compiler) ? { compiler: compiled.compiler } : {}) };
      // A repeat save never replaces an immutable snapshot or reverses withdrawal.
      db.prepare('INSERT INTO studio_saved_native (ka_ref,compiled_json,published_json) VALUES (?,?,?) ON CONFLICT(ka_ref) DO NOTHING')
        .run(compiled.kaRef, JSON.stringify(snapshot), JSON.stringify(published));
    },
    savedNative(ref) {
      const stored = db.prepare('SELECT * FROM studio_saved_native WHERE ka_ref=?').get(ref);
      return stored && { ...JSON.parse(stored.compiled_json), published: JSON.parse(stored.published_json), withdrawn: !!stored.withdrawn };
    },
    listSavedNative: () => db.prepare('SELECT ka_ref FROM studio_saved_native WHERE withdrawn=0 ORDER BY ka_ref').all().map(r => r.ka_ref),
    withdrawNative: ref => db.prepare('UPDATE studio_saved_native SET withdrawn=1 WHERE ka_ref=?').run(ref),
    run, matchingRun, reserveRun,
    activeAgentRun: accountId => decodeRun(db.prepare("SELECT * FROM studio_tool_runs WHERE account_id=? AND is_agent=1 AND status IN ('admitted','running','unconfirmed')").get(accountId)),
    updateRunStatus: (accountId, key, status) => db.prepare('UPDATE studio_tool_runs SET status=?, updated_at=? WHERE account_id=? AND run_key=?')
      .run(status, Date.now(), accountId, key),
    prepareDispatch(accountId, key, versionId) {
      // Pin and uncertainty are committed together BEFORE the webhook POST.
      db.prepare("UPDATE studio_tool_runs SET version_id=?, status='unconfirmed', updated_at=? WHERE account_id=? AND run_key=?")
        .run(versionId, Date.now(), accountId, key);
    },
    acknowledgeRun: (accountId, key, executionId) => db.prepare("UPDATE studio_tool_runs SET execution_id=?, status='running', updated_at=? WHERE account_id=? AND run_key=?")
      .run(executionId, Date.now(), accountId, key),
  };
}
