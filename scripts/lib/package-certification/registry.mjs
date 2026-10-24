// A run-owned candidate overlay. The entire OriginTrail scope fails closed:
// public metadata/cache can never satisfy a candidate internal dependency.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { tarFiles } from './bundle.mjs';

export async function startRegistry({ bundle, manifest, rpcUrl, log, upstream = 'https://registry.npmjs.org' }) {
  const packages = new Map(manifest.packages.map(pkg => [pkg.name, {
    ...pkg, metadata: JSON.parse(tarFiles(fs.readFileSync(path.join(bundle, pkg.tarball))).get('package.json')),
  }]));
  let installing = true;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture:4873');
      if (url.pathname === '/rpc' && req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        if (body.length > 1024 * 1024) throw new Error('RPC fixture body limit');
        const upstreamResponse = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(30_000) });
        res.writeHead(upstreamResponse.status, { 'content-type': 'application/json' });
        res.end(Buffer.from(await upstreamResponse.arrayBuffer()));
        return;
      }
      if (!installing || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(403); res.end(); return; }
      const route = decodeURIComponent(url.pathname.replace(/^\/registry\//, ''));
      if (!url.pathname.startsWith('/registry/')) { res.writeHead(404); res.end(); return; }
      if (route.startsWith('tarballs/')) {
        const pkg = manifest.packages.find(p => p.tarball === route);
        if (!pkg) { res.writeHead(404); res.end(); return; }
        fs.appendFileSync(log, `${JSON.stringify({ event: 'candidate-tarball', name: pkg.name, integrity: pkg.integrity })}\n`);
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        fs.createReadStream(path.join(bundle, pkg.tarball)).pipe(res);
        return;
      }
      if (route.startsWith('@origintrail-official/')) {
        const name = route.split('/').slice(0, 2).join('/');
        const pkg = packages.get(name);
        if (!pkg || route !== name) { res.writeHead(404); res.end('{"error":"candidate package unavailable"}'); return; }
        const metadata = { ...pkg.metadata, dist: { integrity: pkg.integrity, tarball: `http://fixture:4873/registry/${pkg.tarball}` } };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name, 'dist-tags': { latest: pkg.version }, versions: { [pkg.version]: metadata } }));
        return;
      }
      const response = await fetch(`${upstream}/${route}${url.search}`, { signal: AbortSignal.timeout(120_000) });
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/octet-stream' });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      fs.appendFileSync(log, `${JSON.stringify({ event: 'error', message: error.message })}\n`);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  return { port: server.address().port, setInstalling: value => { installing = value; }, close: () => new Promise(resolve => server.close(resolve)) };
}
