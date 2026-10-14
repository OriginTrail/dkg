// Judges what one node logged during a run of
// devnet-test-issue-3198-content-shapes.sh.
//
// Two defects were loud in the logs long before anybody looked at the data:
//   - an author that cannot publish a catalog row logs
//     {"event":"catalog_repair_failed",...} on every retry, with a growing
//     "consecutiveFailures". One such line with a count of 0 or 1 is a retry
//     that then succeeded (a full devnet run has a few); two in a row are not;
//   - a node that reads a row back from its store in another form logs the
//     refusal with NQUADS_BYTE_LIMIT_EXCEEDED or "post-read differs" /
//     "post-read failed". A full devnet run without the defect has none.
// Neither line names its context graph, so they are judged by node and by time:
// the text handed in is what the node wrote since the run started.
//
// "No such line" only means something when the text is the node's log of this
// run. A file that is missing, empty, rotated away or not this node's log has
// no such line either. So the text must mention the run (its stamp is in every
// graph id and subject the run uses, and a node logs the subscriptions and
// queries it serves); a text that does not is `no-evidence`, never `clean`.
//
// CLI: node-log-check.mjs <run stamp> <author|receiver>     (stdin: the log text)
// Prints `<verdict>\t<count>\t<one line of the log>` per finding, or `clean`.
// Exit 0 clean (a `recovered` note may be printed), 1 a defect, 2 no evidence.

import { pathToFileURL } from 'node:url';

const REPAIR_FAILED = '"event":"catalog_repair_failed"';
const REPEATED = /"consecutiveFailures":([2-9]|[1-9][0-9]+)\b/;
const REFUSED = /NQUADS_BYTE_LIMIT_EXCEEDED|post-read (differs|failed)/;

export function judgeNodeLog(text, { stamp, author = false }) {
  if (typeof stamp !== 'string' || stamp === '') throw new Error('a run stamp is required');
  if (typeof text !== 'string' || !text.includes(stamp)) return { verdict: 'no-evidence', findings: [] };
  const lines = text.split('\n');
  const findings = [];
  if (author) {
    const failed = lines.filter(line => line.includes(REPAIR_FAILED));
    const repeated = failed.filter(line => REPEATED.test(line));
    if (repeated.length) findings.push({ kind: 'repair-failed-repeatedly', count: failed.length, sample: repeated[0] });
    else if (failed.length) findings.push({ kind: 'repair-failed-recovered', count: failed.length, sample: failed[0] });
  }
  const refused = lines.filter(line => REFUSED.test(line));
  if (refused.length) findings.push({ kind: 'read-back-refused', count: refused.length, sample: refused[0] });
  const defect = findings.some(finding => finding.kind !== 'repair-failed-recovered');
  return { verdict: defect ? 'defect' : 'clean', findings };
}

function main([stamp, role]) {
  if (!stamp || !['author', 'receiver'].includes(role)) throw new Error('usage: node-log-check.mjs <run stamp> <author|receiver>');
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { text += chunk; });
  process.stdin.on('end', () => {
    const { verdict, findings } = judgeNodeLog(text, { stamp, author: role === 'author' });
    // One line of a log, cut to what a report line can carry, without the prefix every line has.
    const sample = line => line.replace(/^.*\[DKGAgent\] /, '').replace(/[\t\r]/g, ' ').slice(0, 320);
    for (const finding of findings) console.log(`${finding.kind}\t${finding.count}\t${sample(finding.sample)}`);
    if (verdict !== 'defect') console.log(verdict);
    process.exitCode = verdict === 'clean' ? 0 : verdict === 'defect' ? 1 : 2;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
