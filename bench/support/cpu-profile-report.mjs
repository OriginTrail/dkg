const DEFAULT_WIDTH = 1600;
const FRAME_HEIGHT = 22;
const FRAME_GAP = 1;
const MIN_RENDER_WIDTH = 0.5;

export function buildFlamegraphTree(profile) {
  if (!profile || !Array.isArray(profile.nodes)) {
    throw new Error('CPU profile is missing a nodes array');
  }

  const nodesById = new Map(profile.nodes.map((node) => [node.id, node]));
  const parentsById = new Map();
  for (const node of profile.nodes) {
    for (const childId of node.children ?? []) {
      parentsById.set(childId, node.id);
    }
  }

  const hasTimeDeltas = Array.isArray(profile.timeDeltas) && profile.timeDeltas.length > 0;
  const root = createFrame('total', 'total', 'total', hasTimeDeltas ? 'ms' : 'samples');
  const samples = Array.isArray(profile.samples) ? profile.samples : [];

  if (samples.length > 0) {
    samples.forEach((nodeId, index) => {
      const weight = hasTimeDeltas ? Math.max(0, Number(profile.timeDeltas[index] ?? 0)) / 1000 : 1;
      if (weight === 0) return;
      addStack(root, stackForNode(nodeId, nodesById, parentsById), weight);
    });
    root.sampleCount = samples.length;
    return root;
  }

  for (const node of profile.nodes) {
    const hitCount = Math.max(0, Number(node.hitCount ?? 0));
    if (hitCount === 0) continue;
    addStack(root, stackForNode(node.id, nodesById, parentsById), hitCount);
    root.sampleCount += hitCount;
  }

  return root;
}

export function renderCpuProfileFlamegraphHtml(profile, options = {}) {
  const tree = buildFlamegraphTree(profile);
  const frames = layoutFrames(tree, options.width ?? DEFAULT_WIDTH);
  const depth = Math.max(0, ...frames.map((frame) => frame.depth));
  const svgHeight = (depth + 1) * FRAME_HEIGHT + 28;
  const topFrames = collectSelfTime(tree).slice(0, options.topFrameCount ?? 20);
  const title = options.title ?? 'CPU Flame Graph';
  const profileName = options.profileName ?? 'profile.cpuprofile';
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const benchmarkReportHref = options.benchmarkReportHref ?? '../latest.html';
  const rawProfileHref = options.rawProfileHref ?? `./${profileName}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f8fafc; color: #111827; }
    header { background: #111827; color: #f9fafb; padding: 18px 24px; }
    main { padding: 22px 24px 36px; }
    a { color: #1d4ed8; }
    header a { color: #bfdbfe; }
    .meta { color: #d1d5db; font-size: 13px; margin-top: 6px; }
    .nav { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
    .nav a { border: 1px solid #4b5563; border-radius: 4px; color: #f9fafb; padding: 5px 9px; text-decoration: none; }
    .panel { background: white; border: 1px solid #e5e7eb; border-radius: 6px; margin-bottom: 20px; padding: 16px; }
    .summary { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
    .summary strong { display: block; font-size: 22px; margin-bottom: 2px; }
    .summary span { color: #4b5563; font-size: 13px; }
    .flamegraph { overflow-x: auto; }
    svg { background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; display: block; min-width: ${options.width ?? DEFAULT_WIDTH}px; }
    .frame rect { stroke: rgba(17, 24, 39, .28); stroke-width: .5; }
    .frame text { fill: #111827; font-size: 11px; pointer-events: none; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { color: #374151; font-size: 12px; text-transform: uppercase; }
    code { background: #eef2ff; border-radius: 4px; padding: 1px 4px; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">Generated ${escapeHtml(generatedAt)} from ${escapeHtml(profileName)}.</div>
    <nav class="nav" aria-label="Benchmark profile links">
      <a href="${escapeHtml(benchmarkReportHref)}">ESBench report</a>
      <a href="${escapeHtml(rawProfileHref)}">Raw .cpuprofile</a>
      <a href="./index.html">Profile index</a>
      <a href="./method-analysis.latest.html">Method analysis</a>
    </nav>
  </header>
  <main>
    <section class="panel summary" aria-label="Profile summary">
      <div><strong>${escapeHtml(formatValue(tree.value, tree.unit))}</strong><span>Total sampled CPU time</span></div>
      <div><strong>${escapeHtml(String(tree.sampleCount))}</strong><span>Samples</span></div>
      <div><strong>${escapeHtml(String(depth))}</strong><span>Maximum stack depth</span></div>
    </section>
    <section class="panel">
      <h2>Flame Graph</h2>
      <p>Width represents aggregated sampled CPU time. Frames lower in the graph are callers; frames above them are callees.</p>
      <div class="flamegraph">${renderFlamegraphSvg(frames, tree, depth, options.width ?? DEFAULT_WIDTH, svgHeight)}</div>
    </section>
    <section class="panel">
      <h2>Top Self-Time Frames</h2>
      ${renderTopFramesTable(topFrames, tree.unit)}
    </section>
  </main>
</body>
</html>
`;
}

