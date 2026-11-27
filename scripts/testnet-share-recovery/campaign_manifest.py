"""Read the same immutable JSON campaign input used by the JavaScript harness."""
import json
import pathlib


def load_campaign(arm, root='.tmp/2963/evidence'):
    campaign = json.loads((pathlib.Path(root) / arm / 'campaign-manifest.json').read_text())
    if campaign['version'] != 1 or campaign['arm'] != arm:
        raise ValueError('Campaign manifest identity mismatch')
    return campaign


def campaign_counts(campaign):
    cohorts = campaign['cohorts']
    initial, shares = len(cohorts['initial']), len(cohorts['shares'])
    return dict(initial=initial, shares=shares, publications=len(cohorts['publications']),
                main=initial + shares, restart=initial + shares + len(cohorts['restart']),
                injected=len(campaign['faults']), natural=shares - len(campaign['faults']))
