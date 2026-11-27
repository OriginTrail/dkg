"""The SWM soak's final tally, and the tombstone check made before it.

scripts/swm-soak-test.sh runs this module as

  report <logDir> <selfTag> <peersExpected> <contextGraphs> <totalCycles>
      prints the per-CG delivery report and the ship-gate verdict, and exits 0
      on PASS and 1 on FAIL;
  missing-tombstones <logDir> <selfTag> <peersExpected> <contextGraphs>
      prints the peers the report would mark INDETERMINATE because no
      writes-accepted tombstone of theirs was observed, as
      "<tag> in <cgId>, ...", or nothing.

<peersExpected> and <contextGraphs> are comma-separated. Both subcommands read
the log directory through the same `Tally`, so the soak waits for exactly the
tombstones the report looks for.
"""
import json
import os
import re
import sys

SOAK_SUBJECT = re.compile(r'^urn:swm-soak:([^:]+):(\d+)$')


def csv(text):
    return [part.strip() for part in text.split(',') if part.strip()]


def query_rows(record):
    """The result rows of a recorded /api/query answer.

    PR #572 R1: /api/query wraps results as {result: {bindings: [...]}}; a bare
    {bindings: [...]} is read too.
    """
    data = record.get('data') or {}
    if isinstance(data, dict):
        inner = data.get('result')
        if isinstance(inner, dict) and isinstance(inner.get('bindings'), list):
            return inner['bindings']
        if isinstance(data.get('bindings'), list):
            return data['bindings']
    return []


def binding_value(row, name):
    """A binding's value, given as a SPARQL JSON term ({value: ...}) or plainly."""
    value = row.get(name, '')
    if isinstance(value, dict):
        value = value.get('value', '')
    return value


def literal(value):
    """/api/query writes RDF literals in N-Triples form ("tag", "10"); direct
    SPARQL adapters may return the unquoted values."""
    return value.strip('"') if isinstance(value, str) else value


def observed_tombstones(log_dir):
    """denominators[cgId][tag]: the largest count a peer's writes-accepted
    tombstone was observed with.

    PR #572 R12 (round 4): each peer publishes its own accepted-write count
    before the settle window, and that count, not the configured cycle count,
    is the peer's denominator. A sender with local rejections (a crash mid-run,
    a daemon backpressure event that returned no shareOperationId) would
    otherwise be scored against an unreachable target even with 100%
    transport delivery, so the ship gate strictly measures transport.
    """
    denominators = {}
    try:
        with open(os.path.join(log_dir, 'writes-accepted-summaries-observed.jsonl')) as f:
            for line in f:
                # A poll while waiting for a late tombstone may have recorded
                # an answer that is not JSON; the final snapshot validated its
                # own.
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                cg = record.get('cgId')
                if not cg:
                    continue
                bucket = denominators.setdefault(cg, {})
                for row in query_rows(record):
                    tag = literal(binding_value(row, 'tag'))
                    count = literal(binding_value(row, 'writesAccepted'))
                    if not tag:
                        continue
                    try:
                        count = int(count)
                    except (TypeError, ValueError):
                        continue
                    if bucket.get(tag) is None or count > bucket[tag]:
                        bucket[tag] = count
    except FileNotFoundError:
        pass
    return denominators


def final_senders(log_dir, note):
    """senders[cgId][tag]: the seqs of each sender's writes that the final
    inbox snapshots saw.

    PR #572 R2: every final record is merged into its CG, so a CG whose final
    snapshot was taken more than once loses no rows.
    """
    senders = {}
    try:
        with open(os.path.join(log_dir, 'swm-inbox.jsonl')) as f:
            for line in f:
                record = json.loads(line)
                if record.get('label') != 'final':
                    continue
                cg = record['cgId']
                bucket = senders.setdefault(cg, {})
                for row in query_rows(record):
                    match = SOAK_SUBJECT.match(binding_value(row, 's').strip('<>'))
                    if match:
                        bucket.setdefault(match.group(1), set()).add(match.group(2))
    except FileNotFoundError:
        note('  (no swm-inbox.jsonl)')
    return senders


def self_accepted_counts(log_dir):
    """This peer's accepted-write count per CG, and whether it is known.

    PR #572 R13 (round 5): the self denominator is counted per CG, as each
    tombstone is. The count is the one the tombstone and the summary use too,
    from accepted-counts.json (see `record_accepted_counts` in the soak): the
    writes shared at once plus those whose share job succeeded.
    """
    counts = None
    try:
        with open(os.path.join(log_dir, 'accepted-counts.json')) as f:
            counts = json.load(f)
    except (FileNotFoundError, ValueError):
        pass
    return counts, isinstance(counts, dict) and os.path.exists(os.path.join(log_dir, 'writes.jsonl'))


