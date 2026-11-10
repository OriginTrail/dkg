import { componentFailure as fail } from './dkg-component-operations.mjs';

/** One durable lifecycle: exact callback, prepared operation, result and outward response. */
export function createDkgCallJournal(db) {
  db.exec('SAVEPOINT dkg_call_migration');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS dkg_component_calls (id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, request TEXT, prepared TEXT, result TEXT, response TEXT)');
    const columns = new Set(db.prepare('PRAGMA table_info(dkg_component_calls)').all().map(c => c.name));
    for (const column of ['request', 'prepared', 'response'])
      if (!columns.has(column)) db.exec(`ALTER TABLE dkg_component_calls ADD COLUMN ${column} TEXT`);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dkg_component_writes'").get()) {
      for (const write of db.prepare('SELECT * FROM dkg_component_writes').all()) {
        const call = db.prepare('SELECT * FROM dkg_component_calls WHERE id=?').get(write.id);
        if (!call || call.request !== null && call.request !== write.request
          || call.prepared !== null && call.prepared !== write.evidence
          || call.response !== null && write.receipt !== null && call.response !== write.receipt)
          throw fail('Conflicting legacy DKG write journal; operator reconciliation required.');
        // Copy original bytes. A receipt alone does not promote an unfinished call.
        db.prepare(`UPDATE dkg_component_calls SET request=?,prepared=?,
          response=COALESCE(response,CASE WHEN result IS NOT NULL THEN ? END) WHERE id=?`)
          .run(write.request, write.evidence, write.receipt, write.id);
      }
      db.exec('DROP TABLE dkg_component_writes');
    }
    db.exec('RELEASE dkg_call_migration');
  } catch (error) {
    db.exec('ROLLBACK TO dkg_call_migration'); db.exec('RELEASE dkg_call_migration'); throw error;
  }
  const decode = value => value === null ? null : JSON.parse(value);
  function read(key, requestHash) {
    const row = db.prepare('SELECT * FROM dkg_component_calls WHERE id=?').get(key);
    if (!row) return null;
    if (requestHash !== undefined && row.request_hash !== requestHash)
      throw fail('This DKG step already belongs to different inputs or native execution.');
    return { requestHash: row.request_hash, request: decode(row.request), prepared: decode(row.prepared),
      result: decode(row.result), response: decode(row.response) };
  }
  function prepare(key, requestHash, request, prepareOperation) {
    db.exec('SAVEPOINT dkg_call_pending');
    try {
      const inserted = db.prepare('INSERT OR IGNORE INTO dkg_component_calls (id,request_hash) VALUES (?,?)').run(key, requestHash);
      const call = read(key, requestHash), reconcile = inserted.changes === 0;
      if (call.prepared === null && call.result === null && call.response === null) {
        call.prepared = prepareOperation(reconcile);
        call.request = request;
        db.prepare('UPDATE dkg_component_calls SET request=?,prepared=? WHERE id=?')
          .run(JSON.stringify(request), JSON.stringify(call.prepared), key);
      }
      db.exec('RELEASE dkg_call_pending');
      return { call, reconcile };
    } catch (error) {
      db.exec('ROLLBACK TO dkg_call_pending'); db.exec('RELEASE dkg_call_pending'); throw error;
    }
  }
  return {
    read, prepare,
    completedResult: key => read(key)?.result ?? null,
    adoptResponse(key, response) {
      db.prepare('UPDATE dkg_component_calls SET response=? WHERE id=?').run(JSON.stringify(response), key);
    },
    complete(key, result, response) {
      db.prepare('UPDATE dkg_component_calls SET result=?,response=? WHERE id=?').run(JSON.stringify(result), JSON.stringify(response), key);
    },
    pendingWrite(workflowRef, invocationId, blockId) {
      return db.prepare(`SELECT r.id FROM dkg_component_runs r JOIN dkg_component_calls c ON c.id=r.id||':'||?
        WHERE r.ka_ref=? AND r.id<>? AND c.response IS NULL AND c.result IS NULL LIMIT 1`)
        .get(blockId, workflowRef, invocationId)?.id ?? null;
    },
  };
}
