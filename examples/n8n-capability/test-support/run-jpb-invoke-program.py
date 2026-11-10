"""Execute the real SSH Program adapter offline, replacing only external boundaries."""
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
token = 'fictional-offline-jpb-program-token'
calls = []
executed = False


def token_text(path, *_args, **_kwargs):
    assert str(path) == '/home/adminuser/.dkg/auth.token', 'Unexpected credential read'
    return '# synthetic credential\n\nBearer ' + token + '\n'


def urlopen(request, timeout):
    global executed
    url = urllib.parse.urlsplit(request.full_url)
    body = None if request.data is None else json.loads(request.data)
    calls.append({'method': request.get_method(), 'path': url.path, 'query': urllib.parse.parse_qs(url.query),
                  'body': body, 'authorized': request.get_header('Authorization') == 'Bearer ' + token,
                  'agent': request.get_header('X-dkg-program-agent'), 'timeout': timeout})
    assert url.scheme == 'http' and url.netloc == '127.0.0.1:9200', 'Unexpected destination'
    if request.get_method() == 'GET' and url.path == '/api/status':
        key = 'status'
    elif request.get_method() == 'GET' and url.path == '/api/programs/bindings':
        key = 'afterApproval' if executed else 'beforeApproval'
    elif request.get_method() == 'GET' and url.path == '/api/programs/source':
        key = 'source'
    elif request.get_method() == 'POST' and url.path == '/api/programs/execute':
        executed = True
        key = 'receipt'
    else:
        raise AssertionError('Unexpected HTTP request')
    if key in fixture.get('httpErrors', {}):
        raise urllib.error.HTTPError(request.full_url, fixture['httpErrors'][key],
                                     'synthetic HTTP error', {}, io.BytesIO(b'{}'))
    return io.BytesIO(json.dumps(fixture[key], ensure_ascii=False).encode('utf8'))


output = io.StringIO()
try:
    with patch.object(socket, 'gethostname', return_value=fixture['hostname']), \
         patch.object(Path, 'read_text', token_text), patch.object(urllib.request, 'urlopen', urlopen), \
         patch.object(socket, 'create_connection', side_effect=AssertionError('Network access forbidden')), \
         contextlib.redirect_stdout(output):
        runpy.run_path(sys.argv[1], init_globals={'PAYLOAD': fixture['payload']})
    report = {'ok': True, 'receipt': json.loads(output.getvalue())}
except Exception as error:
    report = {'ok': False, 'error': type(error).__name__, 'message': str(error)}
report.update({'calls': calls, 'printed': output.getvalue()})
print(json.dumps(report, ensure_ascii=False))
