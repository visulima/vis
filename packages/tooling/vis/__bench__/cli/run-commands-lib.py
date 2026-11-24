#!/usr/bin/env python3
"""Helpers of run-commands.sh: running a command with an exact environment, masking and comparing output,
the summary table and the budget check. Standard library only. Run as `python3 -I run-commands-lib.py <command>`.

  cases <cases.json>                        one tab-separated line per scenario
  comparators <cases.json> <id>             `name<TAB>shell-quoted argv` per comparator
  covered <cases.json>                      the routing names the scenarios and `notMeasured` account for
  run --cwd D --out PREFIX [--timeout S] [--env K=V]... -- CMD...
                                            runs CMD with exactly that environment; writes PREFIX.out/.err/.code
  compare REF_PREFIX GOT_PREFIX [--sorted]  prints why the two runs differ (nothing when they agree)
  delegated PREFIX                          exit 0 when the run printed the delegation marker
  signature DIR                             a digest of the files below DIR (not .git)
  routepayload CWD ARGS K=V...             the JSON `run-commands-routes.mjs route` takes, for one invocation
  meta CAP_DIR OUT ID SIZE ARGS             writes the per-scenario record of the variants and comparators
  runinfo OUT K=V...                        writes the facts of the whole run (environment line, uncovered routes)
  summary RESULTS_DIR [--markdown FILE]     the table of every scenario of a run
  budgets RESULTS_DIR --check FILE | --write FILE
"""

import hashlib
import json
import os
import re
import shlex
import subprocess
import sys

MARKER = "__VIS_BENCH_DELEGATED__"

