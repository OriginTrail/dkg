# Executed over the existing SSH connection; credentials never leave the JPB host.
import hashlib,json,re,urllib.request,urllib.error,urllib.parse,socket
from pathlib import Path

XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string'
def resource(value, predicate=False):
 if not isinstance(value,str):raise ValueError('Invalid RDF resource')
 if value.startswith('_:') and not predicate:
  if not re.fullmatch(r'_:[\w][\w.-]*(?<!\.)',value):raise ValueError('Invalid RDF blank node')
  return ('blank-node',value[2:])
 iri=value[1:-1] if value.startswith('<') and value.endswith('>') else value
 if not re.fullmatch(r'[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|^\x60\\]*',iri):raise ValueError('Invalid RDF IRI')
 return ('iri',iri)

def literal(value):
 # RDF has datatype/language suffixes and escapes that JSON does not accept.
 match=re.fullmatch(r'''"((?:[^"\\\x00-\x1f]|\\(?:[tbnrf"'\\]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}))*)"(?:\^\^<([^<>]+)>|@([A-Za-z]+(?:-[A-Za-z0-9]+)*))?''',value)
 if not match:raise ValueError('Invalid RDF literal')
 body,datatype,language=match.groups()
 def json_escape(escape):
  token=escape.group()
  if token==r"\'":return "'"
  if token.startswith(r'\U'):
   scalar=int(token[2:],16)
   if scalar>0x10ffff or 0xd800<=scalar<=0xdfff:raise ValueError('Invalid RDF Unicode scalar')
   return json.dumps(chr(scalar))[1:-1]
  return token
 # Consume whole escape tokens once: a literal backslash before "u"/"U" is data.
 body=re.sub(r'''\\(?:[tbnrf"'\\]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})''',json_escape,body)
 decoded=json.loads('"'+body+'"')
 decoded.encode('utf8') # Reject lone surrogates; json.loads combines short pairs.
 if language:return ('language',decoded,language.lower())
 return ('literal',decoded,resource(datatype,True)[1] if datatype else XSD_STRING)

def term(value):
 if not isinstance(value,str):raise ValueError('Invalid RDF term')
 return literal(value) if value.startswith('"') else resource(value)

def quad(q):
 graph_term=('default',) if 'graph' not in q or q['graph']=='' else resource(q['graph'])
 return (resource(q['subject']),resource(q['predicate'],True),term(q['object']),graph_term)

expected={quad(q) for q in PAYLOAD['quads']}
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
actual={quad(q) for q in readback['quads']}
assert actual==expected,'JPB readback differs from selected execution'
stored=next(q[2][1] for q in actual if q[1]==('iri','urn:nos:workflow:payload') and q[2][0]=='literal' and q[2][2]==XSD_STRING)
assert hashlib.sha256(stored.encode()).hexdigest()==PAYLOAD['digest']
metadata=call(path+query)
assert metadata['status']=='wm-sealed'
print(json.dumps({'contextGraphId':graph,'name':name,'peerId':status['peerId'],'layer':'wm','readbackVerified':True,'created':created,'tripleCount':len(actual),'digest':PAYLOAD['digest'],'metadata':metadata}))
