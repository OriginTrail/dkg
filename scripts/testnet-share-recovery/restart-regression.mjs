import { loadCampaign, campaignCounts } from './campaign-manifest.mjs';
import { observeRestartRecoveryPoll } from './restart-observation.mjs';
import { getAllJobPages } from './job-pages.mjs';
// Separate from the fixed-denominator comparison. No publication or HTTP replay.
import fs from 'node:fs';
import path from 'node:path';
import {loadApiClientToken} from '../../packages/cli/dist/auth.js';
import {DkgHomeFiles} from '../../packages/cli/dist/config.js';
const [arm, mode] = process.argv.slice(2);
const home = process.env.DKG_HOME, dir = `.tmp/2963/evidence/${arm}/restart-regression`;
fs.mkdirSync(dir, {recursive:true});
const cfg = JSON.parse(fs.readFileSync(path.join(home,'config.json')));
const campaign = loadCampaign(arm), counts = campaignCounts(campaign);
const cg = campaign.contextGraphId, [name] = campaign.cohorts.restart;
if (cfg.contextGraphs[0] !== cg) throw Error('Runtime graph differs from campaign');
const token = await loadApiClientToken(new DkgHomeFiles(home));
const base = `http://127.0.0.1:${cfg.apiPort}`;
const headers = {Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
const save = (file,value) => fs.writeFileSync(`${dir}/${file}.json`,JSON.stringify(value,null,2));
async function get(route) {
  const r = await fetch(base+route,{headers,signal:AbortSignal.timeout(campaign.readTimeoutMs)});
  return {status:r.status,value:await r.json()};
}
if (mode === 'start') {
  if (!fs.existsSync(`.tmp/2963/evidence/${arm}/${arm}-observation-complete.json`)) throw Error('Matched arm must finish before crash regression');
  if (fs.existsSync(`${dir}/request.json`)) throw Error('Crash request already recorded; never replay it');
  const runtime = await get('/api/status');
  if (runtime.status !== 200 || !runtime.value.commit) throw Error('Cannot pin running revision');
  save('runtime-before', { version: runtime.value.version, commit: runtime.value.commit, peerId: runtime.value.peerId });
  const old = JSON.parse(fs.readFileSync(path.join(home,'2963-faults.json')));
  if (old.some(f=>f.name===name)) throw Error('Crash fault already armed');
  old.push({name,kind:'process-exit',contextGraphId:cg,agentAddress:campaign.author});
  fs.writeFileSync(path.join(home,'2963-faults.json'),JSON.stringify(old,null,2));
  const request = {startedAt:new Date().toISOString(),contextGraphId:cg,name,manualRepairs:0};
  save('request',request); // durable denominator before sending
  try {
    const r = await fetch(base+'/api/knowledge-assets',{method:'POST',headers,signal:AbortSignal.timeout(campaign.requestTimeoutMs),
      body:JSON.stringify({contextGraphId:cg,name,finalize:true,alsoShareSwm:true,
        quads:Array.from({length:campaign.triplesPerAsset},(_,i)=>({subject:`urn:2963:${arm}:${name}`,predicate:`https://schema.org/p${i}`,object:JSON.stringify(`${name} value ${i}`),graph:''}))})});
    save('response',{status:r.status,value:await r.json(),at:new Date().toISOString()});
  } catch(error) {save('response',{status:null,error:error.message,at:new Date().toISOString()});}
  console.log('Crash request sent once; observe the existing supervisor replacing the process without manual restart or HTTP replay.');
} else if (mode === 'observe') {
  const fault = JSON.parse(fs.readFileSync(path.join(home,`2963-fault-${name}.json`)));
  const deadline = Date.parse(fault.firedAt)+campaign.restartDeadlineMs;
  save('protocol',{faultAt:fault.firedAt,deadline:new Date(deadline).toISOString(),leaseMs:campaign.leaseMs,manualRepairs:0});
  let firstSuccess;
  while (Date.now() <= deadline) {
    const requestStartedAt = new Date().toISOString();
    try {
      const observation = await observeRestartRecoveryPoll(async () => {
      const [jobs,descriptor,status] = await Promise.all([
        getAllJobPages(get, '/api/knowledge-assets/swm/share-jobs'),
        get(`/api/knowledge-assets/${name}?${new URLSearchParams({contextGraphId:cg,agentAddress:campaign.author})}`),
        get('/api/status'),
      ]);
      // Not finding the job in a walk proves nothing (it may be admitted behind the cursor): the poll only counts a job it saw succeed.
      const job = jobs.value.jobs.find(j=>j.assertionName===name);
      const catalog = status.value.rfc64Catalog?.contextGraphs?.find(c=>c.contextGraphId===cg);
      return {job,descriptor,catalog};
      }, deadline, counts.restart);
      fs.appendFileSync(`${dir}/observations.jsonl`,JSON.stringify(observation)+'\n');
      if (!firstSuccess && observation.succeededBeforeDeadline) {
        firstSuccess=observation;save('first-success',observation);
        console.log('Automatic restart recovery observed',observation.at,observation.job.jobId);
      }
    } catch(error) {fs.appendFileSync(`${dir}/observations.jsonl`,JSON.stringify({requestStartedAt,at:new Date().toISOString(),error:error.message})+'\n');}
    await new Promise(resolve=>setTimeout(resolve,Math.min(campaign.observationIntervalMs,Math.max(1,deadline-Date.now()+1))));
  }
  save('outcome',{completedByDeadline:!!firstSuccess,firstSuccessAt:firstSuccess?.at,manualRepairs:0,observedUntil:new Date().toISOString()});
  if(!firstSuccess)process.exitCode=1;
} else throw Error('Expected start or observe');
