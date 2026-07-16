"""#1116 — golden parity test for the share-outcome warning strings.

The three warnings (SHARE_NOT_PUBLISH_READY_WARNING /
SHARE_SUBSET_NOT_PUBLISH_READY_WARNING / SHARE_INCOMPLETE_PROMOTE_WARNING) are
duplicated byte-identical across the MCP, OpenClaw, and Hermes adapters. There is
no shared runtime module (Hermes is Python and cannot import the TS adapters; the
TS adapters have no shared home either — see the source comments). Instead, every
adapter asserts its constants equal the SAME canonical fixture, so drift is caught
by a test, not a comment. This is the Python side of that golden check.
"""

from __future__ import annotations

import json
from pathlib import Path

# pytests/ -> packages/adapter-hermes/ -> packages/ -> <repo root>
_FIXTURE = (
    Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "share-seal-warnings.json"
)


def _load_fixture() -> dict:
    return json.loads(_FIXTURE.read_text(encoding="utf-8"))


def test_fixture_exists():
    assert _FIXTURE.is_file(), _FIXTURE


def test_share_warning_constants_match_canonical_fixture(plugin_module):
    fixture = _load_fixture()
    assert (
        plugin_module.SHARE_NOT_PUBLISH_READY_WARNING
        == fixture["SHARE_NOT_PUBLISH_READY_WARNING"]
    )
    assert (
        plugin_module.SHARE_SUBSET_NOT_PUBLISH_READY_WARNING
        == fixture["SHARE_SUBSET_NOT_PUBLISH_READY_WARNING"]
    )
    assert (
        plugin_module.SHARE_INCOMPLETE_PROMOTE_WARNING
        == fixture["SHARE_INCOMPLETE_PROMOTE_WARNING"]
    )
