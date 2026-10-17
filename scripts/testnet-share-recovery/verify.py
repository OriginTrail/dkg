"""Read-only full-denominator evidence reduction; never repairs a failed operation."""
import json,pathlib,sys,collections,datetime,hashlib,math
from payload_evidence import audit_graphs
from metadata_evidence import index_authoritative_metadata, preserves_original_operation, valid_operation_record
from campaign_manifest import load_campaign, campaign_counts
from publication_evidence import validate_publication_cohort
from scope_evidence import load_scope_evidence
arm,label=sys.argv[1:3]; root=pathlib.Path('.tmp/2963/evidence')/arm; end=root/label
read=lambda p:json.load(open(p))
rdf=read(end/'rdf.json')['results']['bindings']; pre=read(root/'pre-workload/rdf.json')['results']['bindings']
campaign=load_campaign(arm); counts=campaign_counts(campaign); names=campaign['cohorts']['initial']+campaign['cohorts']['shares']
cg=campaign['contextGraphId']; author=campaign['author']; dkg='http://dkg.io/ontology/'
injected_labels=['share:'+fault['name'] for fault in campaign['faults']]
metadata_graph=f'did:dkg:context-graph:{cg}/_meta'
index=index_authoritative_metadata(rdf,metadata_graph); before=index_authoritative_metadata(pre,metadata_graph)
def exact(rows):return sorted((r['p']['value'],r['o']['type'],r['o']['value'],r['o'].get('datatype'),r['o'].get('xml:lang')) for r in rows)
def property(rows,p):return [r['o']['value'] for r in rows if r['p']['value']==dkg+p]
def exact_property(rows,p,expected,kind='literal'):
 values=[r['o'] for r in rows if r['p']['type']=='uri' and r['p']['value']==dkg+p]
 if len(values)!=1:return False
 value=values[0]
 if kind=='uri':return value['type']=='uri' and value['value']==expected
 return (value['type'] in ('literal','typed-literal') and value['value']==expected
  and value.get('datatype','http://www.w3.org/2001/XMLSchema#string')=='http://www.w3.org/2001/XMLSchema#string'
  and not value.get('xml:lang'))
catalogs=read(end/'catalogs.json')
inventory_scope=load_scope_evidence(campaign,end)
inv=inventory_scope.pop('rows'); cr=inventory_scope.pop('catalogRows')
invnames=collections.Counter(r['assertion_coordinate'] for r in inv);catnames=collections.Counter(r['assertionCoordinate'] for r in cr)
jobs=read(end/'-api-publisher-jobs.json')['value']['jobs']
coordinates={name:property(before[f'did:dkg:context-graph:{cg}/assertion/{author}/{name}'],'kaUal')[0] for name in names}
publication_identity=validate_publication_cohort(campaign,read(root/'publication-admissions.json'),jobs,read(root/'seal-proof.json'))
published=set(campaign['cohorts']['publications'])
graph_audit=audit_graphs(rdf,cg,arm,coordinates,published,read(root/'context-graph.json')['value']['onChainId'],campaign['triplesPerAsset'])
assets=[]
for name in names:
 seal=f'did:dkg:context-graph:{cg}/assertion/{author}/{name}'; life=f'urn:dkg:assertion:{cg}:{author}:{name}'; s=index[seal]; l=index[life]
 graph_proof=graph_audit['assets'][name]
 op=property(l,'shareOperationId')
 expected_state, expected_layer = ('published','VM') if name in published else ('promoted','SWM')
 root_value=property(before[seal],'assertionMerkleRoot')
 lifecycle_complete=(exact_property(l,'state',expected_state) and exact_property(l,'memoryLayer',expected_layer)
  and exact_property(l,'assertionGraph',graph_proof['requiredGraph'],'uri') and len(root_value)==1
  and exact_property(l,'vmCurrentAssertion' if name in published else 'swmCurrentAssertion',root_value[0])
  and (name in published or exact_property(l,'swmShareComplete','true')))
 assets.append({'name':name,'lifecycleComplete':lifecycle_complete,'kaUal':property(s,'kaUal'),'version':property(s,'assertionVersion'),'sealUnchanged':exact([r for r in s if r['p']['value'] not in [dkg+'memoryLayer',dkg+'publishedAtTx',dkg+'publishedAtBlock']])==exact([r for r in before[seal] if r['p']['value'] not in [dkg+'memoryLayer',dkg+'publishedAtTx',dkg+'publishedAtBlock']]),'state':property(l,'state'),'memoryLayer':property(l,'memoryLayer'),'operationId':op,'originalOperationPreserved':preserves_original_operation(before[life],l),'finalOperationValid':valid_operation_record(l),'intent':property(l,'promoteOperationIntent'),'completion':property(l,'swmShareComplete'),**graph_proof,'inventoryOccurrences':invnames[name],'catalogOccurrences':catnames[name]})
