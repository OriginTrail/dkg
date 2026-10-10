import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import oxigraph from 'oxigraph';
async function run(mode: string, populated: 'named'|'default'|false, lowDisk = false) {
  const home = await mkdtemp(join(tmpdir(),'ingest-guard-'));
  const nq='<urn:s> <urn:p> "plain" <urn:g> .\n<urn:s> <urn:link> <urn:o> <urn:g> .\n<urn:s> <urn:lang> "hello"@en <urn:g> .\n<urn:s> <urn:number> "42"^^<http://www.w3.org/2001/XMLSchema#integer> <urn:g> .\n# comment without a final newline';
  await writeFile(join(home,'input.nq'),nq);
  await writeFile(join(home,'manifest.json'),JSON.stringify({assets:[{file:'input.nq',graph:'urn:g',quads:4,sha256:createHash('sha256').update(nq).digest('hex')}]}));
  const graph=new oxigraph.Store(); let mutations=0;
  if(populated) graph.load(`<urn:old> <urn:p> "keep" ${populated==='named'?'<urn:g> ':''}.`,{format:'application/n-quads'});
  const server=createServer(async(req,res)=>{
    const chunks=[]; for await(const c of req) chunks.push(c); const body=Buffer.concat(chunks).toString();
    if(req.headers['content-type']?.includes('application/n-quads')) {mutations++;graph.load(body,{format:'application/n-quads'});res.end('ok');return;}
    const params=new URLSearchParams(body);const query=req.method==='GET'?new URL(req.url!,'http://local').searchParams.get('query'):req.headers['content-type']?.includes('application/sparql-query')?body:params.get('query');
    if(query) {const result=graph.query(query);res.setHeader('content-type','application/sparql-results+json');res.end(JSON.stringify({head:{vars:[...new Set(result.flatMap((row:Map<string,any>)=>[...row.keys()]))]},results:{bindings:result.map((row:Map<string,any>)=>Object.fromEntries([...row].map(([k,v])=>[k,{type:v.termType==='NamedNode'?'uri':'literal',value:v.value,datatype:v.datatype?.value}])) )}}));}
    else { mutations++;graph.update(req.headers['content-type']?.includes('application/sparql-update')?body:params.get('update')!);res.end('ok'); }
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const args:string[]=[];
  if(lowDisk) { await writeFile(join(home,'guard.mjs'),`import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module'; fs.statfs=async path=>({bavail:String(path).endsWith('journal')?1:100000000,bsize:4096}); syncBuiltinESMExports();`);args.push('--import',join(home,'guard.mjs')); }
  args.push(resolve('scripts/ingest-floor-benchmark.mjs'),'--manifest',join(home,'manifest.json'),'--endpoint',`http://127.0.0.1:${(server.address() as any).port}/sparql`,'--mode',mode,'--out',join(home,'out.json'),'--storage-path',join(home,'journal'));
  await import('node:fs/promises').then(fs=>fs.mkdir(join(home,'journal')));
  let output='';
  try {const code=await new Promise<number|null>(r=>{const p=spawn(process.execPath,args,{timeout:10000});p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>output+=d);p.on('close',r);});return {code,mutations,output,size:graph.size,metadata:graph.match(null,null,null,oxigraph.namedNode('urn:benchmark:meta')).length};}
  finally {await new Promise<void>(r=>server.close(()=>r()));await rm(home,{recursive:true,force:true});}
}
describe('storage benchmark safety and RDF boundaries',()=>{
  it.each(['atomic','rdf'])('refuses populated namespaces before %s writes',async mode=>{
    for(const kind of ['named','default'] as const) {const r=await run(mode,kind);expect(r.code).not.toBe(0);expect(r.mutations).toBe(0);expect(r.size).toBe(1);expect(r.output).toContain('Refusing a nonempty');}
  });
  it.each(['atomic','rdf'])('checks the journal filesystem before %s writes',async mode=>{const r=await run(mode,false,true);expect(r.code).toBe(1);expect(r.mutations).toBe(0);expect(r.output).toContain('Disk below');});
  it.each(['atomic','rdf'])('preserves RDF terms and separates trailing comments in %s mode',async mode=>{const r=await run(mode,false);expect(r.output).not.toContain('Input graph/count mismatch');expect(r.code,r.output).toBe(0);expect(r.size).toBe(5);expect(r.metadata).toBe(1);});
});
