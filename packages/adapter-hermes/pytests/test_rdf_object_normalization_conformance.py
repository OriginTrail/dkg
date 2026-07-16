"""Conformance test for the Hermes create/write one-shot quad-object normalization.

These golden cases mirror the MCP conformance fixture
(packages/mcp-dkg/test/rdf-object-normalization-conformance.test.ts) and core's
normalizeDkgPublisherObject / escapeDkgRdfLiteral / isDkgRdfTerm
(packages/core/src/publisher-extension.ts). The create one-shot
dkg_knowledge_asset_create({quads}) is documented as byte-parallel across MCP, OpenClaw,
and Hermes — so _normalize_quads must produce the same object terms. Keep in sync with the
MCP golden array; a divergence here means an agent gets different triples per runtime.
"""
import pytest


# (object_input -> expected normalized object).
OBJECT_CASES = [
    # bare literals -> quoted
    ("hello world", '"hello world"'),
    ("42", '"42"'),
    # leading/trailing whitespace on a literal is PRESERVED (no .strip()) — MCP/OpenClaw
    # only bracket-strip, so trimming here would diverge.
    ("  padded  ", '"  padded  "'),
    # non-allowlisted schemes are LITERALS (not URIs) — must stay scoped to https?/urn/did
    ("mailto:a@b.com", '"mailto:a@b.com"'),
    ("ftp://x", '"ftp://x"'),
    # allow-listed URIs pass through, CASE-INSENSITIVE scheme
    ("http://example.org/a", "http://example.org/a"),
    ("HTTP://EXAMPLE.ORG/A", "HTTP://EXAMPLE.ORG/A"),
    ("https://x.io", "https://x.io"),
    ("HTTPS://EXAMPLE.ORG/X", "HTTPS://EXAMPLE.ORG/X"),
    ("urn:isbn:9780262", "urn:isbn:9780262"),
    ("URN:dkg:thing", "URN:dkg:thing"),
    ("did:dkg:agent:0xAbC", "did:dkg:agent:0xAbC"),
    # blank node passthrough
    ("_:b0", "_:b0"),
    # already-quoted / typed / lang-tagged passthrough
    ('"already a literal"', '"already a literal"'),
    ('"42"^^<http://www.w3.org/2001/XMLSchema#integer>', '"42"^^<http://www.w3.org/2001/XMLSchema#integer>'),
    ('"hello"@en', '"hello"@en'),
    # bracketed URI objects -> stripped to a bare URI
    ("<http://x>", "http://x"),
    ("<urn:o>", "urn:o"),
    # ECHAR escapes
    ('a"b', '"a\\"b"'),
    ("a\\b", '"a\\\\b"'),
    ("a\nb", '"a\\nb"'),
    ("a\tb", '"a\\tb"'),
    ("a\rb", '"a\\rb"'),
    ("a\fb", '"a\\fb"'),
    ("a\bb", '"a\\bb"'),
    # remaining ASCII controls -> UCHAR escapes (#416)
    ("nul\u0000x", '"nul\\u0000x"'),
    ("vt\u000bx", '"vt\\u000Bx"'),
    ("us\u001fx", '"us\\u001Fx"'),
    ("del\u007fx", '"del\\u007Fx"'),
]


@pytest.mark.parametrize("object_input,expected", OBJECT_CASES)
def test_create_object_normalization_matches_contract(plugin_module, object_input, expected):
    out = plugin_module._normalize_quads(
        [{"subject": "urn:s", "predicate": "urn:p", "object": object_input}]
    )
    assert out == [{"subject": "urn:s", "predicate": "urn:p", "object": expected}]


def test_create_strips_brackets_on_subject_and_predicate(plugin_module):
    # All three terms get the <…> strip, so a bracketed URI stays a URI on the wire.
    out = plugin_module._normalize_quads(
        [{"subject": "<urn:s>", "predicate": "<urn:p>", "object": "urn:o"}]
    )
    assert out == [{"subject": "urn:s", "predicate": "urn:p", "object": "urn:o"}]
