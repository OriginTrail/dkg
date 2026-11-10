# Run on JPB through its existing SSH connection. Credentials stay on that host.
import hashlib,json,socket,urllib.request,urllib.parse,uuid
from pathlib import Path
assert socket.gethostname() == 'dmaast-mainnet-edge-2'
selected=PAYLOAD['selected']; ref=selected['program']
owner='0xF77258a965ba13Adc77bCa85dA7C6A287272959a'
assert selected['node']=='JPB'
assert selected['contextGraphId']=='0xf77258a965ba13adc77bca85da7c6a287272959a/jpb-plca-study'
assert ref['contextGraphId']=='0xf77258a965ba13adc77bca85da7c6a287272959a/jpb-plca-program'
assert ref['programLayer']=='wm' and ref['authorAgentAddress'].lower()==owner.lower()
invocation=str(uuid.UUID(PAYLOAD['invocationId']))
assert invocation==PAYLOAD['invocationId'] and isinstance(PAYLOAD['inputs'],list)
token=next(s.strip() for s in Path('/home/adminuser/.dkg/auth.token').read_text().splitlines() if s.strip() and not s.lstrip().startswith('#')).removeprefix('Bearer ')
def call(path,body=None):
    req=urllib.request.Request('http://127.0.0.1:9200'+path,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','X-DKG-Program-Agent':owner},data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req,timeout=30) as response:
        raw=response.read(2*1024*1024+1)
        assert len(raw)<=2*1024*1024
        return json.loads(raw)
assert call('/api/status')['peerId']=='12D3KooWNaxdaVran5jSeMFVKzm1nBESdpnQfeXCz6uzTrqSALC5'
bindingPath='/api/programs/bindings?'+urllib.parse.urlencode({'contextGraphId':selected['contextGraphId'],'operationIri':selected['operationIri']})
def check():
    approval=call(bindingPath);binding=approval['binding']
    assert approval['bindingDigest']==selected['bindingDigest'] and binding['enabled']
    assert binding['program']==ref and binding['executorAgentAddress'].lower()==owner.lower()
    assert owner.lower() in [a.lower() for a in binding['allowedCallerAgentAddresses']]
check()
source=call('/api/programs/source?'+urllib.parse.urlencode({'contextGraphId':ref['contextGraphId'],'programIri':ref['programIri'],'programLayer':'wm'}))
assert hashlib.sha256(source['source'].encode()).hexdigest()==ref['sourceHash']
assert source['version']==selected['version']
receipt=call('/api/programs/execute',{'contextGraphId':selected['contextGraphId'],'operationIri':selected['operationIri'],'invocationId':invocation,'inputs':PAYLOAD['inputs']})
assert receipt['persisted'] is True and receipt['invocationId']==invocation
assert receipt['executionIri']=='urn:sr:execution:'+invocation
check()
outputs=[]
for output in receipt['outputs']:
    try:outputs.append(json.loads(output))
    except (ValueError,TypeError):outputs.append(output)
print(json.dumps({'invocationId':invocation,'executionIri':receipt['executionIri'],'operationIri':selected['operationIri'],'sourceHash':ref['sourceHash'],'bindingDigest':selected['bindingDigest'],'outputs':outputs},ensure_ascii=False))
