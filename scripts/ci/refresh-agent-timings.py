#!/usr/bin/env python3
"""Refresh reviewed agent shard timings from one successful run's JUnit artifacts.

Download with gh run download RUN --pattern 'vitest-agent-*' --dir REPORTS,
then pass REPORTS, --run-id RUN and --commit SHA. No network access is needed.
"""
import argparse
import json
import math
from pathlib import Path, PurePosixPath
import re
import xml.etree.ElementTree as ET
import zipfile


def reports(directory):
    for path in sorted(directory.rglob('*')):
        if path.suffix == '.xml':
            yield str(path), path.name, path.read_bytes()
        elif path.suffix == '.zip':
            with zipfile.ZipFile(path) as archive:
                for name in sorted(archive.namelist()):
                    if name.endswith('.xml'):
                        yield f'{path}:{name}', PurePosixPath(name).name, archive.read(name)


DEFAULT_POLICY = Path(__file__).with_name('agent-shard-policy.json')


def expected_reports(policy_path):
    policy = json.loads(policy_path.read_text())
    if policy.get('schemaVersion') != 1 or not isinstance(policy.get('lanes'), list):
        raise ValueError('invalid agent shard policy schema')
    names = [shard['report'] for lane in policy['lanes'] for shard in lane['shards']]
    if not names or len(set(names)) != len(names) or any(not re.fullmatch(r'[\w.-]+\.xml', name) for name in names):
        raise ValueError('invalid or duplicate agent report identities')
    return set(names)


def collect_timings(directory, policy_path=DEFAULT_POLICY):
    durations = {}
    seen = set()
    expected = expected_reports(policy_path)
    received = set()
    for source, report_name, data in reports(directory):
        if report_name not in expected:
            raise ValueError(f'unexpected agent report: {report_name}')
        if report_name in received:
            raise ValueError(f'duplicate agent report: {report_name}')
        received.add(report_name)
        root = ET.fromstring(data)
        if root.tag != 'testsuites':
            raise ValueError(f'{source}: expected a Vitest testsuites report')
        for suite in root.findall('testsuite'):
            name = suite.attrib['name']
            if not name.startswith('test/') or not name.endswith('.test.ts') or '..' in name.split('/'):
                raise ValueError(f'{source}: unexpected agent test path {name!r}')
            if name in seen:
                raise ValueError(f'duplicate test suite: {name}')
            seen.add(name)
            if any(int(suite.attrib.get(key, '0')) for key in ('failures', 'errors')):
                raise ValueError(f'{source}: failed suite {name}')
            seconds = float(suite.attrib['time'])
            if not math.isfinite(seconds) or seconds < 0:
                raise ValueError(f'{source}: invalid duration for {name}')
            tests = int(suite.attrib['tests'])
            if tests > 0 and int(suite.attrib.get('skipped', '0')) < tests:
                durations[name] = math.ceil(seconds * 1000)
    if received != expected:
        raise ValueError(f'missing agent reports: {sorted(expected - received)}')
    if not durations:
        raise ValueError('agent reports contain no measured tests')
    return dict(sorted(durations.items()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reports', type=Path)
    parser.add_argument('--policy', type=Path, default=DEFAULT_POLICY, help='Shard policy for the source run')
    parser.add_argument('--run-id', required=True, type=int)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if args.run_id <= 0 or not re.fullmatch(r'[0-9a-f]{40}', args.commit):
        parser.error('expected a positive GitHub run ID and full commit SHA')
    data = {
        'schemaVersion': 1,
        'source': {'runId': args.run_id, 'commit': args.commit,
                   'url': f'https://github.com/OriginTrail/dkg/actions/runs/{args.run_id}'},
        'perFileOverheadMs': 1100,
        'bodyWeightsMs': collect_timings(args.reports, args.policy),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, indent=2) + '\n')
    print(f'Wrote {len(data["bodyWeightsMs"])} measured files; skipped-only or new files retain conservative fallback weights.')


if __name__ == '__main__':
    main()
