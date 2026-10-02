#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "evaluator"))

from reference_evaluator import compare_expected, load_yaml, run_case  # type: ignore


def main() -> None:
    cases_dir = ROOT / "tests" / "cases"
    passed = 0
    failed = 0
    lines = ["# Test Results", ""]
    for case_path in sorted(cases_dir.glob("*.yaml")):
        case = load_yaml(case_path)
        policy_path = ROOT / "policies" / case["policy"]
        result = run_case(policy_path, case_path)
        ok, _detail = compare_expected(result, case["expected"])
        status = "PASS" if ok else "FAIL"
        lines.append(f"- {case_path.name}: **{status}**")
        if ok:
            passed += 1
        else:
            failed += 1
            print(f"{case_path.name}: FAIL")
            print("Result:", result)
            print("Expected:", case["expected"])
    summary = f"Passed: {passed}, Failed: {failed}"
    lines.extend(["", summary, ""])
    print(summary)
    (ROOT / "tests" / "TEST_RESULTS.md").write_text("\n".join(lines), encoding="utf-8")
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
