import fs from 'node:fs';
import { ASSERTION_SEAL_PREDICATES, parseAssertionSealQuads, canonicalGraphScopedAuthorSealFromAssertionSealV1, computeCanonicalGraphScopedAuthorSealDigestV1 } from '../../packages/core/dist/index.js';
const [arm,label]=process.argv.slice(2),dir=`.tmp/2963/evidence/${arm}`;
const predicates=new Set(Object.values(ASSERTION_SEAL_PREDICATES));
function load(p){const rows=JSON.parse(fs.readFileSync(p)).results.bindings;const index=new Map();for(const r of rows){if(!predicates.has(r.p.value))continue;let arr=index.get(r.s.value);if(!arr)index.set(r.s.value,arr=[]);arr.push(r);}return index;}
const before=load(dir+'/pre-workload/rdf.json'),after=load(dir+'/'+label+'/rdf.json');
const term=t=>t.type==='uri'?t.value:JSON.stringify(t.value)+(t.datatype?`^^<${t.datatype}>`:t['xml:lang']?'@'+t['xml:lang']:'');
const canonical=rows=>rows.map(r=>JSON.stringify([r.p,r.o])).sort();const proof=[];
for(const [subject,old] of before){if(!subject.includes('/assertion/'))continue;const now=after.get(subject)??[];
 try {const seal=parseAssertionSealQuads(now.map(r=>({subject:r.s.value,predicate:r.p.value,object:term(r.o),graph:r.g.value})),subject);if(!seal)continue;
 const c=canonicalGraphScopedAuthorSealFromAssertionSealV1(seal);
 proof.push({name:subject.split('/').at(-1),subject,unchanged:JSON.stringify(canonical(old))===JSON.stringify(canonical(now)),sealDigest:computeCanonicalGraphScopedAuthorSealDigestV1(c),seal:c});
 }catch(e){proof.push({subject,error:e.message});}
}
fs.writeFileSync(dir+'/seal-proof.json',JSON.stringify(proof,null,2));console.log({seals:proof.length,changed:proof.filter(p=>!p.unchanged).map(p=>p.name??p.subject)});
