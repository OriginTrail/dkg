# Runs on the existing JPB host. No SQL fetch, service changes, or token export.
import datetime, hashlib, json, socket, urllib.request
from pathlib import Path
assert socket.gethostname() == 'dmaast-mainnet-edge-2'
assert PAYLOAD == {'orderNo': '62633'}
token = next(s.strip() for s in Path('/home/adminuser/.dkg/auth.token').read_text().splitlines() if s.strip() and not s.lstrip().startswith('#')).removeprefix('Bearer ')
graph = '0xf77258a965ba13adc77bca85da7c6a287272959a/jpb-data'
def call(path, body=None):
    request = urllib.request.Request('http://127.0.0.1:9200'+path, headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'}, data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(request, timeout=8) as response:
        raw=response.read(2*1024*1024+1)
        assert len(raw)<=2*1024*1024, 'Response exceeds limit'
        return json.loads(raw)
status=call('/api/status')
assert status['peerId']=='12D3KooWNaxdaVran5jSeMFVKzm1nBESdpnQfeXCz6uzTrqSALC5'
snapshot='urn:dmaast:jpb:trace:snapshot:6876805538656718c1b000b3b141edeccbef8465076ee8f81d4c7ac95d46591a'
selected=['urn:dmaast:jpb:trace:record:bf97e8ad8bb03b08c855013bfde5d8b4371f76458adfb1aef8da298f25e4bfda','urn:dmaast:jpb:trace:record:cbf0c0755a087cc12b70234e7e9a8d3ea88d4bd75c822cf12de230962665ec2e','urn:dmaast:jpb:trace:record:3789e86fc7cc194875b600483ee6930267f262959f5a36ebe8d94b3912ed7906']
prefix='did:dkg:context-graph:'+graph+'/_working_memory/0xf77258a965ba13adc77bca85da7c6a287272959a/'
branches=['{ GRAPH <'+prefix+number+'> { VALUES ?recordVersion { <'+iri+'> } ?recordVersion d:traceabilityRecordJson ?recordJson; d:logicalId ?logicalRecord . } }' for iri,number in zip(selected,['4085','14902','4081'])]
sparql='PREFIX d: <https://dmaast.eu/ontology/> SELECT DISTINCT ?recordVersion ?recordJson ?logicalRecord ?snapshot ?sourceEvidence ?evidenceCapturedAt WHERE { { '+' UNION '.join(branches)+' } GRAPH <'+prefix+'17347> { VALUES ?snapshot { <'+snapshot+'> } ?snapshot d:hasRecord ?recordVersion; d:supportedBy ?evidenceVersion . ?evidenceVersion d:reference ?sourceEvidence; d:capturedAt ?evidenceCapturedAt . } } LIMIT 4'
rendered=sparql
response=call('/api/query',{'contextGraphId':graph,'view':'working-memory','includeContextGraphPartitions':True,'sparql':rendered})
rows=response.get('result',{}).get('bindings')
assert isinstance(rows,list) and len(rows)==3, 'Query is unavailable or truncated; do not silently use partial input'
def term(value):
    if value is None:return None
    if isinstance(value,dict):return value['value']
    return json.JSONDecoder().raw_decode(value)[0] if value.startswith('"') else value
observed=datetime.datetime.now(datetime.timezone.utc).isoformat()
response_hash=hashlib.sha256(json.dumps(rows,sort_keys=True,separators=(',',':')).encode()).hexdigest()
records=[]
for row in rows:
    record=json.loads(term(row['recordJson']));f=record['fields']
    assert record['table']=='GAMME' and term(row['recordVersion']) in selected
    if f.get('COFRAIS') not in ['CUT','USILU','EBAVM']:continue
    assert f['NAF']=='62633' and record['source']['organisation']=='JPB'
    records.append({'operationCode':f['COFRAIS'],'recordId':term(row['recordVersion']),'logicalId':term(row['logicalRecord']),'orderNo':f['NAF'],'partNumber':f['PARTNUMBER'],'routePhase':f['PHASE'],'operation':f['GA_DES'],
        'evidence':{'contextGraphId':graph,'snapshot':term(row['snapshot']),'sourceEvidence':term(row['sourceEvidence']),'capturedAt':term(row['evidenceCapturedAt']),'responseSha256':response_hash,'readAt':observed,
            'selection':'pinned-snapshot; not latest SQL state'},
        'meaning':'planned-route-reference; not operation execution'})
assert sorted(r['recordId'] for r in records)==sorted(selected), 'Selected routing record identities are missing or duplicated'
assert len(records)==3 and sorted(r['operationCode'] for r in records)==['CUT','EBAVM','USILU'], 'Selected routing rows are missing or duplicated'
print(json.dumps({'records':records,'source':{'node':'JPB','peerId':status['peerId'],'contextGraphId':graph,'orderNo':'62633','querySha256':hashlib.sha256(sparql.encode()).hexdigest(),'readAt':observed,'responseSha256':response_hash,'freshSqlFetch':False,'selection':'pinned-snapshot','snapshot':snapshot}},ensure_ascii=False))