shares=read(root/'synchronous-shares.json'); admissions=read(root/'publication-admissions.json'); jobs=read(end/'-api-publisher-jobs.json')['value']['jobs']; proto=read(root/'protocol.json')
ms=lambda s:datetime.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()*1000
latencies=sorted(j['timestamps']['finalizedAt']-j['timestamps']['acceptedAt'] for j in jobs if j['status']=='finalized')
percentile=lambda a,p:a[min(len(a)-1,math.ceil(len(a)*p)-1)] if a else None
summary={'arm':arm,'snapshot':label,'requests':len(shares),'httpStatuses':dict(collections.Counter(str(s['status']) for s in shares)),'natural':{'denominator':counts['natural'],'http200':sum(r['status']==200 for r in shares if r['label'] not in injected_labels)},'injected':{'denominator':counts['injected'],'results':[r for r in shares if r['label'] in injected_labels]},'publications':{'identity':publication_identity,'admissions':len(admissions),'admitted':sum(r['status']==202 for r in admissions),'states':dict(collections.Counter(j['status'] for j in jobs)),'latencyP50Ms':percentile(latencies,.5),'latencyP90Ms':percentile(latencies,.9)},'inventory':{'scope':inventory_scope,'actual':len(inv),'expected':counts['main'],'missing':sorted(set(names)-set(invnames)),'extra':sorted(set(invnames)-set(names)),'duplicates':[n for n,c in invnames.items() if c!=1]},'catalog':{'actual':len(cr),'expected':counts['main'],'missing':sorted(set(names)-set(catnames)),'extra':sorted(set(catnames)-set(names)),'duplicates':[n for n,c in catnames.items() if c!=1]},'sealChanged':[a['name'] for a in assets if not a['sealUnchanged']],'missingLifecycle':[a['name'] for a in assets if not a['state']],'lifecycleErrors':[a['name'] for a in assets if not a['lifecycleComplete']],'operationErrors':[a['name'] for a in assets if not a['originalOperationPreserved'] or (a['lifecycleComplete'] and not a['finalOperationValid'])],'manualRepairs':0,'assets':assets,'graphAudit':{k:v for k,v in graph_audit.items() if k!='assets'},'contentErrors':[a['name'] for a in assets if not a['requiredGraphPresent'] or not all(a['exactContentByGraph'].values()) or (a['lifecycleComplete'] and not a['wmEmpty'])]}
if latencies and len(latencies)==counts['publications']:
 finish=max(j['timestamps']['finalizedAt'] for j in jobs); duration=finish-ms(proto['startedAt']);summary['publications'].update(fullCohortMakespanMs=duration,fullCohortPerSecond=counts['publications']*1000/duration)
(root/'verification.json').write_text(json.dumps(summary,indent=2));print(json.dumps({k:v for k,v in summary.items() if k not in ['assets','injected']},indent=2))

if not publication_identity["valid"] or not inventory_scope["valid"]:sys.exit(1)
