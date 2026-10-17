import { loadCampaign } from './campaign-manifest.mjs';
import { indexAuthoritativeMetadata } from './authoritative-metadata.mjs';
import { bindingTermIdentity } from './rdf-term-identity.mjs';
import fs from 'node:fs';
import { ASSERTION_SEAL_PREDICATES, parseAssertionSealQuads, canonicalGraphScopedAuthorSealFromAssertionSealV1, computeCanonicalGraphScopedAuthorSealDigestV1 } from '../../packages/core/dist/index.js';
const [arm,label]=process.argv.slice(2),dir=`.tmp/2963/evidence/${arm}`;
const predicates=new Set(Object.values(ASSERTION_SEAL_PREDICATES));
const campaign=loadCampaign(arm),metadataGraph=`did:dkg:context-graph:${campaign.contextGraphId}/_meta`;
function load(p){return indexAuthoritativeMetadata(JSON.parse(fs.readFileSync(p)).results.bindings,metadataGraph,predicates);}
const before=load(dir+'/pre-workload/rdf.json'),after=load(dir+'/'+label+'/rdf.json');
const term=t=>t.type==='uri'?t.value:JSON.stringify(t.value)+(t.datatype?`^^<${t.datatype}>`:t['xml:lang']?'@'+t['xml:lang']:'');
const canonical=rows=>rows.map(r=>JSON.stringify([r.s,r.p,r.o,r.g].map(bindingTermIdentity))).sort();const proof=[];
for(const [subject,old] of before){if(!subject.includes('/assertion/'))continue;const now=after.get(subject)??[];
 try {const seal=parseAssertionSealQuads(now.map(r=>({subject:r.s.value,predicate:r.p.value,object:term(r.o),graph:r.g.value})),subject);if(!seal)throw Error('Missing authoritative seal');
 const c=canonicalGraphScopedAuthorSealFromAssertionSealV1(seal);
 proof.push({name:subject.split('/').at(-1),subject,unchanged:JSON.stringify(canonical(old))===JSON.stringify(canonical(now)),sealDigest:computeCanonicalGraphScopedAuthorSealDigestV1(c),seal:c});
 }catch(e){proof.push({name:subject.split('/').at(-1),subject,unchanged:false,error:e.message});}
}
if(proof.length!==campaign.cohorts.initial.length+campaign.cohorts.shares.length)throw Error('Incomplete original authoritative seal cohort');
fs.writeFileSync(dir+'/seal-proof.json',JSON.stringify(proof,null,2));console.log({seals:proof.length,changed:proof.filter(p=>!p.unchanged).map(p=>p.name??p.subject)});
