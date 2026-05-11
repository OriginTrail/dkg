import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, sep } from 'node:path';
import { defineConfig, htmlReporter, rawReporter, textReporter } from 'esbench/host';

const resultFile = process.env.ESBENCH_RESULT ?? 'bench/results/latest.json';
const htmlFile = process.env.ESBENCH_HTML_FILE ?? 'bench/results/latest.html';
const diffFile = process.env.ESBENCH_DIFF ?? null;
const profileIndexFile = 'bench/results/profiles/index.html';
const methodAnalysisFile = 'bench/results/profiles/method-analysis.latest.html';
export const publishAsyncGetSuite = 'bench/publish-async-get.bench.ts';
export const publishAsyncGetPages = [
  ['get/read retrieval', 'bench/results/publish-async-get/get-read-retrieval.html'],
  ['synchronous publish with finalization', 'bench/results/publish-async-get/sync-publish-finalization.html'],
  ['asynchronous publish enqueue and finalization', 'bench/results/publish-async-get/async-publish-finalization.html'],
  ['upload payload to local working memory', 'bench/results/publish-async-get/working-memory-upload.html'],
  ['lift local working memory to shared working memory', 'bench/results/publish-async-get/working-to-shared-memory.html'],
];
const reporters = [
  textReporter(),
  rawReporter(resultFile),
];

if (process.env.ESBENCH_HTML === '1') {
  reporters.push(htmlReporter(htmlFile));
}

if (process.env.ESBENCH_PUBLISH_ASYNC_GET_HTML === '1') {
  reporters.push(publishAsyncGetHtmlReporter());
}

export default defineConfig({
  cleanTempDir: true,
  diff: diffFile,
  logLevel: process.env.ESBENCH_LOG_LEVEL ?? 'info',
  tempDir: '.esbench-tmp',
  tags: {
    node: process.version,
  },
  toolchains: [
    {
      include: ['bench/**/*.bench.ts'],
    },
  ],
  reporters,
});

function publishAsyncGetHtmlReporter() {
  const reportersByPage = publishAsyncGetPages.map(([caseName, file]) => ({
    caseName,
    file,
    reporter: htmlReporter(file),
  }));

  return async (result, context) => {
    const renderedFiles = [];
    for (const page of reportersByPage) {
      const pageResult = filterResultByCase(result, page.caseName);
      if (Object.keys(pageResult).length === 0) continue;

      await page.reporter(pageResult, {
        ...context,
        previous: filterResultByCase(context.previous ?? {}, page.caseName),
        info: () => undefined,
      });
      renderedFiles.push(page.file);
    }

    await writeLinkedReportNavigation([htmlFile, ...renderedFiles]);

    if (renderedFiles.length > 0) {
      const pageList = renderedFiles.map((file) => `- ${file}`).join('\n');
      context.info(`Publish/async/get HTML pages:\n${pageList}`);
    }
  };
}

export function filterResultByCase(result, caseName) {
  const records = result[publishAsyncGetSuite] ?? [];
  const filteredRecords = records
    .map((record) => ({
      ...record,
      notes: [],
      baseline: { type: 'Name', value: caseName },
      scenes: record.scenes.map((scene) => (
        scene[caseName] ? { [caseName]: scene[caseName] } : {}
      )),
    }))
    .filter((record) => record.scenes.some((scene) => Object.keys(scene).length > 0));

  return filteredRecords.length > 0 ? { [publishAsyncGetSuite]: filteredRecords } : {};
}

async function writeLinkedReportNavigation(files) {
  const uniqueFiles = [...new Set(files)];
  const targets = [
    ['Combined report', htmlFile],
    ...publishAsyncGetPages,
  ];
  if (await fileExists(profileIndexFile)) {
    targets.push(['CPU profiles', profileIndexFile]);
  }
  if (await fileExists(methodAnalysisFile)) {
    targets.push(['Method analysis', methodAnalysisFile]);
  }

  await Promise.all(uniqueFiles.map(async (file) => {
    try {
      const html = await readFile(file, 'utf8');
      await writeFile(file, addLinkedReportNavigation(html, file, targets));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }));
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export function addLinkedReportNavigation(html, currentFile, targets) {
  const start = '<!-- dkg-benchmark-report-nav:start -->';
  const end = '<!-- dkg-benchmark-report-nav:end -->';
  const withoutExisting = html.replace(new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, 'g'), '');
  const navHtml = buildNavigationHtml(currentFile, targets);
  const block = `${start}
<style>
  body.dkg-benchmark-report-linked {
    padding-top: 48px;
  }
  .dkg-benchmark-report-nav {
    align-items: center;
    background: #111827;
    border-bottom: 1px solid #374151;
    box-shadow: 0 1px 8px rgba(0, 0, 0, .16);
    color: #f9fafb;
    display: flex;
    font: 13px/1.4 Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    gap: 8px;
    left: 0;
    min-height: 48px;
    overflow-x: auto;
    padding: 8px 14px;
    position: fixed;
    right: 0;
    top: 0;
    z-index: 2147483647;
  }
  .dkg-benchmark-report-nav__title {
    color: #d1d5db;
    flex: 0 0 auto;
    font-weight: 700;
    margin-right: 4px;
  }
  .dkg-benchmark-report-nav__link {
    border: 1px solid #4b5563;
    border-radius: 4px;
    color: #f9fafb;
    flex: 0 0 auto;
    padding: 4px 8px;
    text-decoration: none;
    white-space: nowrap;
  }
  .dkg-benchmark-report-nav__link:hover,
  .dkg-benchmark-report-nav__link:focus {
    background: #1f2937;
  }
  .dkg-benchmark-report-nav__link[aria-current="page"] {
    background: #2563eb;
    border-color: #60a5fa;
  }
</style>
<script>
  window.addEventListener("DOMContentLoaded", function () {
    if (document.getElementById("dkg-benchmark-report-nav")) return;
    document.body.classList.add("dkg-benchmark-report-linked");
    document.body.insertAdjacentHTML("afterbegin", ${JSON.stringify(navHtml)});
  });
</script>
${end}
`;

  return withoutExisting.includes('</head>')
    ? withoutExisting.replace('</head>', `${block}</head>`)
    : `${block}${withoutExisting}`;
}

function buildNavigationHtml(currentFile, targets) {
  const links = targets.map(([label, targetFile]) => {
    const active = currentFile === targetFile ? ' aria-current="page"' : '';
    return `<a class="dkg-benchmark-report-nav__link" href="${escapeHtml(relativeHref(currentFile, targetFile))}"${active}>${escapeHtml(label)}</a>`;
  }).join('');

  return `<nav id="dkg-benchmark-report-nav" class="dkg-benchmark-report-nav" aria-label="DKG benchmark reports"><span class="dkg-benchmark-report-nav__title">DKG benchmark reports</span>${links}</nav>`;
}

function relativeHref(fromFile, toFile) {
  return relative(dirname(fromFile), toFile).split(sep).join('/') || toFile.split(sep).pop();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
