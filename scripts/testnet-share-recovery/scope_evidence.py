"""One offline authority/commitment selector for reducers and public exporters."""
import json
import pathlib
import subprocess


def load_scope_evidence(campaign, snapshot):
    read = lambda name: json.loads((snapshot / name).read_text())
    result = subprocess.check_output(
        ['node', str(pathlib.Path(__file__).with_name('inventory-scope.mjs'))],
        input=json.dumps({'campaign': campaign, 'capture': read('inventory.json'),
                         'catalogs': read('catalogs.json'), 'status': read('-api-status.json')}), text=True)
    return json.loads(result)


def public_scope_evidence(scope):
    return {key: value for key, value in scope.items() if key not in ('rows', 'catalogRows')} | {
        'selectedInventoryRows': len(scope['rows']), 'selectedCatalogRows': len(scope['catalogRows'])}


def require_matching_scope(scope, proof):
    if not scope['valid']:
        raise ValueError('Cannot export uncertified scope: ' + '; '.join(scope['errors']))
    saved = proof.get('inventoryScope', {})
    if not saved.get('valid') or any(saved.get(key) != scope.get(key) for key in
                                  ('scopeDigest', 'authorAddress', 'headDigest', 'catalogScopeDigest', 'catalogHeadDigest')):
        raise ValueError('Saved identity proof does not match the selected inventory/catalog commitments')
