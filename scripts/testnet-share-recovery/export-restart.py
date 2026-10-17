"""Allowlisted restart proof export; raw RDF/jobs and claim capabilities stay private."""
import pathlib,json,sys
from campaign_manifest import load_campaign
from scope_evidence import load_scope_evidence, public_scope_evidence, require_matching_scope
arm=sys.argv[1];root=pathlib.Path('.tmp/2963/evidence')/arm;source=root/'restart-regression';out=pathlib.Path('.tmp/2963/exported-evidence')/arm/'restart-regression';out.mkdir(parents=True,exist_ok=True)
write=lambda name,value:(out/name).write_text(json.dumps(value,indent=2)+'\n')
scope=load_scope_evidence(load_campaign(arm),root/'restart-readback')
write('inventory-scope-proof.json',public_scope_evidence(scope))
if not scope['valid']:raise ValueError('Cannot export uncertified scope: '+'; '.join(scope['errors']))
identity=source/'identity-proof.json'
if identity.exists():require_matching_scope(scope,json.loads(identity.read_text()))
missing=[]
for name in ['request.json','response.json','runtime-before.json','protocol.json','outcome.json','before-job.json','after-job.json','identity-proof.json','whole-cohort-content-proof.json','process-before.json','process-restart-proof.json']:
 p=source/name
 if p.exists():write(name,json.loads(p.read_text()))
 else:missing.append(name)
observations=[]
for line in (source/'observations.jsonl').read_text().splitlines():
 x=json.loads(line);job=x.get('job') or {};catalog=x.get('catalog') or {};descriptor=x.get('descriptor') or {}
 observations.append({k:x.get(k) for k in ['requestStartedAt','at','completedWithinDeadline','succeededBeforeDeadline','error']}|{'job':{k:job.get(k) for k in ['jobId','state','attempts','enqueuedAt','finishedAt','nextRetryAt','lastError']},'descriptorStatus':descriptor.get('status'),'catalog':{k:catalog.get(k) for k in ['phase','appliedRowCount','legacyReadOnlyCount','authorityState','authorityFreshness']}})
write('observations.json',observations)
processes=source/'process-observations.jsonl'
if processes.exists():write('process-observations.json',[json.loads(l) for l in processes.read_text().splitlines()])
fault=pathlib.Path('.tmp/2963')/f'{arm}-home'/'2963-fault-restart-recovery.json'
if fault.exists():write('fault.json',{k:v for k,v in json.loads(fault.read_text()).items() if k!='pid'})
for name,keys in [('catalogs.json',['assertionCoordinate','kaId','assertionVersion','sealDigest']),('inventory.json',['assertion_coordinate','ka_ual','assertion_version_u64be','seal_digest','share_operation_id'])]:
 p=root/'restart-readback'/name
 if p.exists():
  rows=scope['catalogRows'] if name=='catalogs.json' else scope['rows'];write(name,[{k:r[k] for k in keys} for r in rows])
write('export-manifest.json',{'requestDenominator':1,'manualShareReplays':0,'manualProcessRestarts':0,'missingEvidence':missing,'osExitStatusCaptured':False,'note':'Process disappearance/replacement is witnessed; code 86 is the injected implementation, not captured OS exit status. The normal 900000 ms lease was not edited.'})
print('Exported restart evidence with',len(observations),'observations; missing files:',missing)
