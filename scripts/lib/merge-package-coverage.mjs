import fs from 'node:fs';
import path from 'node:path';
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';
import { COVERAGE_SOURCE_ROOTS } from './coverage-scope.mjs';

// Merge hit maps, never average shard percentages: each shard contains zero-hit
// entries for the rest of the package and may exercise overlapping branches.
export function mergePackageCoverage(root, name, receipts) {
  const packageDirectory = path.resolve(root, 'packages', name);
  const coverageMap = libCoverage.createCoverageMap({});
  for (const receipt of receipts.filter((item) => item.package === name)) {
    for (const [relative, value] of Object.entries(receipt.coverage)) {
      const absolute = path.resolve(root, relative);
      if (!COVERAGE_SOURCE_ROOTS.some((folder) => absolute.startsWith(path.join(packageDirectory, folder) + path.sep))) {
        throw new Error(`coverage escaped production source: ${relative}`);
      }
      coverageMap.addFileCoverage({ ...value, path: absolute });
    }
  }
  if (!coverageMap.files().length) throw new Error(`no coverage to merge for ${name}`);
  const dir = path.join(packageDirectory, 'coverage');
  fs.rmSync(dir, { recursive: true, force: true });
  const context = libReport.createContext({ dir, coverageMap });
  for (const format of ['json-summary', 'lcovonly', 'json']) {
    reports.create(format, { projectRoot: packageDirectory }).execute(context);
  }
  return coverageMap;
}
