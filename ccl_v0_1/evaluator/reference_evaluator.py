#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

import yaml


Binding = Dict[str, Any]
RelationStore = Dict[str, set[Tuple[Any, ...]]]


def is_var(value: Any) -> bool:
    return isinstance(value, str) and value.startswith("$")


def normalize_value(value: Any) -> Any:
    return value


def load_yaml(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f)


class Evaluator:
    def __init__(self, policy: dict, facts: Iterable[Iterable[Any]]) -> None:
        self.policy = policy
        self.relations: RelationStore = defaultdict(set)
        for fact in facts:
            fact = list(fact)
            pred = fact[0]
            args = tuple(normalize_value(x) for x in fact[1:])
            self.relations[pred].add(args)

    def run(self) -> dict[str, list[list[Any]]]:
        self._derive_fixpoint()
        decisions = self._evaluate_decisions()
        derived = {
            rule["name"]: sorted([list(t) for t in self.relations.get(rule["name"], set())])
            for rule in self.policy.get("rules", [])
        }
        return {
            "derived": derived,
            "decisions": decisions,
        }

    def _derive_fixpoint(self) -> None:
        rules = self.policy.get("rules", [])
        max_rounds = 64
        for _ in range(max_rounds):
            changed = False
            for rule in rules:
                new_tuples = self._evaluate_rule(rule)
                rel = self.relations[rule["name"]]
                before = len(rel)
                rel.update(new_tuples)
                if len(rel) != before:
                    changed = True
            if not changed:
                return
        raise RuntimeError("fixpoint did not converge")

    def _evaluate_rule(self, rule: dict) -> set[Tuple[Any, ...]]:
        params = [f"${p}" for p in rule.get("params", [])]
        tuples = set()
        for binding in self._evaluate_conditions(rule.get("all", []), [{}]):
            head = tuple(binding[p] for p in params)
            tuples.add(head)
        return tuples

    def _evaluate_decisions(self) -> dict[str, list[list[Any]]]:
        results: dict[str, list[list[Any]]] = {}
        for decision in self.policy.get("decisions", []):
            params = [f"${p}" for p in decision.get("params", [])]
            tuples = []
            seen = set()
            for binding in self._evaluate_conditions(decision.get("all", []), [{}]):
                head = tuple(binding[p] for p in params)
                if head not in seen:
                    seen.add(head)
                    tuples.append(list(head))
            results[decision["name"]] = sorted(tuples)
        return results

    def _evaluate_conditions(self, conditions: List[dict], bindings: List[Binding]) -> List[Binding]:
        current = bindings
        for cond in conditions:
            next_bindings: List[Binding] = []
            for binding in current:
                next_bindings.extend(self._evaluate_condition(cond, binding))
            current = next_bindings
            if not current:
                break
        return current

    def _evaluate_condition(self, cond: dict, binding: Binding) -> List[Binding]:
        if "atom" in cond:
            atom = cond["atom"]
            return self._match_atom(atom["pred"], atom.get("args", []), binding)
        if "exists" in cond:
            spec = cond["exists"]
            matches = self._evaluate_conditions(spec.get("where", []), [dict(binding)])
            return [binding] if matches else []
        if "not_exists" in cond:
            spec = cond["not_exists"]
            matches = self._evaluate_conditions(spec.get("where", []), [dict(binding)])
            return [binding] if not matches else []
        if "count_distinct" in cond:
            spec = cond["count_distinct"]
            matches = self._evaluate_conditions(spec.get("where", []), [dict(binding)])
            vars_ = [f"${v}" if not str(v).startswith("$") else str(v) for v in spec.get("vars", [])]
            projection = {tuple(m[v] for v in vars_) for m in matches}
            if self._compare(len(projection), spec["op"], int(spec["value"])):
                return [binding]
            return []
        raise ValueError(f"Unsupported condition: {cond}")

    def _compare(self, left: int, op: str, right: int) -> bool:
        if op == ">=":
            return left >= right
        if op == ">":
            return left > right
        if op == "==":
            return left == right
        if op == "<=":
            return left <= right
        if op == "<":
            return left < right
        raise ValueError(f"Unsupported comparison operator: {op}")

    def _match_atom(self, pred: str, args: List[Any], binding: Binding) -> List[Binding]:
        out: List[Binding] = []
        tuples = sorted(self.relations.get(pred, set()))
        for tup in tuples:
            if len(tup) != len(args):
                continue
            candidate = dict(binding)
            ok = True
            for term, value in zip(args, tup):
                if is_var(term):
                    if term in candidate:
                        if candidate[term] != value:
                            ok = False
                            break
                    else:
                        candidate[term] = value
                else:
                    if normalize_value(term) != value:
                        ok = False
                        break
            if ok:
                out.append(candidate)
        return out


def run_case(policy_path: Path, case_path: Path) -> dict:
    policy = load_yaml(policy_path)
    case = load_yaml(case_path)
    evaluator = Evaluator(policy, case["facts"])
    result = evaluator.run()
    return result


def compare_expected(result: dict, expected: dict) -> tuple[bool, dict]:
    normalized_result = json.loads(json.dumps(result, sort_keys=True))
    normalized_expected = json.loads(json.dumps(expected, sort_keys=True))
    return normalized_result == normalized_expected, {
        "result": normalized_result,
        "expected": normalized_expected,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the CCL reference evaluator.")
    parser.add_argument("policy", type=Path, help="Path to canonical policy YAML.")
    parser.add_argument("case", type=Path, help="Path to test case YAML.")
    parser.add_argument("--check", action="store_true", help="Compare output to case.expected and set exit code.")
    args = parser.parse_args()

    result = run_case(args.policy, args.case)
    print(json.dumps(result, indent=2, sort_keys=True))

    if args.check:
        case = load_yaml(args.case)
        ok, detail = compare_expected(result, case["expected"])
        if not ok:
            print("\\nEXPECTED MISMATCH")
            print(json.dumps(detail, indent=2, sort_keys=True))
            raise SystemExit(1)


if __name__ == "__main__":
    main()
