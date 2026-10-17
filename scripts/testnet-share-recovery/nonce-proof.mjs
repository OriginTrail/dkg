import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../packages/cli/package.json',import.meta.url));
const {JsonRpcProvider,Contract,Interface,id,zeroPadValue}=require('ethers');
const [arm]=process.argv.slice(2), dir=`.tmp/2963/evidence/${arm}`;
const end=JSON.parse(fs.readFileSync(dir+'/reconciliation.json'));
const start=arm==='baseline'
 ?JSON.parse(fs.readFileSync('.tmp/2963/evidence/baseline-balances-nonces.json')).wallets
 :JSON.parse(fs.readFileSync(dir+'/environment.json')).walletBalancesAndNoncesBeforeGraphRegistration;
const bindings=JSON.parse(fs.readFileSync('.tmp/2963/evidence/baseline-balances-nonces.json'));
const provider=new JsonRpcProvider('https://sepolia.base.org',84532,{staticNetwork:true});
const hub=new Contract(bindings.hub,['function getAssetStorageAddress(string) view returns(address)'],provider);
const storage=await hub.getAssetStorageAddress('ContextGraphStorage');
const raw=JSON.parse(fs.readFileSync('packages/chain/abi/ContextGraphStorage.json'));
const cgInterface=new Interface(raw.abi??raw);
const approvalTopic=id('Approval(address,address,uint256)');
const cgTopic=cgInterface.getEvent('ContextGraphCreated').topicHash;
const fromBlock=Math.max(0,Math.min(...end.receipts.map(r=>r.blockNumber))-2000);
const toBlock=Math.max(...end.receipts.map(r=>r.blockNumber));
const eventTransactions=new Map(end.receipts.map(r=>[r.hash,{kind:'publication',blockNumber:r.blockNumber}]));
for(let from=fromBlock;from<=toBlock;from+=200){
 const to=Math.min(toBlock,from+199);
 for(const [address,topics,kind] of [[bindings.token,[approvalTopic,start.map(w=>zeroPadValue(w.address,32))],'token-approval'],[storage,[cgTopic,null,zeroPadValue(start[0].address,32)],'context-graph-registration']]){
  await new Promise(resolve=>setTimeout(resolve,400));
  const logs=await provider.getLogs({address,topics,fromBlock:from,toBlock:to});
  for(const log of logs)if(eventTransactions.get(log.transactionHash)?.kind!=='publication')eventTransactions.set(log.transactionHash,{kind,blockNumber:log.blockNumber});
 }
}
const transactions=[];
for(const [hash,event] of eventTransactions){
 await new Promise(resolve=>setTimeout(resolve,400));
 const tx=await provider.getTransaction(hash);if(!tx)throw Error('Transaction missing '+hash);
 const old=start.find(w=>w.address.toLowerCase()===tx.from.toLowerCase());
 const latest=end.wallets.find(w=>w.address.toLowerCase()===tx.from.toLowerCase());
 if(!old||tx.nonce<old.latest||tx.nonce>=latest.latest)continue;
 const receipt=await provider.getTransactionReceipt(hash);if(!receipt)throw Error('Receipt missing '+hash);
 transactions.push({hash,from:tx.from,to:tx.to,nonce:tx.nonce,status:receipt.status,selector:tx.data.slice(0,10),...event});
}
const gaps=[];
for(const old of start){const latest=end.wallets.find(w=>w.address===old.address);for(let nonce=old.latest;nonce<latest.latest;nonce++){
 const matches=transactions.filter(t=>t.from.toLowerCase()===old.address.toLowerCase()&&t.nonce===nonce);
 if(matches.length!==1||matches[0].status!==1)gaps.push({address:old.address,nonce,matches:matches.length});
}}
const result={fromBlock,toBlock,transactions,gaps,allAccountedFor:gaps.length===0};fs.writeFileSync(dir+'/nonce-proof.json',JSON.stringify(result,null,2));
console.log({transactions:transactions.length,kinds:transactions.reduce((out,t)=>(out[t.kind]=(out[t.kind]??0)+1,out),{}),gaps});provider.destroy();if(gaps.length)process.exitCode=1;