export function renderProfileIndexHtml(entries, options = {}) {
  const title = options.title ?? 'DKG Benchmark CPU Profiles';
  const benchmarkReportHref = options.benchmarkReportHref ?? '../latest.html';
  const rows = entries.map((entry) => `<tr>
    <td>${escapeHtml(entry.createdAt ?? '')}</td>
    <td><a href="${escapeHtml(entry.esbenchReportHref)}">${escapeHtml(entry.esbenchReportName)}</a></td>
    <td><a href="${escapeHtml(entry.flamegraphHref)}">${escapeHtml(entry.flamegraphName)}</a></td>
    <td><a href="${escapeHtml(entry.profileHref)}">${escapeHtml(entry.profileName)}</a></td>
    <td>${escapeHtml(entry.payloadSizes ?? '10kb,100kb,2mb,200mb')}</td>
    <td>${escapeHtml(entry.sizeBytes == null ? '' : formatBytes(entry.sizeBytes))}</td>
  </tr>`).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f8fafc; color: #111827; }
    header { background: #111827; color: #f9fafb; padding: 18px 24px; }
    main { padding: 22px 24px 36px; }
    a { color: #1d4ed8; }
    header a { color: #bfdbfe; }
    .panel { background: white; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { color: #374151; font-size: 12px; text-transform: uppercase; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(title)}</h1>
    <div><a href="${escapeHtml(benchmarkReportHref)}">Open latest ESBench report</a></div>
    <div><a href="./method-analysis.latest.html">Open latest method analysis</a></div>
  </header>
  <main>
    <section class="panel">
      <table>
        <thead>
          <tr><th>Created</th><th>ESBench report</th><th>Flame graph</th><th>Raw profile</th><th>Payload sizes</th><th>Profile size</th></tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="6">No CPU profiles generated yet.</td></tr>'}</tbody>
      </table>
    </section>
  </main>
</body>
</html>
`;
}

function addStack(root, stack, weight) {
  const frames = stack.map(frameForNode).filter((frame) => frame.key !== 'root');
  if (frames.length === 0) return;

  root.value += weight;
  let cursor = root;
  for (const frame of frames) {
    let child = cursor.children.get(frame.key);
    if (!child) {
      child = createFrame(frame.key, frame.label, frame.detail, root.unit);
      cursor.children.set(frame.key, child);
    }
    child.value += weight;
    cursor = child;
  }
  cursor.self += weight;
}

function stackForNode(nodeId, nodesById, parentsById) {
  const stack = [];
  const seen = new Set();
  let currentId = nodeId;

  while (currentId != null && !seen.has(currentId)) {
    seen.add(currentId);
    const node = nodesById.get(currentId);
    if (!node) break;
    stack.push(node);
    currentId = parentsById.get(currentId);
  }

  return stack.reverse();
}

function frameForNode(node) {
  const frame = node.callFrame ?? {};
  const functionName = frame.functionName || '(anonymous)';
  const url = String(frame.url ?? '');
  const line = Number.isFinite(frame.lineNumber) && frame.lineNumber >= 0 ? frame.lineNumber + 1 : undefined;
  const location = url ? `${shortenUrl(url)}${line == null ? '' : `:${line}`}` : '';
  const label = location ? `${functionName} (${location})` : functionName;
  const rootNames = new Set(['(root)', 'root']);

  return {
    key: rootNames.has(functionName) ? 'root' : `${functionName}\0${url}\0${line ?? ''}`,
    label,
    detail: location,
  };
}

function createFrame(key, label, detail, unit) {
  return {
    key,
    label,
    detail,
    unit,
    value: 0,
    self: 0,
    sampleCount: 0,
    children: new Map(),
  };
}

function layoutFrames(root, width) {
  const frames = [];

  function visit(node, depth, x, frameWidth) {
    frames.push({ node, depth, x, width: frameWidth });
    const children = [...node.children.values()].sort((a, b) => b.value - a.value);
    let childX = x;
    for (const child of children) {
      const childWidth = node.value === 0 ? 0 : frameWidth * (child.value / node.value);
      visit(child, depth + 1, childX, childWidth);
      childX += childWidth;
    }
  }

  visit(root, 0, 0, width);
  return frames;
}

function renderFlamegraphSvg(frames, root, maxDepth, width, height) {
  const content = frames
    .filter((frame) => frame.width >= MIN_RENDER_WIDTH)
    .map((frame) => {
      const y = 14 + (maxDepth - frame.depth) * FRAME_HEIGHT;
      const boxHeight = FRAME_HEIGHT - FRAME_GAP;
      const label = labelForWidth(frame.node.label, frame.width);
      const percent = root.value === 0 ? 0 : (frame.node.value / root.value) * 100;
      return `<g class="frame">
        <title>${escapeHtml(`${frame.node.label} - ${formatValue(frame.node.value, root.unit)} (${percent.toFixed(2)}%)`)}</title>
        <rect x="${frame.x.toFixed(3)}" y="${y}" width="${Math.max(0, frame.width - FRAME_GAP).toFixed(3)}" height="${boxHeight}" fill="${frameColor(frame.node.key)}"></rect>
        ${label ? `<text x="${(frame.x + 4).toFixed(3)}" y="${y + 14}">${escapeHtml(label)}</text>` : ''}
      </g>`;
    })
    .join('\n');

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="CPU flame graph">
    ${content}
  </svg>`;
}

function collectSelfTime(root) {
  const frames = [];

  function visit(node) {
    if (node.key !== 'total' && node.self > 0) frames.push(node);
    for (const child of node.children.values()) visit(child);
  }

  visit(root);
  return frames.sort((a, b) => b.self - a.self);
}

function renderTopFramesTable(frames, unit) {
  const rows = frames.map((frame) => `<tr>
    <td>${escapeHtml(frame.label)}</td>
    <td>${escapeHtml(formatValue(frame.self, unit))}</td>
    <td>${escapeHtml(formatValue(frame.value, unit))}</td>
  </tr>`).join('\n');

  return `<table>
    <thead><tr><th>Frame</th><th>Self time</th><th>Total time</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3">No sampled frames found.</td></tr>'}</tbody>
  </table>`;
}

function frameColor(key) {
  const hue = hashString(key) % 360;
  return `hsl(${hue}, 72%, 72%)`;
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function labelForWidth(label, width) {
  if (width < 38) return '';
  const maxChars = Math.floor(width / 7);
  if (label.length <= maxChars) return label;
  return `${label.slice(0, Math.max(0, maxChars - 3))}...`;
}

function formatValue(value, unit) {
  if (unit === 'ms') return `${value.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: value < 10 ? 2 : 0 })} ms`;
  return `${Math.round(value).toLocaleString()} samples`;
}

function formatBytes(value) {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)} KiB`;
  return `${value} B`;
}

function shortenUrl(url) {
  return url
    .replace(/^file:\/\//, '')
    .replace(process.cwd(), '.')
    .replace(/\/node_modules\//, '/node_modules/');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
