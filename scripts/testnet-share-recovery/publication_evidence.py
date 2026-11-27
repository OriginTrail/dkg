"""Pure publication intent/admission/job comparison shared by all proof entry points."""
import collections
import json
import sys
from urllib.parse import quote


def validate_publication_cohort(campaign, admissions, jobs, seals):
    expected = campaign['cohorts']['publications']
    errors, bindings = [], []
    check = lambda valid, message: errors.append(message) if not valid else None
    check(len(set(expected)) == len(expected), 'Duplicate intended publication')
    check(set(expected) <= set(campaign['cohorts']['initial']), 'Publication outside prepared cohort')
    labels = collections.Counter(row.get('label') for row in admissions)
    check(labels == collections.Counter('publish:' + name for name in expected), 'Publication admission cohort mismatch')
    by_job = collections.defaultdict(list)
    for job in jobs:
        by_job[job.get('jobId')].append(job)
    admitted_ids = []
    for name in expected:
        rows = [row for row in admissions if row.get('label') == 'publish:' + name]
        if len(rows) != 1:
            continue
        admission = rows[0]
        value = admission.get('value') or {}
        job_id = value.get('jobId')
        check(admission.get('status') == 202, f'{name}: publication not admitted')
        check(admission.get('route') == f'/api/knowledge-assets/{quote(name, safe="")}/vm/publish-async', f'{name}: admission route mismatch')
        if not isinstance(job_id, str) or not job_id:
            errors.append(f'{name}: missing admitted job ID')
            continue
        admitted_ids.append(job_id)
        candidates = by_job[job_id]
        if len(candidates) != 1:
            errors.append(f'{name}: missing or duplicate observed job')
            continue
        job = candidates[0]
        request = (job.get('request') or {}).get('knowledgeAssetVmPublish') or {}
        check((job.get('request') or {}).get('jobType') == 'knowledge-asset-vm-publish', f'{name}: job type mismatch')
        originals = [row for row in seals if row.get('name') == name]
        if len(originals) != 1 or originals[0].get('unchanged') is not True or not originals[0].get('seal'):
            errors.append(f'{name}: missing or invalid original seal')
            continue
        seal = originals[0]['seal']
        identity = dict(name=name, contextGraphId=campaign['contextGraphId'], kaUal=seal['kaUal'],
                        assertionVersion=seal['assertionVersion'], sealMerkleRoot=seal['assertionMerkleRoot'])
        for field, intended in identity.items():
            check(value.get(field) == intended, f'{name}: admitted {field} mismatch')
            check(request.get(field) == intended, f'{name}: job {field} mismatch')
        author = campaign['author'].lower()
        for observed in [value.get('agentAddress'), request.get('agentAddress'), seal.get('authorAddress')]:
            check(isinstance(observed, str) and observed.lower() == author, f'{name}: author mismatch')
        for field in ['shareOperationId', 'intentKey']:
            check(isinstance(value.get(field), str) and bool(value[field]) and value[field] == request.get(field), f'{name}: admission/job {field} mismatch')
        bindings.append(dict(jobId=job_id, agentAddress=author, **identity))
    check(len(admitted_ids) == len(set(admitted_ids)), 'Duplicate admitted publication job ID')
    check(collections.Counter(admitted_ids) == collections.Counter(job.get('jobId') for job in jobs), 'Observed publication job set mismatch')
    return dict(expectedNames=expected, expectedCount=len(expected), admissionCount=len(admissions),
                observedJobCount=len(jobs), bindings=bindings, errors=errors, valid=not errors)


if __name__ == '__main__':
    evidence = json.load(sys.stdin)
    print(json.dumps(validate_publication_cohort(**evidence)))
