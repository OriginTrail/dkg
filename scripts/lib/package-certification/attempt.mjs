import fs from 'node:fs';
import path from 'node:path';
import { fileIdentity, readJson } from './bundle.mjs';

// Keep a receipt even when the controller is interrupted or cleanup fails.
// SIGKILL/host loss cannot run cleanup; the initial INCOMPLETE receipt survives.
export async function recordAttempt({ output, receipt, work, cleanup, verify }) {
  const receiptFile = path.join(output, 'receipt.json');
  const save = () => {
    fs.writeFileSync(`${receiptFile}.tmp`, `${JSON.stringify(receipt, null, 2)}\n`);
    fs.renameSync(`${receiptFile}.tmp`, receiptFile);
  };
  const controller = new AbortController();
  const recordError = (phase, error) => receipt.errors.push({ phase, message: error.message });
  const safely = async (phase, operation) => {
    try { await operation(); } catch (error) { recordError(phase, error); }
  };
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => {
    if (controller.signal.aborted) return;
    const error = new Error(`Certification cancelled by ${signal}`);
    recordError('cancellation', error);
    controller.abort(error);
  }]));
  save();
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    await safely('controller', () => work(controller.signal));
    // Cleanup deliberately does not use the cancelled execution signal. Each
    // resource gets its own attempt even when another resource cannot be removed.
    await safely('cleanup', () => cleanup(safely));
    receipt.endedAt = new Date().toISOString();
    let productFailed = false;
    for (const layout of receipt.layouts) {
      await safely('report', () => {
        const report = readJson(path.join(output, layout.report));
        productFailed ||= report.cases.some(result => result.outcome === 'FAIL');
      });
    }
    receipt.evidence = [];
    for (const name of fs.readdirSync(output).sort()) {
      if (name === 'receipt.json') continue;
      await safely('evidence', () => {
        const file = path.join(output, name);
        if (fs.statSync(file).isFile()) receipt.evidence.push({ path: name, sha256: fileIdentity(file).sha256 });
      });
    }
    const outcome = controller.signal.aborted ? 'INCOMPLETE' : productFailed ? 'FAIL' : receipt.errors.length ? 'INCOMPLETE' : 'PASS';
    receipt.outcome = outcome === 'PASS' ? 'INCOMPLETE' : outcome;
    save();
    if (outcome === 'PASS') {
      // Verify a prospective receipt in memory. The durable receipt remains
      // INCOMPLETE even if the process is killed during final verification.
      try { await verify({ ...receipt, outcome: 'PASS' }); receipt.outcome = 'PASS'; }
      catch (error) { receipt.outcome = 'INCOMPLETE'; recordError('verification', error); }
    }
    // A signal arriving during final verification must not leave a PASS behind.
    if (controller.signal.aborted) receipt.outcome = 'INCOMPLETE';
    save();
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
  if (receipt.outcome !== 'PASS') throw new Error(`Package certification ${receipt.outcome}; retained ${receiptFile}`);
  return receipt;
}
