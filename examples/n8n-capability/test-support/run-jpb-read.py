"""Execute the actual SSH reader offline, replacing only host, token and HTTP I/O."""
import contextlib
import io
import json
from pathlib import Path
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import patch

fixture = json.load(sys.stdin)
token = 'fictional-offline-jpb-read-token'
calls = []
reads = []


def token_text(path, *_args, **_kwargs):
    assert str(path) == '/home/adminuser/.dkg/auth.token', 'Unexpected credential read'
    return '# synthetic credential\n\nBearer ' + token + '\n'


class Response(io.BytesIO):
    def read(self, size=-1):
        reads.append(size)
        return super().read(size)


def urlopen(request, timeout):
    url = urllib.parse.urlsplit(request.full_url)
    body = None if request.data is None else json.loads(request.data)
    calls.append({'method': request.get_method(), 'path': url.path, 'body': body,
                  'authorized': request.get_header('Authorization') == 'Bearer ' + token, 'timeout': timeout})
    assert url.scheme == 'http' and url.netloc == '127.0.0.1:9200', 'Unexpected destination'
    if request.get_method() == 'GET' and url.path == '/api/status':
        response = fixture['status']
    elif request.get_method() == 'POST' and url.path == '/api/query':
        response = fixture['response']
    else:
        raise AssertionError('Unexpected HTTP request')
    if url.path in fixture.get('httpErrors', {}):
        raise urllib.error.HTTPError(request.full_url, fixture['httpErrors'][url.path],
                                     'Synthetic HTTP failure', {}, io.BytesIO(b'{}'))
    raw = json.dumps(response, ensure_ascii=False).encode('utf8')
    if fixture.get('oversizedPath') == url.path:
        raw += b' ' * (2 * 1024 * 1024 + 1)
    return Response(raw)


output = io.StringIO()
try:
    with patch.object(socket, 'gethostname', return_value=fixture['hostname']), \
         patch.object(Path, 'read_text', token_text), patch.object(urllib.request, 'urlopen', urlopen), \
         patch.object(socket, 'create_connection', side_effect=AssertionError('Network access forbidden')), \
         contextlib.redirect_stdout(output):
        exec(compile(fixture['readerSource'], sys.argv[1], 'exec'), {'PAYLOAD': fixture['payload']})
    report = {'ok': True, 'result': json.loads(output.getvalue())}
except Exception as error:
    report = {'ok': False, 'error': type(error).__name__, 'message': str(error)}
report.update({'calls': calls, 'reads': reads, 'printed': output.getvalue()})
print(json.dumps(report, ensure_ascii=False))
