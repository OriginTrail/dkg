"""Read-only full-denominator evidence reduction; never repairs a failed operation."""
import json,pathlib,sys,collections,datetime,hashlib,math
arm,label=sys.argv[1:3]; root=pathlib.Path('.tmp/2963/evidence')/arm; end=root/label
read=lambda p:json.load(open(p))
rdf=read(end/'rdf.json')['results']['bindings']; pre=read(root/'pre-workload/rdf.json')['results']['bindings']
names=['readiness-smoke']+[f'initial-{i:03}' for i in range(1,180)]+[f'catalog-{i:03}' for i in range(256)]
cg=f'0x247b02c301b34e52e9021728f34c3457f81f2dfc/2963-{arm}-20261016'; author='0x247B02C301B34E52e9021728F34C3457F81f2dFc'; dkg='http://dkg.io/ontology/'
index=collections.defaultdict(list); before=collections.defaultdict(list)
for row in rdf:index[row['s']['value']].append(row)
for row in pre:before[row['s']['value']].append(row)
def exact(rows):return sorted((r['p']['value'],r['o']['type'],r['o']['value'],r['o'].get('datatype'),r['o'].get('xml:lang')) for r in rows)
def property(rows,p):return [r['o']['value'] for r in rows if r['p']['value']==dkg+p]
inv=read(end/'inventory.json')['swm']; catalogs=read(end/'catalogs.json'); cr=[r for c in catalogs for r in c['rows']]
invnames=collections.Counter(r['assertion_coordinate'] for r in inv);catnames=collections.Counter(r['assertionCoordinate'] for r in cr)
assets=[]
for name in names:
 seal=f'did:dkg:context-graph:{cg}/assertion/{author}/{name}'; life=f'urn:dkg:assertion:{cg}:{author}:{name}'; s=index[seal]; l=index[life]
 content=index[f'urn:2963:{arm}:{name}']; layers=collections.defaultdict(list)
 for row in content:
  layer='wm' if '/_working_memory/' in row['g']['value'] else 'swm' if '/_shared/' in row['g']['value'] or '/_shared_memory/' in row['g']['value'] else 'vm' if '/_verifiable_memory/' in row['g']['value'] else row['g']['value']
  layers[layer].append(row)
 expected=sorted((f'https://schema.org/p{i}','literal',f'{name} value {i}',None,None) for i in range(8))
 exactlayers={k:exact(v)==expected for k,v in layers.items()}
 original=property(before[life],'shareOperationId'); op=property(l,'shareOperationId')
 assets.append({'name':name,'kaUal':property(s,'kaUal'),'version':property(s,'assertionVersion'),'sealUnchanged':exact([r for r in s if r['p']['value'] not in [dkg+'memoryLayer',dkg+'publishedAtTx',dkg+'publishedAtBlock']])==exact([r for r in before[seal] if r['p']['value'] not in [dkg+'memoryLayer',dkg+'publishedAtTx',dkg+'publishedAtBlock']]),'state':property(l,'state'),'memoryLayer':property(l,'memoryLayer'),'operationId':op,'originalOperationPreserved':not original or op==original,'intent':property(l,'promoteOperationIntent'),'completion':property(l,'swmShareComplete'),'contentCounts':{k:len(v) for k,v in layers.items()},'exactContentByGraph':exactlayers,'inventoryOccurrences':invnames[name],'catalogOccurrences':catnames[name]})
shares=read(root/'synchronous-shares.json'); admissions=read(root/'publication-admissions.json'); jobs=read(end/'-api-publisher-jobs.json')['value']['jobs']; proto=read(root/'protocol.json')
ms=lambda s:datetime.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()*1000
latencies=sorted(j['timestamps']['finalizedAt']-j['timestamps']['acceptedAt'] for j in jobs if j['status']=='finalized')
percentile=lambda a,p:a[min(len(a)-1,math.ceil(len(a)*p)-1)] if a else None
summary={'arm':arm,'snapshot':label,'requests':len(shares),'httpStatuses':dict(collections.Counter(str(s['status']) for s in shares)),'natural':{'denominator':254,'http200':sum(r['status']==200 for r in shares if r['label'] not in ['share:catalog-140','share:catalog-141'])},'injected':{'denominator':2,'results':[r for r in shares if r['label'] in ['share:catalog-140','share:catalog-141']]},'publications':{'admissions':len(admissions),'admitted':sum(r['status']==202 for r in admissions),'states':dict(collections.Counter(j['status'] for j in jobs)),'latencyP50Ms':percentile(latencies,.5),'latencyP90Ms':percentile(latencies,.9)},'inventory':{'actual':len(inv),'expected':436,'missing':sorted(set(names)-set(invnames)),'extra':sorted(set(invnames)-set(names)),'duplicates':[n for n,c in invnames.items() if c!=1]},'catalog':{'actual':len(cr),'expected':436,'missing':sorted(set(names)-set(catnames)),'extra':sorted(set(catnames)-set(names)),'duplicates':[n for n,c in catnames.items() if c!=1]},'sealChanged':[a['name'] for a in assets if not a['sealUnchanged']],'missingLifecycle':[a['name'] for a in assets if not a['state']],'manualRepairs':0,'assets':assets}
if len(latencies)==48:
 finish=max(j['timestamps']['finalizedAt'] for j in jobs); duration=finish-ms(proto['startedAt']);summary['publications'].update(fullCohortMakespanMs=duration,fullCohortPerSecond=48000/duration)
(root/'verification.json').write_text(json.dumps(summary,indent=2));print(json.dumps({k:v for k,v in summary.items() if k not in ['assets','injected']},indent=2))
