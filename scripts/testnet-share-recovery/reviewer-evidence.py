"""Export allowlisted public evidence; never copy homes, tokens, claims or raw logs."""
import csv
import datetime
import json
import pathlib
import sys

arm, label = sys.argv[1:3]
root = pathlib.Path('.tmp/2963/evidence') / arm
out = pathlib.Path('run-reports/2963-evidence') / arm
out.mkdir(parents=True, exist_ok=True)
read = lambda name: json.loads((root / name).read_text())
def write(name, value):
    text = '[\n' + ',\n'.join(json.dumps(row, separators=(',', ':')) for row in value) + '\n]' if isinstance(value, list) else json.dumps(value, indent=2)
    (out / name).write_text(text + '\n')
verification = read('verification.json')
seals = {row['name']: row for row in read('seal-proof.json')}
rows = [row for catalog in read(f'{label}/catalogs.json') for row in catalog['rows']]
inventory = read(f'{label}/inventory.json')['swm']
identities = read('identity-proof.json')
identity_errors = identities['identityErrors']
write('identity-proof.json', identities)
write('summary.json', {key: value for key, value in verification.items() if key != 'assets'} | {
    'exactCatalogIdentityErrors': identity_errors,
    'snapshot': read(f'{label}/manifest.json'),
})
write('environment.json', read('environment.json'))
write('protocol.json', read('protocol.json'))
write('starting-set-proof.json', read('starting-set-proof.json'))
write('descriptor-audit.json', [{key: row.get(key) for key in ['name', 'startedAt', 'status', 'error']} for row in read('descriptor-proof.json')])
if (root / 'post-convergence-observations.jsonl').exists():
    write('deadline-observations.json', [json.loads(line) for line in (root / 'post-convergence-observations.jsonl').read_text().splitlines()])
write('traffic-end.json', read('traffic-end.json'))
write('chain-events.json', read('chain-proof.json'))
write('fault-identity-proof.json', read('fault-identity-proof.json'))
write('nonce-accounting.json', read('nonce-proof.json'))
write('assets.json', verification['assets'])
write('seals.json', list(seals.values()))
write('catalog-identities.json', [{key: row[key] for key in ['assertionCoordinate', 'assertionVersion', 'kaId', 'sealDigest']} for row in rows])
requests = read('publication-admissions.json') + read('synchronous-shares.json')
with (out / 'requests.csv').open('w') as handle:
    writer = csv.DictWriter(handle, lineterminator='\n', fieldnames=['label', 'startedAt', 'durationMs', 'status', 'errorCode', 'jobId'])
    writer.writeheader()
    for request in requests:
        writer.writerow({key: request.get(key) for key in ['label', 'startedAt', 'durationMs', 'status']} | {
            'errorCode': request.get('value', {}).get('code'),
            'jobId': request.get('value', {}).get('jobId') or request.get('value', {}).get('recoveryJobId'),
        })
jobs = read(f'{label}/-api-publisher-jobs.json')['value']['jobs']
protocol = read('protocol.json')
parse_time = lambda text: datetime.datetime.fromisoformat(text.replace('Z', '+00:00')).timestamp() * 1000
publication_deadline = parse_time(protocol['startedAt']) + protocol['publicationDeadlineMs']
write('publication-deadline.json', {
    'deadlineEpochMs': publication_deadline, 'denominator': len(read('publication-admissions.json')),
    'finalizedByDeadline': sum(j.get('timestamps', {}).get('finalizedAt', float('inf')) <= publication_deadline for j in jobs),
    'notFinalizedByDeadline': [j['jobId'] for j in jobs if j.get('timestamps', {}).get('finalizedAt', float('inf')) > publication_deadline],
})
write('publication-timing.json', [{'jobId': job['jobId'], 'status': job['status'], 'timestamps': job.get('timestamps'),
                                  'name': job.get('request', {}).get('knowledgeAssetVmPublish', {}).get('name')} for job in jobs])
observations = []
for file in sorted(root.glob('observation-*.json'), key=lambda p: int(p.stem.split('-')[-1])):
    observation = json.loads(file.read_text())
    catalog = observation.get('catalog') or {}
    jobs = observation.get('jobs', {}).get('value', {}).get('jobs', [])
    observations.append({'at': observation['observedAt'], 'finalized': sum(j['status'] == 'finalized' for j in jobs),
                         'catalog': {key: catalog.get(key) for key in ['phase', 'appliedRowCount', 'legacyReadOnlyCount', 'authorityState', 'authorityFreshness']}})
write('observations.json', observations)
probes = []
for line in (root / 'requests.jsonl').read_text().splitlines():
    request = json.loads(line)
    if request.get('label', '').startswith('recovery-observe:'):
        probes.append({key: request.get(key) for key in ['label', 'startedAt', 'durationMs', 'status']})
write('recovery-descriptor-probes.json', probes)
for name in ['catalog-140', 'catalog-141']:
    fault_file = pathlib.Path('.tmp/2963') / f'{arm}-home' / f'2963-fault-{name}.json'
    if fault_file.exists():
        fault = json.loads(fault_file.read_text())
        # Campaign payloads and public RDF only, with the local process ID omitted.
        write(f'fault-{name}.json', {key: value for key, value in fault.items() if key != 'pid'})
print({'arm': arm, 'requests': len(requests), 'assets': len(seals), 'identityErrors': identity_errors})

share_jobs = read(f'{label}/-api-knowledge-assets-swm-share-jobs.json')['value']['jobs']
recovery = []
for name in ['catalog-140', 'catalog-141']:
    fault = json.loads((pathlib.Path('.tmp/2963') / f'{arm}-home' / f'2963-fault-{name}.json').read_text())
    job = next((j for j in share_jobs if j['assertionName'] == name), None)
    success = next((probe for probe in probes if probe['label'] == f'recovery-observe:{name}:0x247B02C301B34E52e9021728F34C3457F81f2dFc' and probe['status'] == 200), None)
    recovery.append({'name': name, 'faultAt': fault['firedAt'], 'job': job,
                     'durableRecoveryMs': parse_time(job['finishedAt']) - parse_time(fault['firedAt']) if job and job['state'] == 'succeeded' else None,
                     'firstDescriptor200': success, 'manualRepairs': 0})
write('recovery-times.json', recovery)
