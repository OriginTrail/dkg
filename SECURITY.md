# Security Policy

## Reporting a Vulnerability

The OriginTrail team takes security seriously. If you discover a security
vulnerability in DKG V10, we appreciate your help in disclosing it
responsibly.

**Please do NOT open a public GitHub issue for security vulnerabilities.**

Two reporting channels are accepted, in this preference order:

1. **GitHub Private Vulnerability Reporting** —
   <https://github.com/OriginTrail/dkg/security/advisories/new>. Routes
   directly to the maintainers, keeps the discussion private until a fix
   ships, and creates a draft advisory we can publish atomically with the
   patch.
2. **Email** to **security@origin-trail.com** if GitHub PVR is
   unavailable.

Please include:

- A description of the vulnerability.
- Steps to reproduce the issue.
- Any potential impact you've identified.
- Suggested fix, if you have one.

## Response Timeline

- **Acknowledgment**: We will acknowledge your report within 48 hours.
- **Assessment**: We aim to assess the severity within 5 business days.
- **Fix**: Critical vulnerabilities will be patched as quickly as
  possible, with a public advisory once the fix is deployed.

## Scope

This policy applies to the code in this repository and the DKG V10
protocol implementation. For smart contract vulnerabilities in
`@origintrail-official/dkg-evm-module`, the same process applies.

## Supported Versions

| Version | Supported |
|---|---|
| 10.x (latest) | Yes |
| < 10.0 | No |

## Supply-chain security

Operational details about how the repo and CI defend against supply-chain
attacks (TeamPCP-class compromises, tag-poisoning, credential-stealer
injection, etc.) live in
[`docs/security/SUPPLY_CHAIN_HARDENING.md`](docs/security/SUPPLY_CHAIN_HARDENING.md).
That doc is the audit trail: it lists every control enforced by code in
this repo and every admin-side control a maintainer must apply via the
GitHub UI.

## Recognition

We are grateful to security researchers who help keep the DKG ecosystem
safe. With your permission, we will credit you in the release notes for
any vulnerability you report.
