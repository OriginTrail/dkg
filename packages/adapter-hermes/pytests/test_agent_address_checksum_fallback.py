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
    """Reproduce the ACTUAL stock-Hermes failure: the import succeeds, and the
    checksum raises lazily when it reaches for a keccak backend.

    PR #2334 review — an earlier version of this fixture made the whole
    `eth_utils` import fail. That is a different (and rarer) condition, and it
    would have been satisfied by code that only handled a missing package,
    giving false confidence about the documented failure path. eth-utils is
    installed; what it lacks by default is a keccak backend, and
    `to_checksum_address` raises at CALL time.
    """
    eth_utils = pytest.importorskip("eth_utils")

    def raise_backend_unavailable(_value):
        raise Exception(
            "The backend `eth_hash.backends.pycryptodome` is not installed."
        )

    monkeypatch.setattr(eth_utils, "to_checksum_address", raise_backend_unavailable)


@pytest.fixture
def no_eth_utils(monkeypatch):
    """The rarer variant: the package itself is absent. Still must fail open."""
    real_import = builtins.__import__

    def boom(name, *args, **kwargs):
        if name == "eth_utils":
            raise ImportError("No module named 'eth_utils'")
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
    assert "could not canonicalize agent address" in text
    assert "eth-hash" in caplog.text
    # PR #2334 review — the wording must stay CONDITIONAL. This helper also
    # serves working-memory reads, and the input may already be checksummed, so
    # a definitive "attribution will split" claim is often simply false.
    assert "if it is not" in text
    assert "may fail to match" in text


def test_fallback_warns_once_not_per_write(plugin_module, no_keccak, caplog):
    plugin_module._CHECKSUM_FALLBACK_WARNED = False

    with caplog.at_level("WARNING"):
        for _ in range(25):
            plugin_module._normalize_wm_agent_address(LOWER)

    warnings = [r for r in caplog.records if "canonicalize agent address" in r.getMessage().lower()]
    assert len(warnings) == 1, f"expected exactly one warning, got {len(warnings)}"


def test_non_address_values_pass_through_untouched(plugin_module):
    assert plugin_module._normalize_wm_agent_address("not-an-address") == "not-an-address"
    assert plugin_module._normalize_wm_agent_address("  ") == ""


def test_missing_package_also_fails_open_with_a_warning(plugin_module, no_eth_utils, caplog):
    """The import-error path is rarer but must behave identically."""
    plugin_module._CHECKSUM_FALLBACK_WARNED = False

    with caplog.at_level("WARNING"):
        out = plugin_module._normalize_wm_agent_address(LOWER)

    assert out == LOWER
    assert "could not canonicalize agent address" in caplog.text.lower()


def test_already_checksummed_input_passes_through_correctly(plugin_module, no_keccak, caplog):
    """PR #2334 review — the value returned is already correct here, so the
    warning must not assert that it will fail to match anything."""
    plugin_module._CHECKSUM_FALLBACK_WARNED = False

    with caplog.at_level("WARNING"):
        out = plugin_module._normalize_wm_agent_address(CHECKSUMMED)

    # Unchanged and still canonical — no attribution split occurs at all.
    assert out == CHECKSUMMED
    text = caplog.text.lower()
    assert "will not match" not in text
    assert "may fail to match" in text


def test_working_memory_read_path_gets_no_write_specific_claim(plugin_module, no_keccak, caplog):
    """The helper runs on dkg_query(view="working-memory") too (line ~1495),
    which performs no write, so the message must not describe an author write."""
    plugin_module._CHECKSUM_FALLBACK_WARNED = False

    with caplog.at_level("WARNING"):
        plugin_module._normalize_wm_agent_address(LOWER)

    text = caplog.text.lower()
    for write_specific in ("author", "emitting", "on-chain", "split"):
        assert write_specific not in text, f"message names a write-only consequence: {write_specific}"
