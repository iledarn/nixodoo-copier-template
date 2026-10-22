#!/usr/bin/env python3
"""Regression corpus for the kb SessionStart hook (kb-session-start.sh).

Renders the hook with jinja2 and runs it with a stub `kb` on a PATH of its own, so the
real kb and its database are never touched. Covers what the hook must do with a current
kb and with an older one that predates --title, schema_stale or anything newer: a child
session of the pipeline (title "[child] ...") gets the pinned rules and a standup count,
a compacted session is told to write its session note first, a stale schema says so, a
missing kb or an unregistered checkout gets one line naming `nix run .#kb-setup`, and no kb
error ever reaches the context.

Run from the repo root: python3 tests/test_kb_session_start.py (needs jinja2, bash,
python3, awk, sed, grep).
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import jinja2

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / (
    "template/{% if use_agent_layer %}.claude{% endif %}/hooks/"
    "{% if use_kb %}kb-session-start.sh{% endif %}.jinja"
)
SCOPE = "acme-odoo-16"
# Claude Code keeps 10,000 characters of a hook's output in context, and past that the
# first 2,000 only: what the model must act on comes first, a child stays under the cap.
CONTEXT_CAP = 10_000
PREVIEW = 2_000

PINNED = [f"- [{i}] feedback_rule_{i} — " + "a pinned rule the code follows " * 5 for i in range(30)]
RECENT = [f"- [{i}] note_{i} — " + "a recent record nobody pinned " * 5 for i in range(100, 220)]
INDEX = "\n".join(
    [f"# kb index 2026-10-22 ({SCOPE}) — generated, do not edit", "", "## Pinned", *PINNED, "", "## Recent", *RECENT]
)
INDEX_NO_PINS = "\n".join([f"# kb index 2026-10-22 ({SCOPE}) — generated", "", "## Recent", *RECENT[:3]])
TASKS = [{"id": i, "level": 3 if i < 4 else 2, "title": f"task {i}"} for i in range(9)]
TODAY_TEXT = f"kb today 2026-10-22 ({SCOPE})\n" + "\n".join(f"[{t['id']}] L{t['level']} {t['title']}" for t in TASKS)
STATUS_OK = {"bolt_reachable": True, "schema_ok": True, "upgrade_pending": False}

COMPACT_LINE = "kb: the context was just compacted"
SCHEMA_LINE = "kb: schema stale or incomplete; run kb-setup"
INSTALL_LINE = "kb: kb is not installed, so this session has no project memory. To set it up: nix run .#kb-setup"
REGISTER_LINE = "kb: this checkout is not registered as the kb scope"
STANDUP_LINE = "kb today: 9 open tasks, 4 loud; a child session leaves the list out (kb today prints it)."

# The stub: answers from the KB_STUB_* environment and logs every call, one JSON argv a line.
STUB = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["KB_STUB_LOG"], "a") as log:
    log.write(json.dumps(args) + "\n")
env = os.environ.get
if args[:2] == ["--json", "status"]:
    print(env("KB_STUB_STATUS", "{}"))
    sys.exit(0 if '"schema_ok": true' in env("KB_STUB_STATUS", "") else 1)
if args[:2] == ["scope", "which"]:
    mode = env("KB_STUB_SCOPE", "ok")
    if mode == "old":
        print("Usage: kb [OPTIONS] COMMAND [ARGS]...\n\nError: No such command 'scope'.", file=sys.stderr)
        sys.exit(2)
    if mode == "none":
        print(f"{args[2]} is in no scope", file=sys.stderr)
        sys.exit(3)
    print("someone-else" if mode == "other" else "acme-odoo-16")
    sys.exit(0)
if args[:2] == ["service", "start"]:
    sys.exit(1 if env("KB_STUB_START_FAILS") else 0)
if args[:2] == ["sync", "odoo"]:
    print("odoo: 9 open tasks, 0 new, 0 updated, 0 closed")
    sys.exit(0)
if args[:2] == ["session", "open"]:
    if any(a.startswith("--title") for a in args) and env("KB_STUB_OLD"):
        print("Usage: kb session open [OPTIONS]\nTry 'kb session open --help' for help.\n\nError: No such option '--title'.", file=sys.stderr)
        sys.exit(2)
    print("[42] 2026-10-22-1")
    sys.exit(0)
if args[:1] == ["index"]:
    sys.stdout.write(open(env("KB_STUB_INDEX")).read() + "\n")
    sys.exit(0)
if args[:1] == ["today"]:
    if "--json" in args:
        print(json.dumps({"date": "2026-10-22", "scope": "x", "tasks": json.loads(env("KB_STUB_TASKS"))}))
    else:
        print(env("KB_STUB_TODAY"))
    sys.exit(0)
print(f"kb: no such command {args!r}", file=sys.stderr)
sys.exit(2)
'''


def render():
    env = jinja2.Environment(trim_blocks=True, lstrip_blocks=True, keep_trailing_newline=True)
    return env.from_string(SRC.read_text()).render(project_name=SCOPE)


class Rig:
    """A temp dir holding the rendered hook, a tools-only bin dir and a stub-kb bin dir."""

    def __init__(self):
        self.dir = Path(tempfile.mkdtemp(prefix="kb-hook-"))
        self.hook = self.dir / "hooks" / "kb-session-start.sh"
        self.hook.parent.mkdir()
        self.hook.write_text(render())
        self.tools = self.dir / "tools"
        self.tools.mkdir()
        for tool in ("bash", "python3", "awk", "sed", "grep", "cat", "dirname", "env"):
            found = shutil.which(tool)
            if found is None:
                sys.exit(f"missing tool: {tool}")
            (self.tools / tool).symlink_to(found)
        self.stub = self.dir / "stub"
        self.stub.mkdir()
        kb = self.stub / "kb"
        kb.write_text(STUB)
        kb.chmod(0o755)
        (self.dir / "index.txt").write_text(INDEX)
        (self.dir / "index-no-pins.txt").write_text(INDEX_NO_PINS)

    def run(self, payload, *, with_kb=True, index="index.txt", status=STATUS_OK, **stub_env):
        log = self.dir / "calls.log"
        log.write_text("")
        env = {
            "PATH": f"{self.stub}:{self.tools}" if with_kb else str(self.tools),
            "HOME": str(self.dir),
            "KB_STUB_LOG": str(log),
            "KB_STUB_INDEX": str(self.dir / index),
            "KB_STUB_STATUS": status if isinstance(status, str) else json.dumps(status),
            "KB_STUB_TODAY": TODAY_TEXT,
            "KB_STUB_TASKS": json.dumps(TASKS),
            **stub_env,
        }
        data = payload if isinstance(payload, str) else json.dumps(payload)
        proc = subprocess.run(
            [str(self.tools / "bash"), str(self.hook)],
            input=data, capture_output=True, text=True, env=env, timeout=60,
        )
        calls = [json.loads(line) for line in log.read_text().splitlines()]
        return proc, calls


def opens(calls):
    return [c for c in calls if c[:2] == ["session", "open"]]


def payload(source="startup", title=None):
    d = {"session_id": "sess-1", "source": source, "hook_event_name": "SessionStart"}
    if title is not None:
        d["session_title"] = title
    return d


fails = 0


def check(name, ok, detail=""):
    global fails
    if not ok:
        fails += 1
        print(f"FAIL  {name}" + (f"\n      {detail}" if detail else ""))


def main():
    rig = Rig()

    # a plain session: the whole index and the standup, shown events recorded
    proc, calls = rig.run(payload())
    out = proc.stdout
    check("plain: exit 0", proc.returncode == 0, proc.stderr)
    check("plain: whole index", "## Pinned" in out and "## Recent" in out, out[:300])
    check("plain: the standup list", "[3] L3 task 3" in out)
    check("plain: today records shown", ["today", "--scope", SCOPE, "--record-shown"] in calls, calls)
    check("plain: no title, no --title", all(not any(a.startswith("--title") for a in c) for c in opens(calls)), calls)
    check("plain: no compaction note", COMPACT_LINE not in out)
    check("plain: no schema line", SCHEMA_LINE not in out)
    check("plain: nothing on stderr", proc.stderr == "", proc.stderr)

    # a titled session that is no child: the title is stored, the output is the whole one
    proc, calls = rig.run(payload(title="Fix the  label\nprinter"))
    check("titled: title passed, whitespace folded",
          opens(calls) == [["session", "open", "--scope", SCOPE, "--id", "sess-1", "--source", "startup",
                            "--title=Fix the label printer"]], calls)
    check("titled: whole index", "## Recent" in proc.stdout)

    # a child: the pinned section and one standup line, under the context cap
    proc, calls = rig.run(payload(title="[child] ACME-12 label printer"))
    out = proc.stdout
    check("child: exit 0", proc.returncode == 0, proc.stderr)
    check("child: pinned rules kept", "## Pinned" in out and PINNED[-1] in out, out[:300])
    check("child: index header kept", out.splitlines()[2].startswith("# kb index"), out[:300])
    check("child: no recent records", "## Recent" not in out and RECENT[0] not in out)
    check("child: the standup count", STANDUP_LINE in out, out[-400:])
    check("child: no standup list", "[3] L3 task 3" not in out)
    check("child: today not recorded as shown", not any("--record-shown" in c for c in calls), calls)
    check("child: title stored", any("--title=[child] ACME-12 label printer" in c for c in opens(calls)), calls)
    check(f"child: under {CONTEXT_CAP} characters", len(out) < CONTEXT_CAP, f"{len(out)} characters")
    full = rig.run(payload())[0].stdout
    check("rig: the whole output is over the cap, so the child case means something", len(full) > CONTEXT_CAP, len(full))

    # "[child]" only as a prefix with its space marks a child
    for title in ("child task", "[child]no-space", "x [child] y", "[Child] upper"):
        proc, _ = rig.run(payload(title=title))
        check(f"not a child: {title!r}", "## Recent" in proc.stdout)

    # a child whose kb prints no Pinned section gets the whole index (the agreed fallback)
    proc, _ = rig.run(payload(title="[child] ACME-12"), index="index-no-pins.txt")
    check("child, no pins: whole index", RECENT[2] in proc.stdout, proc.stdout[:300])

    # an older kb: --title refused with a usage error, the session opens without it, nothing leaks
    proc, calls = rig.run(payload(title="[child] ACME-12 label printer"), KB_STUB_OLD="1")
    out = proc.stdout
    check("old kb: retried without --title",
          [c for c in opens(calls) if not any(a.startswith("--title") for a in c)] != [], calls)
    check("old kb: session line printed once", out.count("kb: session [42]") == 1, out[:400])
    check("old kb: no usage error in context", "No such option" not in out and "Usage:" not in out, out[:400])
    check("old kb: still a slim child", "## Recent" not in out and STANDUP_LINE in out)

    # compaction: the note instruction comes first, inside the preview
    proc, _ = rig.run(payload(source="compact"))
    first = proc.stdout.splitlines()[0] if proc.stdout else ""
    check("compact: instruction first", first.startswith(COMPACT_LINE), first)
    check("compact: names kb session note", "kb session note" in first, first)
    check("compact: inside the preview", proc.stdout.find(COMPACT_LINE) < PREVIEW)
    for source in ("startup", "resume", "clear"):
        check(f"{source}: no compaction note", COMPACT_LINE not in rig.run(payload(source=source))[0].stdout)

    # the schema line: schema_ok false, a non-empty schema_stale; never for unknown or an old kb
    for name, status, expected in (
        ("schema_ok false", {**STATUS_OK, "schema_ok": False}, True),
        ("schema_stale named", {**STATUS_OK, "schema_stale": ["record_text"]}, True),
        ("schema_stale empty", {**STATUS_OK, "schema_stale": []}, False),
        ("old kb without schema_stale", STATUS_OK, False),
    ):
        proc, _ = rig.run(payload(), status=status)
        check(f"schema: {name}", (SCHEMA_LINE in proc.stdout) is expected, proc.stdout[:300])
        if expected:
            check(f"schema: {name}, inside the preview", proc.stdout.find(SCHEMA_LINE) < PREVIEW)

    # Neo4j down: started, the status read again (its schema then counts); or NO MEMORY, no schema line
    proc, calls = rig.run(payload(), status={"bolt_reachable": False, "schema_ok": None})
    check("down: service started", ["service", "start"] in calls, calls)
    check("down: status read again", calls.count(["--json", "status"]) == 2, calls)
    check("down: unknown schema is not stale", SCHEMA_LINE not in proc.stdout)
    proc, calls = rig.run(payload(), status={"bolt_reachable": False, "schema_ok": None}, KB_STUB_START_FAILS="1")
    check("down for good: NO MEMORY", "kb: NO MEMORY" in proc.stdout and proc.returncode == 0, proc.stdout)
    check("down for good: stops there", not opens(calls) and SCHEMA_LINE not in proc.stdout, calls)

    # a status that is no JSON at all: no crash, no false alarm
    proc, _ = rig.run(payload(), status="not json")
    check("garbled status: exit 0", proc.returncode == 0, proc.stderr)

    # unreadable input: the hook still starts the session and exits 0
    proc, _ = rig.run("{not json")
    check("bad input: exit 0", proc.returncode == 0, proc.stderr)
    check("bad input: index still printed", "## Pinned" in proc.stdout)

    # no kb on PATH: one line naming the fix, nothing else
    proc, _ = rig.run(payload(title="[child] ACME-12"), with_kb=False)
    check("no kb: exit 0", proc.returncode == 0, proc.stderr)
    check("no kb: one line naming nix run .#kb-setup", proc.stdout == INSTALL_LINE + "\n", proc.stdout)
    check("no kb: nothing on stderr", proc.stderr == "", proc.stderr)

    # registration: this checkout must be the kb scope the hook uses
    proc, calls = rig.run(payload())
    check("registered: asks kb scope which for the repo root",
          any(c[:2] == ["scope", "which"] and len(c) == 3 for c in calls), calls)
    check("registered: no registration line", REGISTER_LINE not in proc.stdout)
    for mode in ("none", "other"):
        proc, calls = rig.run(payload(), KB_STUB_SCOPE=mode)
        out = proc.stdout
        check(f"scope {mode}: the line", REGISTER_LINE in out and "nix run .#kb-setup" in out, out[:400])
        check(f"scope {mode}: inside the preview", out.find(REGISTER_LINE) < PREVIEW)
        check(f"scope {mode}: the session still opens", opens(calls) != [], calls)
        check(f"scope {mode}: nothing on stderr", proc.stderr == "", proc.stderr)
    proc, _ = rig.run(payload(), KB_STUB_SCOPE="old")
    check("kb without scope command: no line", REGISTER_LINE not in proc.stdout, proc.stdout[:300])
    check("kb without scope command: no usage error", "No such command" not in proc.stdout + proc.stderr)
    proc, _ = rig.run(payload(source="compact"), KB_STUB_SCOPE="none")
    check("compact and unregistered: the compaction note stays first",
          proc.stdout.splitlines()[0].startswith(COMPACT_LINE), proc.stdout[:300])

    # the local extras still run, with source and session id
    local = rig.hook.with_name("kb-session-start.local.sh")
    local.write_text('#!/usr/bin/env bash\necho "local: $1 $2"\n')
    local.chmod(0o755)
    proc, _ = rig.run(payload(source="resume", title="[child] ACME-12"))
    check("local extras: called", "local: resume sess-1" in proc.stdout, proc.stdout[-300:])
    local.unlink()

    shutil.rmtree(rig.dir, ignore_errors=True)
    print(f"{'FAIL' if fails else 'ok'}: kb-session-start corpus, {fails} failure(s)")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    os.chdir(ROOT)
    main()