# Durations, clock times, ids and timestamps: the parts of an output that differ between two runs of the same command.
MASKS = [
    (re.compile(r"\b\d{2}:\d{2}:\d{2}\b"), "HH:MM:SS"),
    (re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?"), "<timestamp>"),
    (re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b"), "<uuid>"),
    (re.compile(r"\b\d+(?:\.\d+)?\s?(?:ms|µs|us|ns|s)\b"), "<duration>"),
    (re.compile(r"\"(?:durationMs|ageMs|milliseconds|startTime|endTime|createdAt|modifiedAt|timestamp|mtimeMs|lastAccessed)\":\s*[\d.]+"), '"<time>": 0'),
    (re.compile(r"\b(?:run|r)-\d{8,}[\w-]*"), "<run-id>"),
]


def mask(text):
    for pattern, replacement in MASKS:
        text = pattern.sub(replacement, text)
    return text


def read(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except FileNotFoundError:
        return ""


def load_cases(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def command_cases(argv):
    for case in load_cases(argv[0])["cases"]:
        fields = [
            case["id"],
            case["family"],
            "1" if case.get("scales") else "0",
            "1" if case.get("stubs") else "0",
            "1" if case.get("handoff") else "0",
            case.get("mode") or "-",
            case.get("compare") or "exact",
            case["route"],
            shlex.join(case["args"]),
            shlex.join(case["floor"]) if case.get("floor") else "-",
            case.get("label") or "-",
            case.get("comparatorFixture") or "-",
            case.get("compareReason") or "-",
            case.get("expect") or "-",
        ]
        print("\t".join(fields))


def command_comparators(argv):
    for case in load_cases(argv[0])["cases"]:
        if case["id"] == argv[1]:
            for comparator in case.get("comparators", []):
                print(comparator["name"] + "\t" + shlex.join(comparator["argv"]))


def command_covered(argv):
    data = load_cases(argv[0])
    names = {case["route"] for case in data["cases"]} | {entry["route"] for entry in data["notMeasured"]}
    print("\n".join(sorted(names)))


def command_run(argv):
    cwd = out = None
    timeout = 300.0
    env = {}
    index = 0
    while index < len(argv) and argv[index] != "--":
        flag = argv[index]
        value = argv[index + 1]
        if flag == "--cwd":
            cwd = value
        elif flag == "--out":
            out = value
        elif flag == "--timeout":
            timeout = float(value)
        elif flag == "--env":
            key, _, text = value.partition("=")
            env[key] = text
        index += 2
    command = argv[index + 1:]
    try:
        done = subprocess.run(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
        stdout, stderr, code = done.stdout, done.stderr, done.returncode
    except subprocess.TimeoutExpired as error:
        stdout, stderr, code = error.stdout or b"", error.stderr or b"", 124
    except OSError as error:
        stdout, stderr, code = b"", str(error).encode(), 127
    for suffix, data in ((".out", stdout), (".err", stderr)):
        with open(out + suffix, "wb") as handle:
            handle.write(data)
    with open(out + ".code", "w", encoding="utf-8") as handle:
        handle.write(str(code))


def normalised(prefix, suffix, sort):
    text = mask(read(prefix + suffix))
    lines = [line.rstrip() for line in text.splitlines()]
    # Blank lines carry no information.
    lines = [line for line in lines if line.strip()]
    return sorted(lines) if sort else lines


def command_compare(argv):
    sort = "--sorted" in argv
    reference, got = argv[0], argv[1]
    if read(reference + ".code").strip() != read(got + ".code").strip():
        print("exit code %s, Node exits %s" % (read(got + ".code").strip(), read(reference + ".code").strip()))
        return
    for suffix, label in ((".out", "stdout"), (".err", "stderr")):
        left, right = normalised(reference, suffix, sort), normalised(got, suffix, sort)
        if left == right:
            continue
        for number, (one, two) in enumerate(zip(left + [None], right + [None])):
            if one != two:
                print("%s differs at line %d: Node `%s` vs `%s`" % (label, number + 1, (one or "<end>")[:90], (two or "<end>")[:90]))
                return
        print("%s differs" % label)
        return


def command_delegated(argv):
    sys.exit(0 if MARKER in read(argv[0] + ".out") + read(argv[0] + ".err") else 1)


def command_signature(argv):
    digest = hashlib.sha256()
    for directory, names, files in os.walk(argv[0]):
        names[:] = sorted(name for name in names if name != ".git")
        for name in sorted(files):
            path = os.path.join(directory, name)
            try:
                status = os.lstat(path)
            except OSError:
                continue
            digest.update(("%s %d %d\n" % (os.path.relpath(path, argv[0]), status.st_size, status.st_mtime_ns)).encode())
    print(digest.hexdigest())


def command_routepayload(argv):
    environment = dict(item.partition("=")[::2] for item in argv[2:])
    print(json.dumps([{"args": shlex.split(argv[1]), "cwd": argv[0], "env": environment}]))


def tsv(path):
    return [line.rstrip("\n").split("\t") for line in read(path).splitlines() if line.strip()]


def dash(text):
    return "" if text == "-" else text


def command_meta(argv):
    cap, out, case, size, args, title, order = argv[0], argv[1], argv[2], argv[3], argv[4], dash(argv[5]), argv[6]
    variants = {}
    for variant, status, label, node, reason in (row + [""] * (5 - len(row)) for row in tsv(os.path.join(cap, "variants.tsv"))):
        variants[variant] = {"status": status, "label": dash(label), "node": dash(node), "reason": dash(reason)}
    comparators = []
    for name, status, label, reason in (row + [""] * (4 - len(row)) for row in tsv(os.path.join(cap, "comparators.tsv"))):
        comparators.append({"name": name, "status": status, "label": label, "reason": reason})
    notes = [line for line in read(os.path.join(cap, "notes.txt")).splitlines() if line.strip()]
    meta = {"id": case, "size": int(size) if size.isdigit() else None, "display": args + (" (%s)" % title if title else ""), "order": int(order), "variants": variants, "comparators": comparators, "notes": notes}
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(meta, handle, indent=2)


def command_runinfo(argv):
    info = {}
    for item in argv[1:]:
        key, _, value = item.partition("=")
        info[key] = value
    info["uncovered"] = [name for name in info.get("uncovered", "").split(",") if name]
    with open(argv[0], "w", encoding="utf-8") as handle:
        json.dump(info, handle, indent=2)


# ---- summary ----------------------------------------------------------------------------------------------------

VARIANTS = ("binary", "launcher", "node")


def summary_of(path, metric):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    found = {}
    for result in data.get("results", []):
        cell = result.get("summary", {}).get(metric)
        if cell:
            found[result.get("name") or result.get("command")] = cell
    return found


def gather(results):
    rows = []
    for name in sorted(os.listdir(results)):
        if not name.endswith(".meta.json"):
            continue
        with open(os.path.join(results, name), "r", encoding="utf-8") as handle:
            meta = json.load(handle)
        key = name[: -len(".meta.json")]
        timing = {}
        memory = {}
        for suffix in (".json", ".cmp.json"):
            path = os.path.join(results, key + suffix)
            if os.path.exists(path):
                for command, cell in summary_of(path, "time_wall_clock").items():
                    timing[command] = cell
                for command, cell in summary_of(path, "memory_peak_resident").items():
                    memory[command] = cell
        meta["key"] = key
        meta["timing"] = timing
        meta["memory"] = memory
        rows.append(meta)
    return sorted(rows, key=lambda row: (row.get("order", 0), row.get("size") or 0))


def millis(cell):
    return None if not cell else cell["median"] * 1000.0


def format_ms(value):
    if value is None:
        return "–"
    return ("%.1f" % value) if value < 100 else ("%.0f" % value)


def format_mb(cell):
    return "–" if not cell else "%.0f" % (cell["median"] / 1048576.0)


def variant_cells(meta):
    """Per variant: (median ms, memory MB text, note) for the three vis variants, taken from the meta labels."""
    cells = {}
    for variant in VARIANTS:
        info = meta["variants"].get(variant, {})
        label = info.get("label")
        value = millis(meta["timing"].get(label)) if label else None
        note = ""
        if info.get("status") == "skipped":
            note = info.get("reason", "")
        elif info.get("node"):
            note = "Node"
        cells[variant] = (value, format_mb(meta["memory"].get(label)) if label else "–", note, info.get("status"))
    return cells


def ratio(numerator, denominator):
    if numerator is None or denominator is None or denominator == 0:
        return "–"
    return "%.1f×" % (numerator / denominator)


def comparator_text(meta):
    parts = []
    for item in meta.get("comparators", []):
        if item.get("status") == "ok":
            value = millis(meta["timing"].get(item["label"]))
            if value is not None:
                parts.append("%s %s" % (item["name"], format_ms(value)))
    floor = meta["variants"].get("floor", {})
    if floor.get("status") == "ok":
        value = millis(meta["timing"].get(floor["label"]))
        if value is not None:
            parts.append("stub pm (floor) %s" % format_ms(value))
    return "; ".join(parts) if parts else "–"


def build_table(rows):
    header = ["command", "size", "native binary", "launcher", "Node", "Node/binary", "Node/launcher", "peak MB (bin/launch/node)", "comparators (ms)"]
    lines = []
    for meta in rows:
        cells = variant_cells(meta)
        binary, launcher, node = cells["binary"][0], cells["launcher"][0], cells["node"][0]

        handback = "hand-back" in meta["variants"].get("binary", {}).get("label", "")

        def show(variant):
            value, _, note, status = cells[variant]
            if value is None:
                return "skipped" if status == "skipped" else "–"
            return format_ms(value) + (" (Node)" if note == "Node" else "") + (" (hand-back only)" if handback and variant == "binary" else "")

        lines.append(
            [
                "vis " + meta["display"],
                str(meta["size"]) if meta.get("size") else "–",
                show("binary"),
                show("launcher"),
                show("node"),
                "–" if handback else ratio(node, binary),
                ratio(node, launcher),
                "%s / %s / %s" % (cells["binary"][1], cells["launcher"][1], cells["node"][1]),
                comparator_text(meta),
            ]
        )
    return header, lines


def notes_of(rows):
    notes = []
    for meta in rows:
        for variant, info in meta["variants"].items():
            if info.get("status") == "skipped":
                notes.append("- `vis %s` %s: %s: %s" % (meta["display"], "@" + str(meta["size"]) if meta.get("size") else "", variant, info.get("reason")))
            elif info.get("node") and variant == "launcher":
                notes.append("- `vis %s` %s: the launcher runs it in Node (%s)" % (meta["display"], "@" + str(meta["size"]) if meta.get("size") else "", info.get("node")))
        for item in meta.get("comparators", []):
            if item.get("status") != "ok":
                notes.append("- `vis %s`: comparator %s skipped: %s" % (meta["display"], item["name"], item.get("reason")))
        for extra in meta.get("notes", []):
            notes.append("- `vis %s`: %s" % (meta["display"], extra))
    return sorted(set(notes))


def render_text(header, lines):
    widths = [max(len(header[i]), *(len(line[i]) for line in lines)) if lines else len(header[i]) for i in range(len(header))]
    out = ["  ".join(header[i].ljust(widths[i]) for i in range(len(header))), "  ".join("-" * widths[i] for i in range(len(header)))]
    out += ["  ".join(line[i].ljust(widths[i]) for i in range(len(header))) for line in lines]
    return "\n".join(out)


def render_markdown(header, lines):
    out = ["| " + " | ".join(header) + " |", "|" + "|".join(" --- " for _ in header) + "|"]
    out += ["| " + " | ".join(cell.replace("|", "\\|") for cell in line) + " |" for line in lines]
    return "\n".join(out)


def command_summary(argv):
    results = argv[0]
    markdown = argv[argv.index("--markdown") + 1] if "--markdown" in argv else None
    rows = gather(results)
    with open(os.path.join(results, "run.json"), "r", encoding="utf-8") as handle:
        run = json.load(handle)
    header, lines = build_table(rows)
    notes = notes_of(rows)
    print()
    print(render_text(header, lines))
    if notes:
        print("\nNotes:")
        print("\n".join(notes))
    if markdown:
        with open(markdown, "w", encoding="utf-8") as handle:
            handle.write("# vis command benchmark\n\n")
            handle.write("One machine's numbers: median wall time in milliseconds (hyperfine `-N`), %s.\n\n" % run["environment"])
            handle.write(render_markdown(header, lines) + "\n")
            if notes:
                handle.write("\n## Notes\n\n" + "\n".join(notes) + "\n")
            if run.get("uncovered"):
                handle.write("\n## Routed commands without a scenario\n\n" + ", ".join("`%s`" % name for name in run["uncovered"]) + "\n")
        print("\n  [markdown written → %s]" % markdown)


# ---- budgets ----------------------------------------------------------------------------------------------------


def measured(rows):
    """{ "<id>@<size>": { variant: median ms } } for the variants that really ran natively or in Node."""
    found = {}
    for meta in rows:
        key = meta["id"] + ("@%s" % meta["size"] if meta.get("size") else "")
        for variant in VARIANTS:
            info = meta["variants"].get(variant, {})
            if info.get("status") != "ok":
                continue
            value = millis(meta["timing"].get(info["label"]))
            if value is None:
                continue
            found.setdefault(key, {})[variant] = {"ms": value, "node": bool(info.get("node"))}
    return found


def limit_for(cell):
    """The budget of one measurement: the larger of twice the median and the median plus 10 ms, rounded up."""
    return int(-(-max(cell["ms"] * 2, cell["ms"] + 10) // 1))


def merged_budgets(existing, found):
    """The existing limits with this run's merged in. A key or variant this run did not measure (a partial run with
    `--only` or `--sizes`) keeps its limit; where both exist the larger limit stays, so two runs on a noisy machine
    give limits that hold for both."""
    budgets = {key: dict(limits) for key, limits in existing.items()}
    for key, variants in found.items():
        for variant, cell in variants.items():
            # The native variants are budgeted when they answered natively; Node always.
            if variant != "node" and cell["node"]:
                continue
            limits = budgets.setdefault(key, {})
            limits[variant] = max(limit_for(cell), limits.get(variant, 0))
    return {key: budgets[key] for key in sorted(budgets)}


def check_budgets(budgets, found, rows):
    """(failures, warnings, checked). `rows` holds one record per scenario this run attempted: a scenario excluded on
    purpose by `--only` or `--sizes` has none and is only a warning, but a budgeted variant of an attempted scenario
    that was not measured (skipped because it delegated to Node, was not routed natively, or disagreed with Node)
    fails with the reason."""
    attempted = {}
    for meta in rows:
        attempted[meta["id"] + ("@%s" % meta["size"] if meta.get("size") else "")] = meta
    failures, warnings, checked = [], [], 0
    for key, limits in sorted(budgets.items()):
        if key not in attempted:
            warnings.append("%s: not attempted in this run (excluded by --only or --sizes)" % key)
            continue
        got = found.get(key, {})
        for variant, limit in limits.items():
            cell = got.get(variant)
            if cell is None:
                info = attempted[key]["variants"].get(variant, {})
                reason = info.get("reason") if info.get("status") == "skipped" else "no timing was recorded"
                failures.append("%s %s: budgeted but not measured: %s" % (key, variant, reason or "no reason recorded"))
            elif cell["node"] and variant != "node":
                failures.append("%s %s: answered by Node (%.1f ms), the budget expects the native path" % (key, variant, cell["ms"]))
            else:
                checked += 1
                if cell["ms"] > limit:
                    failures.append("%s %s: %.1f ms over the %d ms budget" % (key, variant, cell["ms"], limit))
    return failures, warnings, checked


def command_budgets(argv):
    results = argv[0]
    rows = gather(results)
    found = measured(rows)
    if "--write" in argv:
        path = argv[argv.index("--write") + 1]
        with open(os.path.join(results, "run.json"), "r", encoding="utf-8") as handle:
            run = json.load(handle)
        try:
            with open(path, "r", encoding="utf-8") as handle:
                existing = json.load(handle).get("budgets", {})
        except (OSError, ValueError):
            existing = {}
        budgets = merged_budgets(existing, found)
        document = {
            "$comment": "Maximum median wall time in milliseconds per command and variant: the larger of twice the median and the median plus 10 ms, from the runs on the machine named in `machine` (a new run is merged into an existing file: entries it did not measure stay, and where both exist the larger limit is kept). Machine-relative: re-derive them with `run-commands.sh --write-budgets` on another machine. Not checked in CI (timings on shared runners are too noisy); run `run-commands.sh --check-budgets` locally.",
            "machine": run["environment"],
            "headroom": 2,
            "budgets": budgets,
        }
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(document, handle, indent=4)
            handle.write("\n")
        print("budgets written → %s (%d entries)" % (path, len(budgets)))
        return
    path = argv[argv.index("--check") + 1]
    with open(path, "r", encoding="utf-8") as handle:
        budgets = json.load(handle)["budgets"]
    failures, warnings, checked = check_budgets(budgets, found, rows)
    print("\nBudget check: %d measurement(s) compared with %s" % (checked, path))
    for warning in warnings:
        print("  warning: " + warning)
    for failure in failures:
        print("  FAIL: " + failure)
    if failures:
        sys.exit(1)
    print("  all within budget")


COMMANDS = {
    "cases": command_cases,
    "comparators": command_comparators,
    "covered": command_covered,
    "run": command_run,
    "compare": command_compare,
    "delegated": command_delegated,
    "signature": command_signature,
    "routepayload": command_routepayload,
    "meta": command_meta,
    "runinfo": command_runinfo,
    "summary": command_summary,
    "budgets": command_budgets,
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        sys.exit(__doc__)
    COMMANDS[sys.argv[1]](sys.argv[2:])
