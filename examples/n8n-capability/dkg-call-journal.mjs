import { componentFailure as fail } from './dkg-component-operations.mjs';

const validInvocation = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const validBlock = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/i.test(value);

/** One durable lifecycle: exact callback, prepared operation, result and outward response. */
export function createDkgCallJournal(db) {
  db.exec('SAVEPOINT dkg_call_migration');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS dkg_component_calls (id TEXT PRIMARY KEY, invocation_id TEXT NOT NULL, block_id TEXT NOT NULL, request_hash TEXT NOT NULL, request TEXT, prepared TEXT, result TEXT, response TEXT)');
    const columns = new Set(db.prepare('PRAGMA table_info(dkg_component_calls)').all().map(c => c.name));
    for (const column of ['request', 'prepared', 'response', 'invocation_id', 'block_id'])
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
    // Historical block IDs never contain colons; invocation IDs may. Decode
    // only here, keeping serialized IDs and all payload bytes unchanged.
    for (const call of db.prepare('SELECT id,invocation_id,block_id FROM dkg_component_calls').all()) {
      const id = typeof call.id === 'string' ? call.id : '';
      const separator = id.lastIndexOf(':'), invocationId = id.slice(0, separator), blockId = id.slice(separator + 1);
      if (separator < 1 || !validInvocation(invocationId) || !validBlock(blockId)
        || call.invocation_id !== null && call.invocation_id !== invocationId
        || call.block_id !== null && call.block_id !== blockId)
        throw fail('Conflicting or invalid legacy DKG call ownership; operator reconciliation required.');
      if (call.invocation_id === null || call.block_id === null)
        db.prepare('UPDATE dkg_component_calls SET invocation_id=?,block_id=? WHERE id=?').run(invocationId, blockId, call.id);
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS dkg_component_call_owner ON dkg_component_calls(invocation_id,block_id)');
    db.exec('RELEASE dkg_call_migration');
  } catch (error) {
    db.exec('ROLLBACK TO dkg_call_migration'); db.exec('RELEASE dkg_call_migration'); throw error;
  }
  const decode = value => value === null ? null : JSON.parse(value);
  function invocation(invocationId) {
    if (!validInvocation(invocationId)) throw fail('Invalid DKG invocation identity.');
    const owner = blockId => {
      if (!validBlock(blockId)) throw fail('Invalid DKG block identity.');
      return [invocationId, blockId];
    };
    function read(blockId, requestHash) {
      const row = db.prepare('SELECT * FROM dkg_component_calls WHERE invocation_id=? AND block_id=?').get(...owner(blockId));
      if (!row) return null;
      if (requestHash !== undefined && row.request_hash !== requestHash)
        throw fail('This DKG step already belongs to different inputs or native execution.');
      return { requestHash: row.request_hash, request: decode(row.request), prepared: decode(row.prepared),
        result: decode(row.result), response: decode(row.response) };
    }
    function prepare(blockId, requestHash, request, prepareOperation) {
      const identity = owner(blockId);
      db.exec('SAVEPOINT dkg_call_pending');
      try {
        const inserted = db.prepare('INSERT OR IGNORE INTO dkg_component_calls (id,invocation_id,block_id,request_hash) VALUES (?,?,?,?)')
          .run(invocationId + ':' + blockId, ...identity, requestHash);
        const call = read(blockId, requestHash), reconcile = inserted.changes === 0;
        if (!call) throw fail('Conflicting DKG call ownership; operator reconciliation required.');
        if (call.prepared === null && call.result === null && call.response === null) {
          call.prepared = prepareOperation(reconcile);
          call.request = request;
          db.prepare('UPDATE dkg_component_calls SET request=?,prepared=? WHERE invocation_id=? AND block_id=?')
            .run(JSON.stringify(request), JSON.stringify(call.prepared), ...identity);
        }
        db.exec('RELEASE dkg_call_pending');
        return { call, reconcile };
      } catch (error) {
        db.exec('ROLLBACK TO dkg_call_pending'); db.exec('RELEASE dkg_call_pending'); throw error;
      }
    }
    return {
      read, prepare,
      hasCalls: () => !!db.prepare('SELECT 1 FROM dkg_component_calls WHERE invocation_id=? LIMIT 1').get(invocationId),
      completedResult: blockId => read(blockId)?.result ?? null,
      adoptResponse(blockId, response) {
        db.prepare('UPDATE dkg_component_calls SET response=? WHERE invocation_id=? AND block_id=?').run(JSON.stringify(response), ...owner(blockId));
      },
      complete(blockId, result, response) {
        db.prepare('UPDATE dkg_component_calls SET result=?,response=? WHERE invocation_id=? AND block_id=?')
          .run(JSON.stringify(result), JSON.stringify(response), ...owner(blockId));
      },
    };
  }
  return {
    invocation,
    pendingWrite(workflowRef, invocationId, blockId) {
      return db.prepare(`SELECT r.id FROM dkg_component_runs r JOIN dkg_component_calls c ON c.invocation_id=r.id AND c.block_id=?
        WHERE r.ka_ref=? AND r.id<>? AND c.response IS NULL AND c.result IS NULL LIMIT 1`)
        .get(blockId, workflowRef, invocationId)?.id ?? null;
    },
  };
}
