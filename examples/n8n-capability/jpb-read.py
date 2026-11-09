# Runs on the existing JPB host. No SQL fetch, service changes, or token export.
import datetime, hashlib, json, socket, urllib.request
from pathlib import Path
assert socket.gethostname() == 'dmaast-mainnet-edge-2'
# READ_SPEC is embedded from the trusted shared artifact by the SSH bundle.
assert PAYLOAD == {'orderNo': READ_SPEC['orderNo']}
token = next(s.strip() for s in Path('/home/adminuser/.dkg/auth.token').read_text().splitlines() if s.strip() and not s.lstrip().startswith('#')).removeprefix('Bearer ')
graph = READ_SPEC['contextGraphId']
def call(path, body=None):
    request = urllib.request.Request('http://127.0.0.1:9200'+path, headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'}, data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(request, timeout=8) as response:
        raw=response.read(2*1024*1024+1)
        assert len(raw)<=2*1024*1024, 'Response exceeds limit'
        return json.loads(raw)
status=call('/api/status')
assert status['peerId']=='12D3KooWNaxdaVran5jSeMFVKzm1nBESdpnQfeXCz6uzTrqSALC5'
snapshot=READ_SPEC['snapshot']
selected=[record['iri'] for record in READ_SPEC['records']]
sparql=READ_SPEC['query']['sparql']
response=call('/api/query',READ_SPEC['query'])
rows=response.get('result',{}).get('bindings')
assert isinstance(rows,list) and len(rows)==len(selected), 'Query is unavailable or truncated; do not silently use partial input'
def term(value):
    if value is None:return None
    if isinstance(value,dict):return value['value']
    return json.JSONDecoder().raw_decode(value)[0] if value.startswith('"') else value
observed=datetime.datetime.now(datetime.timezone.utc).isoformat()
response_hash=hashlib.sha256(json.dumps(rows,sort_keys=True,separators=(',',':')).encode()).hexdigest()
records=[]
for row in rows:
    record=json.loads(term(row['recordJson']));f=record['fields']
    assert record['table']==READ_SPEC['table'] and term(row['recordVersion']) in selected
    if f.get(READ_SPEC['fields']['operationCode']) not in READ_SPEC['operationCodes']:continue
    assert f[READ_SPEC['fields']['orderNo']]==READ_SPEC['orderNo'] and record['source']['organisation']==READ_SPEC['organisation']
    records.append({**{key:f[field] for key,field in READ_SPEC['fields'].items()},'recordId':term(row['recordVersion']),'logicalId':term(row['logicalRecord']),
        'evidence':{'contextGraphId':graph,'snapshot':term(row['snapshot']),'sourceEvidence':term(row['sourceEvidence']),'capturedAt':term(row['evidenceCapturedAt']),'responseSha256':response_hash,'readAt':observed,
            'selection':READ_SPEC['evidenceSelection']},
        'meaning':READ_SPEC['meaning']})
assert sorted(r['recordId'] for r in records)==sorted(selected), 'Selected routing record identities are missing or duplicated'
assert len(records)==len(selected) and sorted(r['operationCode'] for r in records)==sorted(READ_SPEC['operationCodes']), 'Selected routing rows are missing or duplicated'
print(json.dumps({'records':records,'source':{'node':READ_SPEC['node'],'peerId':status['peerId'],'contextGraphId':graph,'orderNo':READ_SPEC['orderNo'],'querySha256':hashlib.sha256(sparql.encode()).hexdigest(),'readAt':observed,'responseSha256':response_hash,'freshSqlFetch':False,'selection':READ_SPEC['selection'],'snapshot':snapshot}},ensure_ascii=False))
