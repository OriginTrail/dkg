import { SaxesParser } from 'saxes';

/** Require actual executed cases, not merely a nonempty XML file or suite header. */
export function inspectJunitResults(xml) {
  const parser = new SaxesParser();
  const stack = [];
  let rootDeclared;
  let suite;
  let current;
  let cases = 0;
  let skipped = 0;
  let failures = 0;
  let errors = 0;
  const declaredCounts = (attributes) => Object.fromEntries(
    ['tests', 'skipped', 'failures', 'errors'].flatMap((key) => {
      if (attributes[key] === undefined) return [];
      const value = String(attributes[key]);
      if (!/^\d+$/.test(value)) throw new Error(`JUnit suite has invalid ${key}`);
      return [[key, Number(value)]];
    }),
  );
  const validateCounts = (declared, actual) => {
    for (const [key, value] of Object.entries(declared ?? {})) {
      if (value !== actual[key]) throw new Error(`JUnit suite ${key} total is inconsistent`);
    }
  };
  parser.on('opentag', ({ name, attributes }) => {
    if (!stack.length && !['testsuites', 'testsuite'].includes(name)) throw new Error('expected a JUnit suite root');
    if (name === 'testsuites') {
      if (stack.length) throw new Error('nested testsuites are unsupported');
      rootDeclared = declaredCounts(attributes);
    }
    if (name === 'testsuite') {
      if (suite) throw new Error('nested testsuite is unsupported');
      suite = { declared: declaredCounts(attributes), tests: 0, skipped: 0, failures: 0, errors: 0 };
    }
    if (name === 'testcase') {
      if (stack.at(-1) !== 'testsuite' || current || !suite) throw new Error('testcase must belong to a testsuite');
      current = { skipped: false, failures: 0, errors: 0 };
    }
    if (['skipped', 'failure', 'error'].includes(name)) {
      if (!current || stack.at(-1) !== 'testcase') throw new Error(`unexpected ${name} outside a testcase`);
      if (name === 'skipped') current.skipped = true;
      else current[name === 'failure' ? 'failures' : 'errors']++;
    }
    stack.push(name);
  });
  parser.on('closetag', ({ name }) => {
    if (name === 'testcase') {
      cases++;
      if (current.skipped) skipped++;
      failures += current.failures;
      errors += current.errors;
      suite.tests++;
      if (current.skipped) suite.skipped++;
      suite.failures += current.failures;
      suite.errors += current.errors;
      current = undefined;
    }
    if (name === 'testsuite') {
      validateCounts(suite.declared, suite);
      suite = undefined;
    }
    if (name === 'testsuites') validateCounts(rootDeclared, { tests: cases, skipped, failures, errors });
    stack.pop();
  });
  parser.write(xml).close();
  if (failures || errors) throw new Error(`JUnit reports ${failures + errors} failed cases`);
  const executedTests = cases - skipped;
  if (!executedTests) throw new Error('JUnit contains no executed tests');
  return { executedTests, skippedTests: skipped };
}
