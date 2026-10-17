import { verifyInventoryScope } from './inventory-scope.mjs';
import { requirePublicationCohort } from './publication-evidence.mjs';
import { sameCapturedQuads } from './rdf-term-identity.mjs';
import { loadCampaign, campaignCounts } from './campaign-manifest.mjs';
import { verifyRestartMetadata, unchangedCohortMetadata, bindingMatchesCapturedOperation } from './restart-metadata-proof.mjs';
import {verifyIdentityTuples} from './identity-tuples.mjs';
// Read-only proof around the separately requested process-crash regression.
import fs from 'node:fs';
import {ASSERTION_SEAL_PREDICATES, parseAssertionSealQuads, canonicalGraphScopedAuthorSealFromAssertionSealV1, computeCanonicalGraphScopedAuthorSealDigestV1, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer} from '../../packages/core/dist/index.js';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../packages/cli/package.json',import.meta.url));
const {JsonRpcProvider}=require('ethers');
const [arm,mode]=process.argv.slice(2),home=process.env.DKG_HOME;
const root=`.tmp/2963/evidence/${arm}`,dir=`${root}/restart-regression`;
const cfg=JSON.parse(fs.readFileSync(home+'/config.json')),campaign=loadCampaign(arm),counts=campaignCounts(campaign),cg=campaign.contextGraphId;
const [restartName]=campaign.cohorts.restart;
if(cfg.contextGraphs[0]!==cg)throw Error('Runtime graph differs from campaign');
const publicationAdmissions=JSON.parse(fs.readFileSync(`${root}/publication-admissions.json`));
const publicationSeals=JSON.parse(fs.readFileSync(`${root}/seal-proof.json`));
const originalPublicationJobs=JSON.parse(fs.readFileSync(`${root}/fixed-deadline/-api-publisher-jobs.json`)).value.jobs;
requirePublicationCohort(campaign,publicationAdmissions,originalPublicationJobs,publicationSeals);
if(mode==='after') requirePublicationCohort(campaign,publicationAdmissions,JSON.parse(fs.readFileSync(`${root}/restart-readback/-api-publisher-jobs.json`)).value.jobs,publicationSeals);
const query=`SELECT ?payload WHERE { GRAPH <urn:dkg:promote-queue:control-plane> {
 ?job <urn:dkg:promote-queue:contextGraphId> ${JSON.stringify(cg)} ;
 <urn:dkg:promote-queue:assertionName> ${JSON.stringify(restartName)} ; <urn:dkg:promote-queue:payload> ?payload
} } LIMIT 2`;
const response=await fetch(cfg.store.options.url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/sparql-results+json'},body:new URLSearchParams({query}),signal:AbortSignal.timeout(60000)});
if(!response.ok)throw Error('Queue evidence read failed');
const bindings=(await response.json()).results.bindings;if(bindings.length!==1)throw Error('Expected exactly one original recovery owner');
const job=JSON.parse(bindings[0].payload.value);
fs.writeFileSync(`${dir}/${mode}-raw-job.json`,JSON.stringify(job,null,2),{mode:0o600});
const safe={jobId:job.jobId,state:job.state,formatVersion:job.formatVersion,request:job.request,
 attemptCount:job.attempt.count,commitMarker:job.commitMarker,enqueuedAt:job.enqueuedAt,
 leaseExpiresAt:job.lease?.expiresAt,result:job.result};
fs.writeFileSync(`${dir}/${mode}-job.json`,JSON.stringify(safe,null,2));
if(mode==='before'){
 if(job.state!=='running'||job.commitMarker?.promoteStarted!==true||!job.request.recoveryBinding)throw Error('Crash did not preserve a started bound owner');
 console.log({jobId:job.jobId,state:job.state,attemptCount:job.attempt.count,leaseExpiresAt:job.lease.expiresAt});
}else if(mode==='after'){
 const before=JSON.parse(fs.readFileSync(`${dir}/before-raw-job.json`));
 const fault=JSON.parse(fs.readFileSync(home+`/2963-fault-${restartName}.json`));
 const rows=JSON.parse(fs.readFileSync(`${root}/restart-readback/rdf.json`)).results.bindings;
 const identityPredicates=new Set([...Object.values(ASSERTION_SEAL_PREDICATES),'http://dkg.io/ontology/shareOperationId','http://dkg.io/ontology/promoteOperationIntent']);
 const originalFields=fault.metadataAtFault.quads.filter(q=>identityPredicates.has(q.predicate));
 const identitySubjects=new Set(originalFields.map(q=>q.subject));
 const {metadataGraph, originalSealAndIntent, lifecycleComplete}=verifyRestartMetadata(fault,rows);
 const originalNames=[...campaign.cohorts.initial,...campaign.cohorts.shares];
 const originalSubjects=originalNames.flatMap(name=>[`did:dkg:context-graph:${cg}/assertion/${campaign.author}/${name}`,
   `urn:dkg:assertion:${cg}:${campaign.author}:${name}`]);
 const mainRows=JSON.parse(fs.readFileSync(`${root}/fixed-deadline/rdf.json`)).results.bindings;
 const originalCohortMetadataUnchanged=unchangedCohortMetadata(mainRows,rows,metadataGraph,originalSubjects);
 const wholeContentProof=JSON.parse(fs.readFileSync(`${dir}/whole-cohort-content-proof.json`));
 const snapshot=JSON.parse(fs.readFileSync(`${root}/restart-readback/manifest.json`));
 const wholeCohortContentUnchanged=wholeContentProof.arm===arm && wholeContentProof.snapshotObservedAt===snapshot.observedAt
   && wholeContentProof.assets===counts.restart && wholeContentProof.allExact===true;

 const graph=fault.intendedMetadataInsert.find(q=>q.predicate==='http://dkg.io/ontology/assertionGraph')?.object;
 if(!graph)throw Error('Missing exact crash graph');
 const publicRows=rows.filter(r=>r.g.value===graph);
 const exactContent=publicRows.length===campaign.triplesPerAsset && sameCapturedQuads(fault.contentAtFault.quads, publicRows, graph);
 const dkg='http://dkg.io/ontology/';
 const sealValue=predicate=>rows.find(r=>r.g.value===metadataGraph&&identitySubjects.has(r.s.value)&&r.p.value===dkg+predicate)?.o.value;
 const scope=createGraphKnowledgeAssetScope(sealValue('kaUal'),sealValue('assertionVersion'));
 const wm=knowledgeAssetLayerGraphUri(cg,MemoryLayer.WorkingMemory,scope);
 const wmCleared=!rows.some(r=>r.g.value===wm||r.g.value.startsWith(wm+'/'));
 const inventoryScope=verifyInventoryScope(campaign,JSON.parse(fs.readFileSync(`${root}/restart-readback/inventory.json`)),JSON.parse(fs.readFileSync(`${root}/restart-readback/catalogs.json`)),JSON.parse(fs.readFileSync(`${root}/restart-readback/-api-status.json`)));
 if(!inventoryScope.valid)throw Error(inventoryScope.errors.join('; '));
 const catalogs=inventoryScope.catalogRows;
 const crashSealSubjects=[...new Set(fault.metadataAtFault.quads.filter(q=>q.predicate===ASSERTION_SEAL_PREDICATES.KA_UAL).map(q=>q.subject))];
 if(crashSealSubjects.length!==1)throw Error('Expected one original crash seal');
 const crashSeal=parseAssertionSealQuads(fault.metadataAtFault.quads,crashSealSubjects[0]);
 if(!crashSeal)throw Error('Missing original crash seal');
 const canonicalSeal=canonicalGraphScopedAuthorSealFromAssertionSealV1(crashSeal);
 const crashDigest=computeCanonicalGraphScopedAuthorSealDigestV1(canonicalSeal);
 const originalBindingOperation=bindingMatchesCapturedOperation(fault,before.request.recoveryBinding)
   && bindingMatchesCapturedOperation(fault,job.request.recoveryBinding);
 const originalBindingSeal=before.request.recoveryBinding.sealDigest===crashDigest;
 const expected=[...JSON.parse(fs.readFileSync(`${root}/seal-proof.json`)),
   {name:restartName,seal:canonicalSeal,sealDigest:crashDigest}];
 if(expected.length!==counts.restart||expected.some(row=>row.error||row.unchanged===false))throw Error('Incomplete original identity evidence');
 const inventory=inventoryScope.rows;
 const tuples=verifyIdentityTuples(expected,catalogs,inventory);
 const publications=JSON.parse(fs.readFileSync(`${root}/restart-readback/-api-publisher-jobs.json`)).value.jobs;
 const mainPublications=JSON.parse(fs.readFileSync(`${root}/fixed-deadline/-api-publisher-jobs.json`)).value.jobs;
 const receipts=JSON.parse(fs.readFileSync(`${root}/reconciliation.json`));
 const provider=new JsonRpcProvider('https://sepolia.base.org',84532,{staticNetwork:true});const nonces=[];
 for(const old of receipts.wallets){await new Promise(r=>setTimeout(r,500));const latest=await provider.getTransactionCount(old.address,'latest'),pending=await provider.getTransactionCount(old.address,'pending');nonces.push({address:old.address,before:old.latest,latest,pending,unchanged:latest===old.latest&&pending===latest});}
 provider.destroy();
 const runtimeBefore=JSON.parse(fs.readFileSync(`${dir}/runtime-before.json`));
 const runtimeAfter=JSON.parse(fs.readFileSync(`${root}/restart-readback/-api-status.json`)).value;
 const sameRuntime=['version','commit','peerId'].every(key=>runtimeBefore[key]===runtimeAfter[key]);
 const originalBuild=JSON.parse(fs.readFileSync(`${root}/startup-status.json`)).value;
 const runtimeBuildTimeUnchanged=originalBuild.buildTime===runtimeAfter.buildTime;
 const result={originalCohortMetadataUnchanged,wholeCohortContentUnchanged,metadataGraph,metadataComparison:'authoritative-full-rdf-term-v2',sameRuntime,runtimeBuildTimeUnchanged,runtimeBuildTime:runtimeAfter.buildTime,runtime:runtimeBefore,observedAt:new Date().toISOString(),originalJob:job.jobId===before.jobId,
 originalBinding:JSON.stringify(job.request)===JSON.stringify(before.request),state:job.state,attempts:job.attempt.count,
 originalBindingSeal,originalBindingOperation,identityTuples:tuples,originalSealAndIntent,exactContent,lifecycleComplete,wmCleared,catalogCount:catalogs.length,restartCatalogOccurrences:catalogs.filter(r=>r.assertionCoordinate===restartName).length,
 noAdditionalPublicationEffects:publications.length===counts.publications&&publications.every(j=>mainPublications.some(old=>old.jobId===j.jobId&&old.finalization.txHash===j.finalization.txHash)),nonces,manualRepairs:0};
 fs.writeFileSync(`${dir}/identity-proof.json`,JSON.stringify(result,null,2));console.log(result);
 if(!originalCohortMetadataUnchanged||!wholeCohortContentUnchanged||!runtimeBuildTimeUnchanged||!originalBindingSeal||!originalBindingOperation||!tuples.exactCatalogIdentity||!tuples.exactInventoryIdentity||!sameRuntime||!result.originalJob||!result.originalBinding||job.state!=='succeeded'||!originalSealAndIntent||!exactContent||!lifecycleComplete||!wmCleared||catalogs.length!==counts.restart||result.restartCatalogOccurrences!==1||!result.noAdditionalPublicationEffects||nonces.some(n=>!n.unchanged))process.exitCode=1;
}else throw Error('Expected before or after');
