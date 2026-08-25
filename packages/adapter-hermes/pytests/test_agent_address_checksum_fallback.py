"""GH#1086 — the finalize author-address normaliser lowercased in silence.

``_normalize_wm_agent_address`` caught every exception from
``to_checksum_address`` and returned the input verbatim. eth-utils ships no
keccak backend by default and the Hermes setup pip-installs nothing, so this
path is reached routinely rather than exceptionally — meaning a NON-checksummed
address was written as the on-chain author, a different string from the
checksummed form every other surface emits, splitting attribution with nothing
in the log to explain it.

The fallback must stay fail-open (a lowercase address is still a usable
identifier; refusing the write would be the worse regression) but must warn,
and must warn once rather than on every write.
"""

from __future__ import annotations

import builtins

import pytest

CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
LOWER = CHECKSUMMED.lower()


@pytest.fixture
def no_keccak(monkeypatch):
    """Force the eth_utils import to fail, as it does on a stock Hermes install."""
    real_import = builtins.__import__

    def boom(name, *args, **kwargs):
        if name == "eth_utils":
            raise ImportError("no keccak backend")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", boom)


def test_strips_the_did_prefix(plugin_module):
    out = plugin_module._normalize_wm_agent_address("did:dkg:agent:" + LOWER)
    assert not out.startswith("did:dkg:agent:")
    assert out.lower() == LOWER


def test_checksums_when_a_backend_is_available(plugin_module):
    try:
        from eth_utils import to_checksum_address

        to_checksum_address(LOWER)
    except Exception:
        pytest.skip("no keccak backend in this environment")
    assert plugin_module._normalize_wm_agent_address(LOWER) == CHECKSUMMED


def test_fallback_is_fail_open_but_not_silent(plugin_module, no_keccak, caplog):
    plugin_module._CHECKSUM_FALLBACK_WARNED = False

    with caplog.at_level("WARNING"):
        out = plugin_module._normalize_wm_agent_address(LOWER)

    # Fail open: the write still proceeds with a usable identifier.
    assert out == LOWER
    # But no longer silently, and the message says how to fix it.
    text = caplog.text.lower()
    assert "cannot checksum agent address" in text
    assert "eth-hash" in caplog.text
    assert "attribution" in text


def test_fallback_warns_once_not_per_write(plugin_module, no_keccak, caplog):
    plugin_module._CHECKSUM_FALLBACK_WARNED = False

    with caplog.at_level("WARNING"):
        for _ in range(25):
            plugin_module._normalize_wm_agent_address(LOWER)

    warnings = [r for r in caplog.records if "checksum agent address" in r.getMessage().lower()]
    assert len(warnings) == 1, f"expected exactly one warning, got {len(warnings)}"


def test_non_address_values_pass_through_untouched(plugin_module):
    assert plugin_module._normalize_wm_agent_address("not-an-address") == "not-an-address"
    assert plugin_module._normalize_wm_agent_address("  ") == ""
