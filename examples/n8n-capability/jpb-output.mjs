import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const fail = message => Object.assign(new Error(message), { status: 409, code: 'JPB_OUTPUT_UNCONFIRMED' });
export function evidencePayload(receipt) {
  if (!receipt?.readbackVerified || !receipt.persisted || !receipt.output?.ok) throw fail('A verified successful execution is required.');
  const rows = JSON.parse(receipt.output.itemsJson);
  const source = '0xf77258a965ba13adc77bca85da7c6a287272959a/jpb-data';
  if (!Array.isArray(rows) || !rows.length || rows.length > 20 || !rows.every(r => (r.erp || r.workbook) && (!r.erp || r.erp.evidence?.contextGraphId === source) && (!r.workbook || r.workbook.allocationStatus === 'unconfirmed'))) throw fail('Only the reviewed JPB evidence envelope may be written.');
  const payload = JSON.stringify({ kind: 'PLCAInputEvidence', interpretation: 'planned-routing-reference-only', allocationStatus: 'unconfirmed', plcaCalculated: false, receipt });
  const digest = createHash('sha256').update(payload).digest('hex');
  const name = 'nos-input-' + digest, subject = 'urn:nos:jpb:input-evidence:' + digest;
  const q = (predicate, object) => ({ subject, predicate, object, graph: '' });
  const ns = 'urn:nos:workflow:';
  const quads = [q('http://www.w3.org/1999/02/22-rdf-syntax-ns#type', ns + 'PLCAInputEvidence'), q(ns+'payload', JSON.stringify(payload)), q(ns+'sha256', JSON.stringify(digest)), q('http://www.w3.org/ns/prov#wasGeneratedBy', receipt.executionIri),q(ns+'workflow',receipt.kaRef),q(ns+'allocationStatus',JSON.stringify('unconfirmed'))];
  for (const row of rows) for (const ref of [row.erp?.recordId, row.erp?.evidence?.sourceEvidence, row.workbook && 'urn:sha256:'+row.workbook.evidence.contentDigest].filter(Boolean)) quads.push(q('http://www.w3.org/ns/prov#wasDerivedFrom',ref));
  return { name, digest, quads: [...new Map(quads.map(v=>[JSON.stringify(v),v])).values()] };
}
export function remote(payload, scriptName = 'jpb-write.py') {
  const script = 'import base64,json\nPAYLOAD=json.loads(base64.b64decode("'+Buffer.from(JSON.stringify(payload)).toString('base64')+'"))\n'+readFileSync(new URL('./'+scriptName,import.meta.url),'utf8');
  return new Promise((resolve,reject)=>{
    const p=spawn('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=8','adminuser@100.113.215.1','python3','-'],{stdio:['pipe','pipe','pipe']});let out='',size=0;
    const timer=setTimeout(()=>p.kill(),scriptName === 'jpb-invoke-program.py' ? 40000 : 14000);
    p.stdout.on('data',b=>{size+=b.length;if(size>2097152)p.kill();else out+=b;});p.stderr.resume();p.on('error',()=>{clearTimeout(timer);reject(fail('JPB SSH connection unavailable.'));});
    p.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(fail(scriptName === 'jpb-invoke-program.py' ? 'JPB Program invocation is unconfirmed. Retry uses the same invocation identity; check its arguments, approval and remote execution.' : scriptName === 'jpb-read.py' ? 'JPB read unavailable or incomplete; no source rows were accepted.' : 'JPB write/readback is unconfirmed. Retry checks the same asset; it does not create another.'));try{resolve(JSON.parse(out));}catch{reject(fail('Invalid JPB receipt.'));}});p.stdin.on('error',()=>{});p.stdin.end(script);
  });
}
export function jpbOutputStore(db) {
  db.exec('CREATE TABLE IF NOT EXISTS studio_output_receipts (id TEXT PRIMARY KEY, receipt TEXT NOT NULL); CREATE TABLE IF NOT EXISTS studio_jpb_writes (id TEXT PRIMARY KEY, result TEXT)');
  const active=new Map();
  return {
    remember(receipt) { const prior=db.prepare('SELECT receipt FROM studio_output_receipts WHERE id=?').get(receipt.invocationId); const encoded=JSON.stringify(receipt); if(prior && prior.receipt!==encoded)throw fail('Invocation identity already belongs to different evidence.'); db.prepare('INSERT OR IGNORE INTO studio_output_receipts VALUES (?,?)').run(receipt.invocationId,encoded); return receipt; },
    async write(value) {
      if(process.env.NOS_JPB_WRITE_ENABLED!=='1')throw fail('JPB output is not enabled.');
      if(!value || Object.keys(value).length!==1 || typeof value.invocationId!=='string')throw fail('Select an existing execution.');
      const id=value.invocationId, row=db.prepare('SELECT receipt FROM studio_output_receipts WHERE id=?').get(id);
      if(!row)throw fail('Run or recover the saved execution before writing.');
      const receipt=JSON.parse(row.receipt);
      if(receipt.kaRef!==process.env.NOS_JPB_WORKFLOW_REF)throw fail('This workflow revision has not been selected for JPB output.');
      if(active.has(id))return active.get(id);
      const job=(async()=>{const payload=evidencePayload(receipt);const previous=db.prepare('SELECT result FROM studio_jpb_writes WHERE id=?').get(id);
        if(!previous)db.prepare('INSERT INTO studio_jpb_writes VALUES (?,NULL)').run(id);
        const result=await remote({...payload,allowCreate:!previous});
        if(result.digest!==payload.digest || result.readbackVerified!==true)throw fail('JPB receipt does not match this execution.');
        db.prepare('UPDATE studio_jpb_writes SET result=? WHERE id=?').run(JSON.stringify(result),id);return result;
      })();active.set(id,job);try{return await job;}finally{active.delete(id);}
    }
  };
}
