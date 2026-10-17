"""Exact full-cohort payload proof after the separately observed daemon crash."""
import json,pathlib,sys
from campaign_manifest import load_campaign, campaign_counts
from payload_evidence import audit_graphs, same_payload_graphs
arm=sys.argv[1]; root=pathlib.Path('.tmp/2963/evidence')/arm
read=lambda p:json.loads(p.read_text())
campaign=load_campaign(arm); names=campaign['cohorts']['initial']+campaign['cohorts']['shares']; restart=campaign['cohorts']['restart']
seals=read(root/'seal-proof.json'); coordinates={s['name']:s['seal']['kaUal'] for s in seals}
assert len(coordinates)==len(names) and set(coordinates)==set(names)
for name in restart:
 fault=read(pathlib.Path('.tmp/2963')/f'{arm}-home'/f'2963-fault-{name}.json')
 uals={q['object'] for q in fault['metadataAtFault']['quads'] if q['predicate']=='http://dkg.io/ontology/kaUal'}
 assert len(uals)==1
 coordinates[name]=uals.pop()
rows=read(root/'restart-readback/rdf.json')['results']['bindings']
prefix=f"did:dkg:context-graph:{campaign['contextGraphId']}/"
original_graphs={prefix+family+'/'+('/'.join(coordinates[name].split('/')[-2:])) for name in names
 for family in ['_working_memory','_shared_memory','_verifiable_memory']}
original_graphs.add(prefix+'context/'+str(read(root/'context-graph.json')['value']['onChainId']))
original_unchanged=same_payload_graphs(read(root/'fixed-deadline/rdf.json')['results']['bindings'],rows,original_graphs)

jobs=read(root/'fixed-deadline/-api-publisher-jobs.json')['value']['jobs']
published={j['request']['knowledgeAssetVmPublish']['name'] for j in jobs if j['status']=='finalized'}
proof=audit_graphs(rows,campaign['contextGraphId'],arm,coordinates,published,read(root/'context-graph.json')['value']['onChainId'],campaign['triplesPerAsset'])
errors=[name for name,p in proof['assets'].items() if not p['requiredGraphPresent'] or not all(p['exactContentByGraph'].values()) or not p['wmEmpty']]
all_exact=(original_unchanged and not errors and proof['materializedGraphPresent'] and all(proof['materializedGraphsExact'].values()) and not proof['unexpectedPayloadGraphs'])
result={'arm':arm,'snapshotObservedAt':read(root/'restart-readback/manifest.json')['observedAt'],'assets':len(coordinates),
 'originalPayloadGraphsUnchanged':original_unchanged,'allExact':all_exact,'contentErrors':errors,'graphAudit':{k:v for k,v in proof.items() if k!='assets'}}
(root/'restart-regression/whole-cohort-content-proof.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
assert result['assets']==campaign_counts(campaign)['restart'] and all_exact
