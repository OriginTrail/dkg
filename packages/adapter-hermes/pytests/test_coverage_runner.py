"""Run the real cross-platform launcher against a tiny nested Python package."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

PACKAGE = Path(__file__).resolve().parent.parent


@pytest.mark.parametrize("gap", [None, "cli", "overall"])
def test_launcher_discovers_nested_modules_and_enforces_both_gates(tmp_path, gap):
    (tmp_path / "pytests").mkdir()
    nested = tmp_path / "hermes-plugin" / "nested"
    nested.mkdir(parents=True)
    (nested / "__init__.py").write_text("")
    shutil.copy(PACKAGE / ".coveragerc", tmp_path / ".coveragerc")
    shutil.copy(PACKAGE / "pytests" / "run-pytest.mjs", tmp_path / "pytests" / "run-pytest.mjs")
    (tmp_path / "pytest.ini").write_text("[pytest]\ntestpaths = pytests\n")
    cli = "def value():\n    return 1\n"
    if gap == "cli":
        cli += "def unused():\n    return 0\n"
    (tmp_path / "hermes-plugin" / "cli.py").write_text(cli)
    helper = "def value():\n    return 2\n"
    if gap == "overall":
        # A never-imported nested module must still enter the denominator.
        (nested / "unimported.py").write_text("\n".join(f"constant_{i} = {i}" for i in range(40)))
    (nested / "helper.py").write_text(helper)
    (tmp_path / "pytests" / "test_sample.py").write_text(
        "from pathlib import Path\nimport runpy\n"
        "def test_values():\n"
        "    for source in ['cli.py', 'nested/helper.py']:\n"
        "        assert runpy.run_path(str(Path('hermes-plugin') / source))['value']() > 0\n"
    )
    env = {key: value for key, value in os.environ.items() if not key.startswith(("COV_CORE_", "COVERAGE_"))}
    env.update(DKG_CI_COVERAGE="1", DKG_REQUIRE_PYTEST="1")
    result = subprocess.run(
        ["node", "pytests/run-pytest.mjs"], cwd=tmp_path, env=env,
        capture_output=True, text=True, timeout=60,
    )
    assert (result.returncode == 0) == (gap is None), result.stdout + result.stderr
    report = json.loads((tmp_path / "coverage-python" / "coverage.json").read_text())
    # coverage.py normalizes platform paths; assert the contract on every OS.
    files = {name.replace("\\", "/"): data for name, data in report["files"].items()}
    assert "hermes-plugin/nested/helper.py" in files
    assert (tmp_path / "coverage-python" / "coverage.xml").is_file()
    assert (tmp_path / "test-results" / "hermes-python.xml").is_file()
    if gap == "cli":
        assert report["totals"]["percent_covered"] >= 34
        assert files["hermes-plugin/cli.py"]["summary"]["percent_covered"] < 97
    elif gap == "overall":
        assert files["hermes-plugin/nested/unimported.py"]["summary"]["covered_lines"] == 0
        assert report["totals"]["percent_covered"] < 34
