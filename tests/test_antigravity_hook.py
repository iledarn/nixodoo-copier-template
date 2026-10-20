#!/usr/bin/env python3
"""Regression corpus for template/.agents/hooks/claude_hook.py, the Antigravity adapter.

Run from the repo root: python3 tests/test_antigravity_hook.py

The adapter runs the Claude Code hooks wired in .claude/settings.json under Antigravity.
Two answers looked right and were not: `{}` reads as an empty decision and Antigravity
denies the call, and `{"decision": "allow"}` approves it past Antigravity's own
permission settings. With no objection the adapter must print NOTHING, as entire's
Antigravity hook does. agy also sends arg values JSON-encoded twice
(`"TargetFile": "\\"/path\\""`), which got past a path guard before they were unwrapped.

Each case builds a tiny project (adapter, settings.json, two stub hooks) in a temp dir.
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile

ADAPTER = "template/{% if use_antigravity %}.agents{% endif %}/hooks/claude_hook.py"

# exit 2 + stderr is a Claude block; the guard refuses one command and one directory
GUARD = """#!/bin/bash
input=$(cat)
command=$(printf '%s' "$input" | python3 -c "import sys,json; print(json.load(sys.stdin)['tool_input'].get('command',''))")
path=$(printf '%s' "$input" | python3 -c "import sys,json; print(json.load(sys.stdin)['tool_input'].get('file_path',''))")
case "$command" in *"rm -rf /"*) echo "Blocked: dangerous" >&2; exit 2;; esac
case "$path" in "$PROJECT_DIR"/src/core/*) echo "Blocked: read-only" >&2; exit 2;; esac
exit 0
"""
SETTINGS = {
    "hooks": {
        "PreToolUse": [
            {"matcher": "Edit|Write", "hooks": [{"type": "command", "command": "bash $PROJECT_DIR/.claude/hooks/guard.sh"}]},
            {"matcher": "Bash", "hooks": [
                {"type": "command", "command": "bash $PROJECT_DIR/.claude/hooks/guard.sh"},
                {"type": "command", "command": "bash $PROJECT_DIR/.claude/hooks/entire-fanout.sh pre-task"},
            ]},
        ],
    },
    "permissions": {"deny": ["Read(./.entire/metadata/**)"]},
}


def project(adapter_path=ADAPTER):
    root = tempfile.mkdtemp()
    os.makedirs(f"{root}/.agents/hooks")
    os.makedirs(f"{root}/.agents/plugins/workspace-inspector")
    os.makedirs(f"{root}/.claude/hooks")
    os.makedirs(f"{root}/home")
    shutil.copy(adapter_path, f"{root}/.agents/hooks/claude_hook.py")
    with open(f"{root}/.agents/plugins/workspace-inspector/plugin.json", "w") as fh:
        json.dump({"name": "workspace-inspector", "version": "1.0.0"}, fh)
    with open(f"{root}/.claude/settings.json", "w") as fh:
        json.dump(SETTINGS, fh)
    with open(f"{root}/.claude/hooks/guard.sh", "w") as fh:
        fh.write(GUARD)
    # a Claude-only hook: the adapter must never run it
    with open(f"{root}/.claude/hooks/entire-fanout.sh", "w") as fh:
        fh.write("#!/bin/bash\necho ran > \"$PROJECT_DIR/fanout-ran\"\n")
    with open(f"{root}/.copier-answers.yml", "w") as fh:
        fh.write("project_dir_var: PROJECT_DIR\n")
    os.chmod(f"{root}/.agents/hooks/claude_hook.py", stat.S_IRWXU)
    return root


def twice(args):
    return {key: json.dumps(value) for key, value in args.items()}


def call(root, mode, name, args, raw=None):
    payload = raw if raw is not None else json.dumps({"conversationId": "c1", "toolCall": {"name": name, "args": args}})
    env = {k: v for k, v in os.environ.items() if k not in ("PROJECT_DIR", "ANTIGRAVITY_APP_DATA_DIR")}
    env["HOME"] = f"{root}/home"
    env["ANTIGRAVITY_APP_DATA_DIR"] = f"{root}/home/.gemini/antigravity"
    env["ANTIGRAVITY_CONVERSATION_ID"] = "c1"
    done = subprocess.run(
        [sys.executable, f"{root}/.agents/hooks/claude_hook.py", mode],
        input=payload, capture_output=True, text=True, env=env, check=False,
    )
    assert done.returncode == 0, done
    return done.stdout


def cli(root, *argv):
    env = {k: v for k, v in os.environ.items() if k not in ("PROJECT_DIR", "ANTIGRAVITY_APP_DATA_DIR")}
    env["HOME"] = f"{root}/home"
    env["ANTIGRAVITY_APP_DATA_DIR"] = f"{root}/home/.gemini/antigravity"
    env["ANTIGRAVITY_CONVERSATION_ID"] = "c1"
    return subprocess.run(
        [sys.executable, f"{root}/.agents/hooks/claude_hook.py", "pipeline-gate", *argv],
        capture_output=True, text=True, env=env, check=False,
    )


def main():
    adapter_path = sys.argv[1] if len(sys.argv) > 1 else ADAPTER
    root = project(adapter_path)
    core, mine = f"{root}/src/core/models.py", f"{root}/src/mine/models.py"
    wt_code = f"{root}/.worktrees/kio-1/mod/models.py"
    wt_doc = f"{root}/.worktrees/kio-1/mod/README.rst"
    meta = f"{root}/.entire/metadata/t.json"
    # (want, label, mode, tool, args); want: "" silent, "deny" a denial, "{}" for post
    cases = [
        ("", "plain command passes silently", "pre", "run_command", {"CommandLine": "ls -la"}),
        ("deny", "guard blocks a command", "pre", "run_command", {"CommandLine": "rm -rf /"}),
        ("deny", "guard blocks a command, args encoded twice", "pre", "run_command", twice({"CommandLine": "rm -rf /"})),
        ("deny", "guard blocks a read-only edit", "pre", "replace_file_content", {"TargetFile": core}),
        ("deny", "guard blocks a read-only edit, args encoded twice", "pre", "write_to_file", twice({"TargetFile": core, "Overwrite": True})),
        ("", "an allowed edit passes silently", "pre", "write_to_file", twice({"TargetFile": mine, "Overwrite": True})),
        ("", "edit_file uses Path and passes when allowed", "pre", "edit_file", {"Path": mine}),
        ("deny", "edit_file uses Path and blocks read-only", "pre", "edit_file", {"Path": core}),
        ("deny", "permissions.deny covers view_file", "pre", "view_file", {"AbsolutePath": meta}),
        ("deny", "permissions.deny covers read_file", "pre", "read_file", {"Path": meta}),
        ("deny", "permissions.deny covers view_file, args encoded twice", "pre", "view_file", twice({"AbsolutePath": meta})),
        ("deny", "permissions.deny covers a command naming the path", "pre", "run_command", {"CommandLine": "cat .entire/metadata/t.json"}),
        ("", "a tool with no Claude twin passes silently", "pre", "invoke_subagent", {"Subagents": "[]"}),
        ("{}", "post answers {}", "post", "write_to_file", {"TargetFile": mine}),
    ]
    failures = 0
    for want, label, mode, tool, args in cases:
        out = call(root, mode, tool, args).strip()
        got = "deny" if out.startswith('{"decision": "deny"') else out
        ok = got == want
        failures += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} {label}" + ("" if ok else f": want {want!r}, got {out!r}"))
    for label, raw in (("broken stdin stays silent", "not json"), ("empty stdin stays silent", "")):
        out = call(root, "pre", "", {}, raw=raw)
        ok = out == ""
        failures += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} {label}" + ("" if ok else f": got {out!r}"))
    ok = not os.path.exists(f"{root}/fanout-ran")
    failures += not ok
    print(f"  {'ok  ' if ok else 'FAIL'} the Claude-only entire fan-out never runs")
    ok = os.path.isfile(f"{root}/home/.gemini/config/plugins/workspace-inspector/plugin.json")
    failures += not ok
    print(f"  {'ok  ' if ok else 'FAIL'} workspace-inspector sidecar plugin syncs into ~/.gemini/config/plugins/")

    # pipeline-gates enforcement tests
    cli(root, "start", "KIO-1")
    pipeline_cases_before = [
        ("deny", "pipeline-gates blocks dev subagent before status & grill", "pre", "invoke_subagent", {"TypeName": "dev"}),
        ("deny", "pipeline-gates blocks worktree edit before status & grill", "pre", "edit_file", {"Path": wt_code}),
        ("{}", "teams-mcp post opens status gate", "post", "call_mcp_tool", {"ServerName": "teams-mcp", "ToolName": "send_chat_message"}),
        ("deny", "pipeline-gates still blocks dev subagent while grill closed", "pre", "invoke_subagent", {"TypeName": "dev"}),
    ]
    for want, label, mode, tool, args in pipeline_cases_before:
        out = call(root, mode, tool, args).strip()
        got = "deny" if out.startswith('{"decision": "deny"') else out
        ok = got == want
        failures += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} {label}" + ("" if ok else f": want {want!r}, got {out!r}"))

    cli(root, "open", "grill", "confirmed")
    pipeline_cases_after_grill = [
        ("", "pipeline-gates allows dev subagent once status & grill open", "pre", "invoke_subagent", {"TypeName": "dev"}),
        ("", "pipeline-gates allows worktree code edit once status & grill open", "pre", "edit_file", {"Path": wt_code}),
        ("{}", "worktree code edit advances seq in post", "post", "edit_file", {"Path": wt_code}),
        ("deny", "pipeline-gates blocks gh pr create before qc pass", "pre", "run_command", {"CommandLine": "gh pr create --title test"}),
    ]
    for want, label, mode, tool, args in pipeline_cases_after_grill:
        out = call(root, mode, tool, args).strip()
        got = "deny" if out.startswith('{"decision": "deny"') else out
        ok = got == want
        failures += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} {label}" + ("" if ok else f": want {want!r}, got {out!r}"))

    cli(root, "qc-verdict", "pass", "review and tests green")
    pipeline_cases_after_qc = [
        ("{}", "worktree doc edit does not invalidate qc pass", "post", "edit_file", {"Path": wt_doc}),
        ("", "pipeline-gates allows gh pr create after qc pass and doc edit", "pre", "run_command", {"CommandLine": "gh pr create --title test"}),
        ("{}", "worktree code edit invalidates qc pass", "post", "edit_file", {"Path": wt_code}),
        ("deny", "pipeline-gates blocks gh pr create after new code edit", "pre", "run_command", {"CommandLine": "gh pr create --title test"}),
    ]
    for want, label, mode, tool, args in pipeline_cases_after_qc:
        out = call(root, mode, tool, args).strip()
        got = "deny" if out.startswith('{"decision": "deny"') else out
        ok = got == want
        failures += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} {label}" + ("" if ok else f": want {want!r}, got {out!r}"))

    shutil.rmtree(root)
    print("PASS" if not failures else f"{failures} FAILED")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
