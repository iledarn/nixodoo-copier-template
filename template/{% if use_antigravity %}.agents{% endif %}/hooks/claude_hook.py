#!/usr/bin/env python3
"""Run this project's Claude Code hooks under Antigravity (.agents/hooks.json).

The guards and nudges stay one copy, in .claude/hooks, wired in .claude/settings.json.
This script reads that wiring, so a hook added there for Bash, Edit, Write, Grep or Read
applies here too. The two contracts differ:

- Antigravity sends {"toolCall": {"name", "args"}, "conversationId", ...} on stdin, with
  arg values sometimes JSON-encoded twice (`"TargetFile": "\"/path\""`), and reads a
  decision on stdout. PreToolUse with no objection prints NOTHING, as entire's own
  Antigravity hook does: `{}` reads as an empty decision and denies the call, and
  `{"decision": "allow"}` would approve it past Antigravity's permission settings.
- Claude hooks read {"tool_name", "tool_input"} and block with exit 2 plus stderr.

Usage: claude_hook.py pre | post | session-start
Never fails the agent: on any error here `pre` prints nothing and the others `{}`, as a
crashing Claude hook is non-blocking too.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SETTINGS = ROOT / ".claude" / "settings.json"

# Claude hooks that only make sense in a Claude Code session: entire records Claude
# Code sessions, and its fan-out replays Claude payloads.
CLAUDE_ONLY = ("entire-fanout.sh",)

# Antigravity tool -> (Claude tool, tool_input) the hooks expect.
EDIT_TOOLS = {"write_to_file": "Write", "replace_file_content": "Edit", "multi_replace_file_content": "Edit"}


def project_dir_var():
    """The env var the hook commands use for the project root (project_dir_var in the answers)."""
    try:
        answers = (ROOT / ".copier-answers.yml").read_text()
        found = re.search(r"^project_dir_var:\s*(\w+)", answers, re.M)
        if found:
            return found.group(1)
    except OSError:
        pass
    return "ODOO16_PROJECT_DIR"


def absolute(path):
    if not path:
        return ""
    return str(path) if os.path.isabs(path) else str(ROOT / path)


def decode_args(args):
    """Unwrap arg values Antigravity encoded twice; plain values pass unchanged."""
    decoded = {}
    for key, value in args.items():
        if isinstance(value, str):
            try:
                inner = json.loads(value)
            except ValueError:
                inner = None
            if isinstance(inner, str):
                value = inner
        decoded[key] = value
    return decoded


def claude_call(name, args):
    if name == "run_command":
        return "Bash", {"command": args.get("CommandLine") or ""}
    if name in EDIT_TOOLS:
        return EDIT_TOOLS[name], {"file_path": absolute(args.get("TargetFile"))}
    if name == "grep_search":
        return "Grep", {"pattern": args.get("Query") or "", "path": absolute(args.get("SearchPath"))}
    if name == "view_file":
        return "Read", {"file_path": absolute(args.get("AbsolutePath"))}
    return None, {}


def commands(event, tool):
    """The hook commands .claude/settings.json runs for this event and Claude tool."""
    groups = json.loads(SETTINGS.read_text()).get("hooks", {}).get(event, [])
    for group in groups:
        matcher = group.get("matcher") or ""
        if matcher and not re.fullmatch(matcher, tool):
            continue
        for hook in group.get("hooks", []):
            command = hook.get("command") or ""
            if hook.get("type", "command") == "command" and not any(name in command for name in CLAUDE_ONLY):
                yield command, hook.get("timeout", 30)


def run(command, payload, timeout):
    env = dict(os.environ)
    env.setdefault(project_dir_var(), str(ROOT))
    env["AGENT_HOST"] = "antigravity"
    return subprocess.run(
        ["bash", "-c", command],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        cwd=ROOT,
        env=env,
        timeout=timeout,
        check=False,
    )


def read_denies():
    """Path prefixes .claude/settings.json denies to Read, e.g. Read(./.entire/metadata/**)."""
    rules = json.loads(SETTINGS.read_text()).get("permissions", {}).get("deny", [])
    for rule in rules:
        found = re.fullmatch(r"Read\(\./(.+?)/?\*{0,2}\)", rule)
        if found:
            yield found.group(1).rstrip("/")


def denied_path(args):
    """Claude enforces permissions.deny itself; here every tool that can read is checked."""
    paths = [
        args.get(key) or "" for key in ("AbsolutePath", "SearchPath", "SearchDirectory", "DirectoryPath", "TargetFile")
    ]
    command = args.get("CommandLine") or ""
    for rel in read_denies():
        if any(absolute(path).startswith(str(ROOT / rel)) for path in paths if path) or rel in command:
            return f"Blocked: {rel}/ is read-denied in this project (.claude/settings.json permissions.deny)."
    return None


def common(data):
    # Documented payloads are flat; accept the nested protojson shape as well.
    return data.get("common") or data


def tool_call(data):
    for key in ("preToolHookArgs", "postToolHookArgs"):
        if key in data:
            return data[key].get("toolCall") or {}
    return data.get("toolCall") or {}


def claude_payload(data, event, tool=None, tool_input=None):
    base = common(data)
    workspaces = base.get("workspacePaths") or [str(ROOT)]
    payload = {
        "session_id": base.get("conversationId") or "",
        "transcript_path": base.get("transcriptPath") or "",
        "cwd": workspaces[0],
        "hook_event_name": event,
    }
    if tool:
        payload.update(tool_name=tool, tool_input=tool_input)
    return payload


def pre(data):
    call = tool_call(data)
    name, args = call.get("name") or "", decode_args(call.get("args") or {})
    reason = denied_path(args)
    if reason:
        return {"decision": "deny", "reason": reason}
    tool, tool_input = claude_call(name, args)
    if not tool:
        return None
    payload = claude_payload(data, "PreToolUse", tool, tool_input)
    for command, timeout in commands("PreToolUse", tool):
        done = run(command, payload, timeout)
        if done.returncode == 2:
            return {"decision": "deny", "reason": done.stderr.strip() or "Blocked by " + command}
    return None


def post(data):
    call = tool_call(data)
    tool, tool_input = claude_call(call.get("name") or "", decode_args(call.get("args") or {}))
    if tool:
        payload = claude_payload(data, "PostToolUse", tool, tool_input)
        for command, timeout in commands("PostToolUse", tool):
            run(command, payload, timeout)
    return {}


def session_start(data):
    """kb memory: open the session record, inject the index and today's standup."""
    script = ROOT / ".claude" / "hooks" / "kb-session-start.sh"
    payload = claude_payload(data, "SessionStart")
    payload["source"] = "startup"
    if not script.exists() or not payload["session_id"]:
        return {}
    text = run(f'bash "{script}"', payload, 55).stdout.strip()
    if not text:
        return {}
    text += (
        "\n\nkb: this Antigravity conversation is kb session id {id}. Pass `--id {id}` to "
        "`kb session note` and `kb session close`: a Claude Code session may be open at the "
        "same time, and without --id kb picks the newest one."
    ).format(id=payload["session_id"])
    return {"injectSteps": [{"ephemeralMessage": text}]}


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        data = json.loads(sys.stdin.read() or "{}")
        result = {"pre": pre, "post": post, "session-start": session_start}[mode](data)
    except Exception as error:  # noqa: BLE001 - a broken adapter must not stop the agent
        sys.stderr.write(f"claude_hook.py {mode}: {error!r}\n")
        result = None if mode == "pre" else {}
    if result is not None:
        sys.stdout.write(json.dumps(result) + "\n")


if __name__ == "__main__":
    main()
