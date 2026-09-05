import { SaxesParser } from 'saxes';

/** Require actual executed cases, not merely a nonempty XML file or suite header. */
export function inspectJunitResults(xml) {
  const parser = new SaxesParser();
  const stack = [];
  let current;
  let cases = 0;
  let skipped = 0;
  let failed = 0;
  parser.on('opentag', ({ name, attributes }) => {
    if (!stack.length && !['testsuites', 'testsuite'].includes(name)) throw new Error('expected a JUnit suite root');
    if (name === 'testcase') {
      if (stack.at(-1) !== 'testsuite' || current) throw new Error('testcase must belong to a testsuite');
      current = { skipped: false, failed: false };
    }
    if (['skipped', 'failure', 'error'].includes(name)) {
      if (!current || stack.at(-1) !== 'testcase') throw new Error(`unexpected ${name} outside a testcase`);
      if (name === 'skipped') current.skipped = true;
      else current.failed = true;
    }
    if (name === 'testsuite' || name === 'testsuites') {
      for (const key of ['failures', 'errors']) {
        if (attributes[key] !== undefined && (!/^\d+$/.test(attributes[key]) || Number(attributes[key]) !== 0)) throw new Error(`JUnit suite reports ${key}`);
      }
    }
    stack.push(name);
  });
  parser.on('closetag', ({ name }) => {
    if (name === 'testcase') {
      cases++;
      if (current.skipped) skipped++;
      if (current.failed) failed++;
      current = undefined;
    }
    stack.pop();
  });
  parser.write(xml).close();
  if (failed) throw new Error(`JUnit reports ${failed} failed cases`);
  const executedTests = cases - skipped;
  if (!executedTests) throw new Error('JUnit contains no executed tests');
  return { executedTests, skippedTests: skipped };
}
