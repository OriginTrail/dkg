#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Keep Ubuntu's suites, components and signing keys. APT verifies the same
// signed archive through an independently hosted HTTPS mirror before trying
// Canonical's endpoint; equal-priority mirror entries would be randomized.
const MIRRORS = 'https://mirrors.edge.kernel.org/ubuntu/\tpriority:1\n'
  + 'https://archive.ubuntu.com/ubuntu/\tpriority:2\n';
const MIRROR_URI = 'mirror+file:/etc/apt/apt-mirrors.txt';

export function configureUbuntuApt(aptDirectory) {
  const sourcesDirectory = path.join(aptDirectory, 'sources.list.d');
  const files = [path.join(aptDirectory, 'sources.list'),
    ...fs.readdirSync(sourcesDirectory).filter(name => /\.(list|sources)$/.test(name))
      .map(name => path.join(sourcesDirectory, name))].filter(file => fs.existsSync(file));
  const sources = files.map(file => ({ file, original: fs.readFileSync(file, 'utf8') }))
    .map(source => ({ ...source, updated: source.original.replace(
      /https?:\/\/(?:azure\.archive|archive|security)\.ubuntu\.com\/ubuntu\/?(?=\s|$)/g,
      MIRROR_URI,
    ) }));
  if (!sources.some(source => source.updated.includes(MIRROR_URI))) {
    throw new Error('No supported Ubuntu archive source found; refusing to change APT configuration');
  }
  fs.writeFileSync(path.join(aptDirectory, 'apt-mirrors.txt'), MIRRORS);
  for (const { file, original, updated } of sources) {
    if (updated !== original) fs.writeFileSync(file, updated);
  }
  fs.writeFileSync(path.join(aptDirectory, 'apt.conf.d', '80-dkg-ci-downloads'),
    'Acquire::Retries "2";\nAcquire::http::Timeout "20";\nAcquire::https::Timeout "20";\nAPT::Update::Error-Mode "any";\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('Ubuntu archive setup is restricted to disposable GitHub Actions runners');
  }
  configureUbuntuApt('/etc/apt');
  console.log('Configured signed Ubuntu archives with an independent HTTPS mirror and bounded retries.');
}
