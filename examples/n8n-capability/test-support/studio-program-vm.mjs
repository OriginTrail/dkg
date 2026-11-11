import { runInNewContext } from 'node:vm';
import ts from 'typescript';

/** Execute the saved Program body; only its effect dispatcher is a counted fixture. */
export function programAdmission(source) {
  const js = ts.transpileModule(source.replace(
    "import { invoke_tool } from '@origintrail-official/dkg-graph-computer/program';", ''), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const calls = [], context = { exports: {}, invoke_tool: (_tool, value) => {
    calls.push(JSON.parse(JSON.stringify(value))); return value;
  } };
  runInNewContext(js, context);
  return { run: context.exports.run, calls };
}
