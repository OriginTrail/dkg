"""Execute the deployed writer offline; replace only its host, credential and HTTP boundaries."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import patch

fixture = json.load(sys.stdin)
payload = fixture['payload']
scenario = fixture.get('scenario', {})
graph = '0xf77258a965ba13adc77bca85da7c6a287272959a/jpb-plca-study'
peer = '12D3KooWNaxdaVran5jSeMFVKzm1nBESdpnQfeXCz6uzTrqSALC5'
token = 'fictional-offline-jpb-test-token'
asset_path = '/api/knowledge-assets/' + urllib.parse.quote(payload['name'], safe='')
exists = scenario.get('exists', True)
calls = []


def token_text(path, *_args, **_kwargs):
    assert str(path) == '/home/adminuser/.dkg/auth.token', 'Unexpected credential read'
    return '# synthetic credential\n\nBearer ' + token + '\n'


def urlopen(request, timeout):
    global exists
    url = urllib.parse.urlsplit(request.full_url)
    body = None if request.data is None else json.loads(request.data)
    calls.append({'method': request.get_method(), 'path': url.path, 'query': urllib.parse.parse_qs(url.query),
                  'body': body, 'authorized': request.get_header('Authorization') == 'Bearer ' + token, 'timeout': timeout})
    assert url.scheme == 'http' and url.netloc == '127.0.0.1:9200', 'Unexpected destination'
    if url.path == '/api/status':
        result = {'peerId': scenario.get('peerId', peer)}
    elif url.path == '/api/context-graph/list':
        result = {'contextGraphs': [{'id': graph, 'accessPolicy': scenario.get('accessPolicy', 'private'),
                                    'callerInvolved': scenario.get('callerInvolved', True)}]}
    elif request.get_method() == 'POST' and url.path == '/api/knowledge-assets':
        exists = True
        result = {'status': 'wm-draft'}
    elif url.path == asset_path:
        status = scenario.get('metadataError') or (None if exists else 404)
        if status:
            raise urllib.error.HTTPError(request.full_url, status, 'synthetic metadata error', {}, io.BytesIO(b'{}'))
        result = {'status': scenario.get('metadataStatus', 'wm-sealed'), 'reservedUal': 'urn:fixture:sealed-asset'}
    elif url.path == asset_path + '/wm/quads':
        result = {'quads': scenario.get('readback', payload['quads'])}
    else:
        raise AssertionError('Unexpected HTTP request')
    return io.BytesIO(json.dumps(result, ensure_ascii=False).encode('utf8'))


output = io.StringIO()
try:
    with patch.object(socket, 'gethostname', return_value=scenario.get('hostname', 'dmaast-mainnet-edge-2')), \
         patch.object(Path, 'read_text', token_text), patch.object(urllib.request, 'urlopen', urlopen), \
         patch.object(socket, 'create_connection', side_effect=AssertionError('Network access forbidden')), \
         contextlib.redirect_stdout(output):
        runpy.run_path(sys.argv[1], init_globals={'PAYLOAD': payload})
    report = {'ok': True, 'receipt': json.loads(output.getvalue())}
except Exception as error:
    report = {'ok': False, 'error': type(error).__name__, 'message': str(error)}
report.update({'calls': calls, 'printed': output.getvalue()})
print(json.dumps(report, ensure_ascii=False))