class Tally:
    """What the soak observed, and which peers and denominators the report uses."""

    def __init__(self, log_dir, self_tag, peers_expected, configured_cgs, note=lambda line: None):
        self.self_tag = self_tag
        self.peers_expected = peers_expected
        self.denominators = observed_tombstones(log_dir)
        self.senders = final_senders(log_dir, note)
        self.self_counts, self.self_counted = self_accepted_counts(log_dir)
        # PR #572 R14 (round 5): report on every configured CG, so a CG whose
        # final snapshot saw no rows at all is still reported (INDETERMINATE),
        # plus any CG the inbox shows without it being configured.
        self.cgs = sorted(set(configured_cgs) | set(self.senders.keys()))

    def denominator(self, cg, tag):
        """(source, denominator, known) for a sender's writes in a CG."""
        # Self: the locally counted accepted writes for this CG (ground
        # truth, no transport dependence).
        if tag == self.self_tag:
            if not self.self_counted:
                return ('self', None, False)
            return ('self', self.self_counts.get(cg, 0), True)
        # Peer: the writes-accepted tombstone, if observed.
        count = (self.denominators.get(cg) or {}).get(tag)
        if count is not None:
            return ('peer-tombstone', count, True)
        # No tombstone observed for this peer in this CG: indeterminate.
        return ('missing', None, False)

    def peers(self, cg):
        """(reported, seen): the peers reported on in a CG, PEERS_EXPECTED or
        else every other sender seen, and every other sender seen."""
        seen = sorted(tag for tag in self.senders.get(cg, {}) if tag != self.self_tag)
        return (self.peers_expected if self.peers_expected else seen), seen

    def missing_tombstones(self):
        return [(cg, peer) for cg in self.cgs for peer in self.peers(cg)[0]
                if self.denominator(cg, peer)[0] == 'missing']


def report(tally):
    self_tag = tally.self_tag
    ship_ok = bool(tally.cgs)
    for cg in tally.cgs:
        by_tag = tally.senders.get(cg, {})
        if cg not in tally.senders:
            print(f'  cg={cg}: [no `final` SWM-inbox rows observed for this CG — INDETERMINATE; total transport failure or final SPARQL errored]')
            ship_ok = False
        else:
            print(f'  cg={cg}:')
        src, denom, ok = tally.denominator(cg, self_tag)
        got = len(by_tag.get(self_tag, set()))
        if not ok:
            print(f'    self ({self_tag}): {got} observed (no local writes.jsonl or accepted-counts.json — INDETERMINATE)')
            ship_ok = False
        elif denom == 0:
            print(f'    self ({self_tag}): {got}/0 — no accepted writes recorded locally for this CG (script wrote nothing here)')
            ship_ok = False
        else:
            pct = (got / denom * 100.0) if denom else 0.0
            sanity = '' if got == denom else f'  [WARN: observed {got} self-shares but accepted {denom} locally]'
            print(f'    self ({self_tag}): {got}/{denom} = {pct:.2f}% (denom=local writes.jsonl){sanity}')
            if got != denom:
                ship_ok = False

        reported, seen = tally.peers(cg)
        for peer in reported:
            got = len(by_tag.get(peer, set()))
            src, denom, ok = tally.denominator(cg, peer)
            if not ok:
                print(f'    from {peer}: {got} observed (no writes-accepted tombstone in cg — INDETERMINATE; review writes-accepted-summaries-observed.jsonl)')
                ship_ok = False
                continue
            if denom == 0:
                print(f'    from {peer}: {got}/0 — peer reported zero accepted writes for this CG (peer ran but did not write here)')
                ship_ok = False
                continue
            pct = (got / denom * 100.0) if denom else 0.0
            ship_gate = '' if pct >= 99.9 else '  [BELOW 99.9% — review postmortem]'
            print(f'    from {peer}: {got}/{denom} = {pct:.2f}% (denom=peer tombstone){ship_gate}')
            if pct < 99.9:
                ship_ok = False
        if tally.peers_expected:
            unexpected = [tag for tag in seen if tag not in tally.peers_expected]
            if unexpected:
                print(f'    unexpected senders observed: {unexpected}')
    print(f'  VERDICT: {"PASS" if ship_ok else "FAIL"}')
    return 0 if ship_ok else 1


def main(argv):
    command, args = (argv[1] if len(argv) > 1 else None), argv[2:]
    if command == 'report' and len(args) == 5:
        log_dir, self_tag, peers_expected, cgs, cycles = args
        # The report does not use the cycle count, but an unparsable one has
        # always stopped the tally, and still does.
        int(cycles or '0')
        return report(Tally(log_dir, self_tag, csv(peers_expected), csv(cgs), note=print))
    if command == 'missing-tombstones' and len(args) == 4:
        log_dir, self_tag, peers_expected, cgs = args
        missing = Tally(log_dir, self_tag, csv(peers_expected), csv(cgs)).missing_tombstones()
        if missing:
            print(', '.join(f'{tag} in {cg}' for cg, tag in missing))
        return 0
    print('usage: swm-soak-tally.py report <logDir> <selfTag> <peersExpected> <contextGraphs> <totalCycles>\n'
          '       swm-soak-tally.py missing-tombstones <logDir> <selfTag> <peersExpected> <contextGraphs>',
          file=sys.stderr)
    return 64


if __name__ == '__main__':
    sys.exit(main(sys.argv))
