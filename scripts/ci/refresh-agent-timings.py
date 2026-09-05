#!/usr/bin/env python3
"""Refresh reviewed agent shard timings from one successful run's JUnit artifacts.

Download with gh run download RUN --pattern 'vitest-agent-*' --dir REPORTS,
then pass REPORTS, --run-id RUN and --commit SHA. No network access is needed.
"""
import argparse
import json
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile


def reports(directory):
    for path in sorted(directory.rglob('*')):
        if path.suffix == '.xml':
            yield str(path), path.read_bytes()
        elif path.suffix == '.zip':
            with zipfile.ZipFile(path) as archive:
                for name in sorted(archive.namelist()):
                    if name.endswith('.xml'):
                        yield f'{path}:{name}', archive.read(name)


def collect_timings(directory):
    durations = {}
    seen = set()
    count = 0
    for source, data in reports(directory):
        root = ET.fromstring(data)
        if root.tag != 'testsuites':
            raise ValueError(f'{source}: expected a Vitest testsuites report')
        count += 1
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
    if count != 10 or not durations:
        raise ValueError(f'expected all ten agent reports from one run, found {count}')
    return dict(sorted(durations.items()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reports', type=Path)
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
        'bodyWeightsMs': collect_timings(args.reports),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, indent=2) + '\n')
    print(f'Wrote {len(data["bodyWeightsMs"])} measured files; skipped-only or new files retain conservative fallback weights.')


if __name__ == '__main__':
    main()
