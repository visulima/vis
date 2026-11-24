#!/usr/bin/env python3
"""Tests of the budget logic in run-commands-lib.py. Standard library only.

    python3 -I __bench__/cli/test_run_commands_lib.py
"""

import importlib.util
import os
import unittest

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


if __name__ == "__main__":
    unittest.main()
