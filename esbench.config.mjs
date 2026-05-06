import { defineConfig, htmlReporter, rawReporter, textReporter } from 'esbench/host';

const resultFile = process.env.ESBENCH_RESULT ?? 'bench/results/latest.json';
const htmlFile = process.env.ESBENCH_HTML_FILE ?? 'bench/results/latest.html';
const diffFile = process.env.ESBENCH_DIFF ?? null;
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
