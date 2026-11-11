import { createServer, request } from 'node:http';

/** Leave a chunked upload unfinished: rejection must reach the real client. */
export async function streamedBodyOverflow(handle, { limit = 16384, path = '/', headers = {} } = {}) {
  let destroyedBeforeResponse;
  const server = createServer((req, res) => {
    const writeHead = res.writeHead;
    res.writeHead = function (...args) { destroyedBeforeResponse = req.destroyed; return writeHead.apply(this, args); };
    return handle(req, res);
  });
  let upload;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await new Promise((resolve, reject) => {
      upload = request({ hostname: '127.0.0.1', port: server.address().port, path, method: 'POST', agent: false,
        headers: { connection: 'keep-alive', 'content-type': 'application/json', ...headers } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      upload.on('error', reject);
      upload.setTimeout(3000, () => upload.destroy(new Error('Oversized upload did not receive a response')));
      upload.write(Buffer.alloc(limit, ' '));
      upload.write('x'); // Do not send the terminating chunk or wait for a drain.
    });
    return { ...response, body: JSON.parse(response.body), destroyedBeforeResponse };
  } finally {
    upload?.destroy(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
