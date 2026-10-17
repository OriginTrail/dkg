import { isHash, requireReceiptBlockIdentity } from './chain-block-identity.mjs';
import { loadCampaign } from './campaign-manifest.mjs';
import { requirePublicationCohort } from './publication-evidence.mjs';
import fs from 'node:fs';import{createRequire}from'node:module';const require=createRequire(new URL('../../packages/cli/package.json',import.meta.url));const{Interface}=require('ethers');
const[arm,label]=process.argv.slice(2),dir=`.tmp/2963/evidence/${arm}`;
const abi=JSON.parse(fs.readFileSync('packages/chain/abi/DKGKnowledgeAssets.json'));const iface=new Interface(abi.abi??abi);
const rec=JSON.parse(fs.readFileSync(dir+'/reconciliation.json'));const jobs=JSON.parse(fs.readFileSync(`${dir}/${label}/-api-publisher-jobs.json`)).value.jobs;
const originalSeals=JSON.parse(fs.readFileSync(dir+'/seal-proof.json'));
requirePublicationCohort(loadCampaign(arm),JSON.parse(fs.readFileSync(dir+'/publication-admissions.json')),jobs,originalSeals);
const configured=JSON.parse(fs.readFileSync('.tmp/2963/evidence/baseline-balances-nonces.json'));
const deployment=JSON.parse(fs.readFileSync(dir+'/chain-deployment.json'));
if(deployment.arm!==arm||String(deployment.chainId)!==String(configured.chainId)||deployment.hub.toLowerCase()!==configured.hub.toLowerCase()
 ||deployment.provenance!=='historical-hub-read-at-canonical-receipt-hash')throw Error('Campaign chain deployment binding mismatch');
const seals=new Map(originalSeals.map(p=>[p.name,p]));const proof=[];
for(const j of jobs){const r=rec.receipts.find(r=>r.jobId===j.jobId),request=j.request.knowledgeAssetVmPublish,seal=seals.get(request.name).seal;
 const blockIdentity=requireReceiptBlockIdentity(r);
 const events=r.logs.flatMap(l=>{try{const p=iface.parseLog(l);return p?.name==='KnowledgeAssetCreated'?[{contract:l.address,id:p.args.id.toString(),author:p.args.author,operationId:p.args.publishOperationId,root:p.args.merkleRoot}]:[]}catch{return[]}});
 const bindings=deployment.blocks.filter(b=>b.blockNumber===r.blockNumber);
 if(bindings.length!==1||!isHash(bindings[0].blockHash)||bindings[0].blockHash.toLowerCase()!==r.blockHash.toLowerCase()||!/^0x[0-9a-fA-F]{40}$/.test(bindings[0].knowledgeAssets)||/^0x0{40}$/i.test(bindings[0].knowledgeAssets))throw Error('Missing or ambiguous historical deployment binding');
 const expectedContract=bindings[0].knowledgeAssets;
 const event=events[0],contractMatches=!!event&&event.contract.toLowerCase()===expectedContract.toLowerCase(); proof.push({...blockIdentity,name:request.name,jobId:j.jobId,txHash:r.hash,publisher:r.from,nonce:r.nonce,createdEvents:events.length,event,expectedContract,contractMatches,identityMatches:contractMatches&&event.id===seal.reservedKaId&&event.root===seal.assertionMerkleRoot&&event.author.toLowerCase()===seal.authorAddress&&request.kaUal===seal.kaUal&&request.assertionVersion===seal.assertionVersion&&j.finalization.ual===seal.kaUal,carrierMatches:j.broadcast.txHash===r.hash&&j.inclusion.txHash===r.hash&&j.finalization.txHash===r.hash&&j.broadcast.nonce===r.nonce&&j.broadcast.walletId.toLowerCase()===r.from.toLowerCase()});
}
fs.writeFileSync(dir+'/chain-proof.json',JSON.stringify(proof,null,2));console.log({publications:proof.length,createdEvents:proof.reduce((n,p)=>n+p.createdEvents,0),identityMatches:proof.filter(p=>p.identityMatches).length,carrierMatches:proof.filter(p=>p.carrierMatches).length,publisherWallets:new Set(proof.map(p=>p.publisher)).size});

if(proof.some(p=>p.createdEvents!==1||!p.identityMatches||!p.carrierMatches))process.exitCode=1;
