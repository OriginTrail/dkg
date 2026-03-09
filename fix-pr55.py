#!/usr/bin/env python3
"""Fix PR #55 - publish provenance chain."""
import subprocess, sys, os

os.chdir('/Users/aleatoric/dev/dkg-v9')

def run(cmd, check=True):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if check and r.returncode != 0:
        print(f"FAILED: {cmd}\n{r.stdout}\n{r.stderr}")
        sys.exit(1)
    return r

# Checkout
run("git checkout -f feat/v2-publish-provenance-chain")
print("On branch:", run("git branch --show-current").stdout.strip())

# Fix rdf.ts
with open('packages/origin-trail-game/src/dkg/rdf.ts', 'r') as f:
    content = f.read()
content = content.replace(
    'const s = provenance.rootEntity;',
    'const s = `${provenance.rootEntity}/provenance`;'
)
with open('packages/origin-trail-game/src/dkg/rdf.ts', 'w') as f:
    f.write(content)
print("Fixed rdf.ts")

# Fix coordinator.ts
with open('packages/origin-trail-game/src/dkg/coordinator.ts', 'r') as f:
    content = f.read()
content = content.replace(
    'await this.agent.publish(this.paranetId, rdf.publishProvenanceChainQuads(this.paranetId, provenance));',
    'await this.agent.writeToWorkspace(this.paranetId, rdf.publishProvenanceChainQuads(this.paranetId, provenance));'
)
content = content.replace(
    'Provenance chain published for ${rootEntity}',
    'Provenance chain written to workspace for ${rootEntity}'
)
with open('packages/origin-trail-game/src/dkg/coordinator.ts', 'w') as f:
    f.write(content)
print("Fixed coordinator.ts")

# Fix handler.test.ts
with open('packages/origin-trail-game/test/handler.test.ts', 'r') as f:
    content = f.read()

# Test 1
content = content.replace(
    "const provenanceChainPublish = publishCalls.find((quads: any[]) =>",
    "const provenanceChainPublish = leaderAgent._workspaceWrites.find((quads: any[]) =>"
)

# Test 2
content = content.replace(
    "const provenancePublish = publishCalls.find((quads: any[]) =>",
    "const provenancePublish = leaderAgent._workspaceWrites.find((quads: any[]) =>"
)

# Log assertions
content = content.replace(
    "l.includes('Provenance chain published')",
    "l.includes('Provenance chain written to workspace')"
)

with open('packages/origin-trail-game/test/handler.test.ts', 'w') as f:
    f.write(content)
print("Fixed handler.test.ts")

# Verify
print("\nVerifying changes:")
r = run("git diff --stat")
print(r.stdout)

# Run tests
print("\nRunning tests...")
r = run("pnpm --filter dkg-app-origin-trail-game test", check=False)
print(r.stdout[-2000:] if len(r.stdout) > 2000 else r.stdout)
if r.returncode != 0:
    print("STDERR:", r.stderr[-1000:])
    sys.exit(1)
print("Tests passed!")

# Commit and push
run("git add -A")
run('git commit -m "fix: use distinct provenance entity and writeToWorkspace for provenance chain\n\nAvoids Rule 4 entity exclusivity violation by using a /provenance\nsuffix on the subject URI and switching from agent.publish() to\nagent.writeToWorkspace() for provenance metadata."')
r = run("git push origin feat/v2-publish-provenance-chain")
print("Pushed!", r.stdout, r.stderr)
