import fs from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(new URL('../../packages/cli/package.json',import.meta.url));
const { JsonRpcProvider, Contract, formatEther }=require('ethers');
const arm=process.argv[2], label=process.argv[3];
const dir=`.tmp/2963/evidence/${arm}`;
const snap=JSON.parse(fs.readFileSync(`${dir}/${label}/-api-publisher-jobs.json`)).value.jobs;
const p=new JsonRpcProvider('https://sepolia.base.org',84532,{staticNetwork:true});
const prior=JSON.parse(fs.readFileSync('.tmp/2963/evidence/baseline-balances-nonces.json'));
const token=new Contract(prior.token,['function balanceOf(address) view returns(uint256)'],p);
const receipts=[];
for(const j of snap){
 if(j.status!=='finalized') throw Error(`Unsettled job ${j.jobId}: ${j.status}`);
 const h=j.finalization.txHash; const r=await p.getTransactionReceipt(h); const t=await p.getTransaction(h);
 if(!r||r.status!==1||!t) throw Error('Unsettled receipt '+h);
 receipts.push({jobId:j.jobId,hash:h,status:r.status,blockNumber:r.blockNumber,from:t.from,nonce:t.nonce,logs:r.logs});
}
const wallets=[];
for(const {address} of prior.wallets){
 const [latest,pending,native,trac]=await Promise.all([p.getTransactionCount(address,'latest'),p.getTransactionCount(address,'pending'),p.getBalance(address),token.balanceOf(address)]);
 wallets.push({address,latest,pending,native:formatEther(native),trac:formatEther(trac)});
}
const result={observedAt:new Date().toISOString(),jobs:snap.length,uniqueHashes:new Set(receipts.map(r=>r.hash)).size,uniqueWalletNonces:new Set(receipts.map(r=>r.from+':'+r.nonce)).size,receipts,wallets,allNoncesSettled:wallets.every(w=>w.latest===w.pending)};
fs.writeFileSync(`${dir}/reconciliation.json`,JSON.stringify(result,null,2));
console.log({jobs:result.jobs,uniqueHashes:result.uniqueHashes,uniqueWalletNonces:result.uniqueWalletNonces,allNoncesSettled:result.allNoncesSettled});
if(!result.allNoncesSettled)process.exitCode=1;
p.destroy();
