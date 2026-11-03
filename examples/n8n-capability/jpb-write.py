# Executed over the existing SSH connection; credentials never leave the JPB host.
import hashlib,json,urllib.request,urllib.error,urllib.parse,socket
from pathlib import Path
assert socket.gethostname()=='dmaast-mainnet-edge-2'
token=next(x.strip() for x in Path('/home/adminuser/.dkg/auth.token').read_text().splitlines() if x.strip() and not x.startswith('#')).removeprefix('Bearer ')
graph='0xf77258a965ba13adc77bca85da7c6a287272959a/jpb-plca-study'
def call(path,body=None):
 req=urllib.request.Request('http://127.0.0.1:9200'+path,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},data=None if body is None else json.dumps(body).encode())
 with urllib.request.urlopen(req,timeout=40) as r:return json.load(r)
status=call('/api/status')
assert status['peerId']=='12D3KooWNaxdaVran5jSeMFVKzm1nBESdpnQfeXCz6uzTrqSALC5'
g=next(g for g in call('/api/context-graph/list')['contextGraphs'] if g['id']==graph)
assert g['accessPolicy']=='private' and g['callerInvolved']
name=PAYLOAD['name'];path='/api/knowledge-assets/'+urllib.parse.quote(name,safe='');query='?'+urllib.parse.urlencode({'contextGraphId':graph})
created=False
try: metadata=call(path+query)
except urllib.error.HTTPError as e:
 if e.code!=404:raise
 if not PAYLOAD['allowCreate']:raise RuntimeError('Previous write is unconfirmed; reconcile before another creation')
 metadata=call('/api/knowledge-assets',{'contextGraphId':graph,'name':name,'quads':PAYLOAD['quads'],'finalize':True,'alsoShareSwm':False,'alsoPublishVm':False});created=True
readback=call(path+'/wm/quads'+query)
def term(value):
 return ('literal',json.loads(value)) if value.startswith(chr(34)) else ('iri',value)
actual={(q['subject'],q['predicate'],term(q['object'])) for q in readback['quads']}
expected={(q['subject'],q['predicate'],term(q['object'])) for q in PAYLOAD['quads']}
assert actual==expected,'JPB readback differs from selected execution'
stored=next(json.loads(q['object']) for q in readback['quads'] if q['predicate']=='urn:nos:workflow:payload')
assert hashlib.sha256(stored.encode()).hexdigest()==PAYLOAD['digest']
metadata=call(path+query)
assert metadata['status']=='wm-sealed'
print(json.dumps({'contextGraphId':graph,'name':name,'peerId':status['peerId'],'layer':'wm','readbackVerified':True,'created':created,'tripleCount':len(actual),'digest':PAYLOAD['digest'],'metadata':metadata}))
