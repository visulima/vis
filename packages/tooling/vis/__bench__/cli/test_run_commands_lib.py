#!/usr/bin/env python3
"""Tests of the budget logic in run-commands-lib.py. Standard library only.

    python3 -I __bench__/cli/test_run_commands_lib.py
"""

import importlib.util
import os
import sys
import unittest

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("run_commands_lib", os.path.join(HERE, "run-commands-lib.py"))
LIB = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LIB)


def cell(ms, node=False):
    return {"ms": ms, "node": node}


class MergedBudgets(unittest.TestCase):
    def test_a_partial_run_keeps_the_other_entries(self):
        existing = {"list@20": {"binary": 40, "node": 500}, "version": {"binary": 30, "launcher": 80}}
        found = {"version": {"binary": cell(3.0)}}
        merged = LIB.merged_budgets(existing, found)
        self.assertEqual(merged["list@20"], {"binary": 40, "node": 500})
        # The variant this run did not measure stays; the measured one keeps the larger limit (13 < 30).
        self.assertEqual(merged["version"], {"binary": 30, "launcher": 80})

    def test_the_larger_limit_wins_in_both_directions(self):
        merged = LIB.merged_budgets({"a": {"binary": 12}}, {"a": {"binary": cell(20.0)}})
        self.assertEqual(merged["a"]["binary"], 40)
        merged = LIB.merged_budgets({"a": {"binary": 100}}, {"a": {"binary": cell(20.0)}})
        self.assertEqual(merged["a"]["binary"], 100)

    def test_a_new_scenario_is_added_and_a_node_answer_of_a_native_variant_is_not_budgeted(self):
        found = {"new": {"binary": cell(4.0), "launcher": cell(30.0, node=True), "node": cell(120.0, node=True)}}
        merged = LIB.merged_budgets({}, found)
        self.assertEqual(merged["new"], {"binary": 14, "node": 240})


def meta(case, size, **variants):
    """A per-scenario record as `meta` writes it: variant -> (status, reason)."""
    return {
        "id": case,
        "size": size,
        "variants": {name: {"status": status, "reason": reason, "node": ""} for name, (status, reason) in variants.items()},
    }


BUDGETS = {"list@20": {"binary": 40, "launcher": 100, "node": 500}, "version": {"binary": 30}}


class CheckBudgets(unittest.TestCase):
    def test_a_budgeted_variant_that_was_skipped_fails_with_its_reason(self):
        # The routing stopped sending `list` to the binary: every variant of the attempted scenario was skipped.
        reason = "not routed to the native binary on this base"
        rows = [
            meta("list", 20, binary=("skipped", reason), launcher=("skipped", reason), node=("skipped", "not run")),
            meta("version", None, binary=("ok", "")),
        ]
        found = {"version": {"binary": cell(3.0)}}
        failures, _, checked = LIB.check_budgets(BUDGETS, found, rows)
        self.assertEqual(checked, 1)
        self.assertEqual(len(failures), 3)
        self.assertIn("list@20 launcher: budgeted but not measured: " + reason, failures)
        self.assertIn("list@20 binary: budgeted but not measured: " + reason, failures)

    def test_a_native_variant_that_delegates_to_node_still_fails(self):
        rows = [meta("version", None, binary=("ok", ""))]
        failures, _, _ = LIB.check_budgets({"version": {"binary": 30}}, {"version": {"binary": cell(90.0, node=True)}}, rows)
        self.assertEqual(len(failures), 1)
        self.assertIn("answered by Node", failures[0])

    def test_a_scenario_excluded_by_only_or_sizes_is_not_a_failure(self):
        rows = [meta("version", None, binary=("ok", ""))]
        failures, warnings, checked = LIB.check_budgets(BUDGETS, {"version": {"binary": cell(3.0)}}, rows)
        self.assertEqual(failures, [])
        self.assertEqual(checked, 1)
        self.assertEqual(len(warnings), 1)
        self.assertIn("list@20: not attempted", warnings[0])

    def test_an_attempted_variant_over_its_limit_fails(self):
        rows = [meta("version", None, binary=("ok", ""))]
        failures, _, _ = LIB.check_budgets({"version": {"binary": 30}}, {"version": {"binary": cell(31.0)}}, rows)
        self.assertEqual(len(failures), 1)
        self.assertIn("over the 30 ms budget", failures[0])

    def test_a_clean_run_passes(self):
        rows = [meta("list", 20, binary=("ok", ""), launcher=("ok", ""), node=("ok", "")), meta("version", None, binary=("ok", ""))]
        found = {"list@20": {"binary": cell(8.0), "launcher": cell(40.0), "node": cell(200.0)}, "version": {"binary": cell(3.0)}}
        failures, warnings, checked = LIB.check_budgets(BUDGETS, found, rows)
        self.assertEqual((failures, warnings, checked), ([], [], 4))


if __name__ == "__main__":
    unittest.main()
