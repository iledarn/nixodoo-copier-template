#!/usr/bin/env python3
"""Run this project's Claude Code hooks and pipeline gates under Antigravity (.agents/hooks.json).

The guards and nudges stay one copy, in .claude/hooks, wired in .claude/settings.json.
This script reads that wiring, so a hook added there for Bash, Edit, Write, Grep or Read
applies here too. It also syncs .agents/plugins/* UI sidecar panels into
~/.gemini/config/plugins/ and enforces active pipeline-gates runs.

Usage:
  claude_hook.py pre | post | session-start
  claude_hook.py pipeline-gate [status | start [TASK ...] | end | phase <0..7> [TASK] | qc-verdict <pass|blocking> <summary> | open <status|grill|qc|rounds> <reason> | tasks ...]
"""

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SETTINGS = ROOT / ".claude" / "settings.json"
ANTIGRAVITY_DIR = Path(os.environ.get("ANTIGRAVITY_APP_DATA_DIR") or (Path.home() / ".gemini" / "antigravity"))
RUNS_FILE = ANTIGRAVITY_DIR / "plugin_data" / "pipeline-gates" / "runs.json"

# Claude hooks that only make sense in a Claude Code session: entire records Claude
# Code sessions, and its fan-out replays Claude payloads.
CLAUDE_ONLY = ("entire-fanout.sh",)

# Antigravity tool -> (Claude tool, tool_input) the hooks expect.
EDIT_TOOLS = {
    "write_file": "Write",
    "edit_file": "Edit",
    "write_to_file": "Write",
    "replace_file_content": "Edit",
    "multi_replace_file_content": "Edit",
}
READ_TOOLS = {"read_file", "view_file"}

PHASES = (
    "Memory bootstrap",
    "Task reading",
    "Development",
    "QC gate",
    "Documentation",
    "Demo GIF (optional)",
    "Pull request",
    "Memory closure",
)
GATE_LABELS = {"status": "Teams status", "grill": "grill alignment", "qc": "QC verdict"}
WORKTREE_RE = re.compile(r"/\.worktrees/(?!_env/)[A-Za-z0-9][A-Za-z0-9._-]*/")
DOC_PATH_RE = re.compile(r"/readme/|/README\.(?:rst|md)$|/static/description/|\.puml$")
PR_CREATE_RE = re.compile(r"\bgh\s+(?:(?:-R|--repo)\s+\S+\s+)?pr\s+(?:create|new)\b")
RESUME_REFUSAL = (
    "pipeline-gates: a fix round goes to a fresh dev agent, not into one that already worked: "
    "spawn dev with a brief (the verified findings with their decisive lines, and "
    "`git diff --cached --stat <REVIEWED_TREE>` for what earlier rounds changed)."
)


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
            if isinstance(inner, (str, dict, list)):
                value = inner
        decoded[key] = value
    return decoded


def target_path_of(args):
    return absolute(args.get("Path") or args.get("TargetFile") or args.get("AbsolutePath") or "")


def claude_call(name, args):
    if name == "run_command":
        return "Bash", {"command": args.get("CommandLine") or ""}
    if name in EDIT_TOOLS:
        return EDIT_TOOLS[name], {"file_path": target_path_of(args)}
    if name == "grep_search":
        return "Grep", {"pattern": args.get("Query") or "", "path": absolute(args.get("SearchPath"))}
    if name in READ_TOOLS:
        return "Read", {"file_path": target_path_of(args)}
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
        args.get(key) or ""
        for key in ("Path", "AbsolutePath", "SearchPath", "SearchDirectory", "DirectoryPath", "TargetFile")
    ]
    command = args.get("CommandLine") or ""
    for rel in read_denies():
        if any(absolute(path).startswith(str(ROOT / rel)) for path in paths if path) or rel in command:
            return f"Blocked: {rel}/ is read-denied in this project (.claude/settings.json permissions.deny)."
    return None


def common(data):
    return data.get("common") or data


def tool_call(data):
    for key in ("preToolHookArgs", "postToolHookArgs"):
        if key in data:
            return data[key].get("toolCall") or {}
    return data.get("toolCall") or {}


def conversation_id_of(data):
    base = common(data)
    return base.get("conversationId") or os.environ.get("ANTIGRAVITY_CONVERSATION_ID") or ""


def claude_payload(data, event, tool=None, tool_input=None):
    base = common(data)
    workspaces = base.get("workspacePaths") or [str(ROOT)]
    payload = {
        "session_id": conversation_id_of(data),
        "transcript_path": base.get("transcriptPath") or "",
        "cwd": workspaces[0],
        "hook_event_name": event,
    }
    if tool:
        payload.update(tool_name=tool, tool_input=tool_input)
    return payload


# === pipeline-gates state & enforcement ===


def load_runs():
    try:
        if RUNS_FILE.exists():
            return json.loads(RUNS_FILE.read_text())
    except Exception:  # noqa: BLE001
        pass
    return {}


def save_runs(runs):
    try:
        RUNS_FILE.parent.mkdir(parents=True, exist_ok=True)
        RUNS_FILE.write_text(json.dumps(runs, indent=2))
    except Exception:  # noqa: BLE001
        pass


def is_gate_open(gate):
    return isinstance(gate, dict) and gate.get("isOpen") is True


def closed_for_dev(p_run):
    return [g for g in ("status", "grill") if not is_gate_open(p_run.get(g))]


def qc_holds(p_run):
    return is_gate_open(p_run.get("qc")) and (p_run.get("qcSeq") or 0) > (p_run.get("lastChange") or 0)


def qc_missing(p_run):
    last_change = p_run.get("lastChange") or 0
    missing = []
    if (p_run.get("lastReview") or 0) <= last_change:
        missing.append("a review agent that finished after the last code change")
    if (p_run.get("lastGreen") or 0) <= last_change:
        missing.append("a green Odoo test run (more than 0 tests) after the last code change")
    return missing


def record_block(runs, conv_id, p_run, what):
    now_ms = int(time.time() * 1000)
    blocked = [{"what": what, "at": now_ms}, *(p_run.get("blocked") or [])][:5]
    p_run["blocked"] = blocked
    runs[conv_id] = p_run
    save_runs(runs)


def check_pipeline_pre(conv_id, name, args):
    if not conv_id:
        return None
    runs = load_runs()
    p_run = runs.get(conv_id)
    if not isinstance(p_run, dict) or p_run.get("isDone"):
        return None

    is_dev_agent = name == "invoke_subagent" and args.get("TypeName") == "dev"
    path = target_path_of(args) if name in EDIT_TOOLS else ""
    is_wt_edit = bool(path and WORKTREE_RE.search(path))

    closed = closed_for_dev(p_run)
    if (is_dev_agent or is_wt_edit) and closed:
        what = "spawning the dev agent" if is_dev_agent else f"editing {path}"
        record_block(runs, conv_id, p_run, what)
        labels = " and ".join(GATE_LABELS[g] for g in closed)
        how = []
        if "status" in closed:
            how.append("the status gate opens on a successful Teams send (my-status send)")
        if "grill" in closed:
            how.append("the grill gate opens when the user clicks confirm or mechanical in the Pipeline panel")
        return (
            f"pipeline-gates: {what} is refused while {labels} closed ({'; '.join(how)}). "
            "Open the Pipeline panel in Overview -> Plugins to confirm."
        )

    phase = p_run.get("phase") or 0
    is_new_round = 2 <= phase <= 3 and (p_run.get("lastReview") or 0) > (p_run.get("roundSeq") or 0)
    if is_new_round and not closed:
        if name == "send_message":
            dev_ids = set(p_run.get("devAgentIds") or [])
            recipient = str(args.get("Recipient") or "").strip()
            if recipient in dev_ids or not dev_ids:
                record_block(runs, conv_id, p_run, "a fix round sent into an old dev agent")
                return RESUME_REFUSAL
        if is_dev_agent:
            max_rounds = 3 + (p_run.get("extraRounds") or 0)
            fix_rounds = p_run.get("fixRounds") or 0
            if fix_rounds >= max_rounds:
                record_block(runs, conv_id, p_run, f"fix round {fix_rounds + 1}")
                return (
                    f"pipeline-gates: fix round {fix_rounds + 1} is refused, the QC gate still blocks "
                    f"after {fix_rounds} rounds. Stop and report to the user; only the user grants +3 rounds "
                    "in the Pipeline panel."
                )
            seq = (p_run.get("seq") or 0) + 1
            p_run["seq"] = seq
            p_run["fixRounds"] = fix_rounds + 1
            p_run["roundSeq"] = seq
            runs[conv_id] = p_run
            save_runs(runs)

    if name == "run_command":
        cmd = args.get("CommandLine") or ""
        if PR_CREATE_RE.search(cmd) and not qc_holds(p_run):
            record_block(runs, conv_id, p_run, "gh pr create")
            missing = [*qc_missing(p_run), "a pass recorded in the Pipeline panel (or claude_hook.py pipeline-gate qc-verdict pass)"]
            return f"pipeline-gates: gh pr create is refused until the QC gate passes; missing: {', '.join(missing)}."

    return None


def update_pipeline_post(conv_id, name, args):
    if not conv_id:
        return
    runs = load_runs()
    p_run = runs.get(conv_id)
    if not isinstance(p_run, dict) or p_run.get("isDone"):
        return

    now_ms = int(time.time() * 1000)
    changed = False

    if name in EDIT_TOOLS:
        path = target_path_of(args)
        if path and WORKTREE_RE.search(path) and not DOC_PATH_RE.search(path):
            seq = (p_run.get("seq") or 0) + 1
            p_run["seq"] = seq
            p_run["lastChange"] = seq
            changed = True
    elif name == "invoke_subagent":
        sub_type = args.get("TypeName") or ""
        if sub_type in ("dev", "review"):
            seq = (p_run.get("seq") or 0) + 1
            p_run["seq"] = seq
            if sub_type == "dev":
                p_run["lastChange"] = seq
            else:
                p_run["lastReview"] = seq
            changed = True
    elif name == "call_mcp_tool":
        tool_name = args.get("ToolName") or ""
        if tool_name in ("send_chat_message", "send_channel_message") and not is_gate_open(p_run.get("status")):
            p_run["status"] = {"isOpen": True, "how": f"sent via teams-mcp ({tool_name})", "at": now_ms}
            changed = True

    if changed:
        runs[conv_id] = p_run
        save_runs(runs)


def pre(data):
    call = tool_call(data)
    name, args = call.get("name") or "", decode_args(call.get("args") or {})
    reason = denied_path(args)
    if reason:
        return {"decision": "deny", "reason": reason}
    pg_reason = check_pipeline_pre(conversation_id_of(data), name, args)
    if pg_reason:
        return {"decision": "deny", "reason": pg_reason}
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
    name, args = call.get("name") or "", decode_args(call.get("args") or {})
    update_pipeline_post(conversation_id_of(data), name, args)
    tool, tool_input = claude_call(name, args)
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


def find_ls():
    """Find Antigravity LanguageServer (address, csrf_token) from env or /proc."""
    ls_addr = os.environ.get("ANTIGRAVITY_LS_ADDRESS")
    csrf = os.environ.get("ANTIGRAVITY_CSRF_TOKEN")
    if ls_addr and csrf:
        return ls_addr, csrf
    if str(Path.home()).startswith("/tmp/"):
        return None, None
    proc = Path("/proc")
    if not proc.is_dir():
        return None, None
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            raw = (entry / "environ").read_bytes()
        except OSError:
            continue
        if b"ANTIGRAVITY_LS_ADDRESS=" not in raw or b"ANTIGRAVITY_CSRF_TOKEN=" not in raw:
            continue
        env_map = {}
        for item in raw.split(b"\0"):
            if b"=" in item:
                k, v = item.split(b"=", 1)
                if k in (b"ANTIGRAVITY_LS_ADDRESS", b"ANTIGRAVITY_CSRF_TOKEN"):
                    env_map[k.decode()] = v.decode(errors="ignore")
        if env_map.get("ANTIGRAVITY_LS_ADDRESS") and env_map.get("ANTIGRAVITY_CSRF_TOKEN"):
            return env_map["ANTIGRAVITY_LS_ADDRESS"], env_map["ANTIGRAVITY_CSRF_TOKEN"]
    return None, None


def ls_request(method, payload):
    """Call a Connect-JSON method on Antigravity's LanguageServerService."""
    import urllib.request

    ls_addr, csrf = find_ls()
    if not (ls_addr and csrf):
        return None
    try:
        req = urllib.request.Request(
            f"http://{ls_addr}/exa.language_server_pb.LanguageServerService/{method}",
            data=json.dumps(payload).encode(),
            headers={
                "Content-Type": "application/json",
                "Connect-Protocol-Version": "1",
                "x-codeium-csrf-token": csrf,
            },
            method="POST",
        )
        return json.loads(urllib.request.urlopen(req, timeout=2).read().decode())
    except Exception as exc:  # noqa: BLE001
        return {"_error": repr(exc)}


def sync_ui_plugins():
    """Keep ~/.gemini/config/plugins/<name> in sync with .agents/plugins/<name> for UI sidecar plugins.

    Antigravity's SidecarManager only discovers sidecar UI panels under ~/.gemini/config/plugins/,
    so the template ships the UI plugins in .agents/plugins/ and mirrors them into
    ~/.gemini/config/plugins/ when a hook runs.
    """
    plugins_root = ROOT / ".agents" / "plugins"
    if not plugins_root.is_dir():
        return
    changed_ids = set()
    wanted_ids = set()
    for src in sorted(plugins_root.iterdir()):
        has_sidecar = (src / "sidecars" / "panel" / "server.mjs").exists()
        if not src.is_dir() or not (has_sidecar or src.name == "workspace-inspector"):
            continue
        sidecar_id = f"{src.name}/panel"
        if has_sidecar:
            wanted_ids.add(sidecar_id)
        dst = Path.home() / ".gemini" / "config" / "plugins" / src.name
        changed = False
        for path in src.rglob("*"):
            if path.is_dir():
                continue
            target = dst / path.relative_to(src)
            data = path.read_bytes()
            if not target.exists() or target.read_bytes() != data:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                changed = True
        if changed and has_sidecar:
            changed_ids.add(sidecar_id)

    kb_global = Path.home() / ".gemini" / "config" / "plugins" / "kb" / "sidecars" / "panel" / "server.mjs"
    if kb_global.exists():
        wanted_ids.add("kb/panel")

    stamp_file = ANTIGRAVITY_DIR / "plugin_data" / "sidecar_sync.stamp"
    now = time.time()
    recent = False
    try:
        recent = stamp_file.exists() and (now - stamp_file.stat().st_mtime) < 30
    except OSError:
        pass
    if not changed_ids and recent:
        return

    info = ls_request("GetSidecars", {})
    if not info or "_error" in info:
        return
    try:
        stamp_file.parent.mkdir(parents=True, exist_ok=True)
        stamp_file.write_text(str(now))
    except OSError:
        pass

    sidecar_list = info.get("sidecars") or info.get("sidecarInfos") or info.get("statuses") or []
    running = {
        s.get("id") or s.get("sidecarId"): s.get("status")
        for s in sidecar_list
        if isinstance(s, dict) and (s.get("id") or s.get("sidecarId"))
    }
    for sidecar_id in sorted(wanted_ids):
        if sidecar_id in changed_ids:
            ls_request("ManageSidecar", {"sidecarId": sidecar_id, "action": "SIDECAR_ACTION_RESTART"})
        elif running.get(sidecar_id) != "SIDECAR_STATUS_RUNNING":
            ls_request("ManageSidecar", {"sidecarId": sidecar_id, "action": "SIDECAR_ACTION_START"})


def pipeline_gate_cli(argv):
    """CLI helper to inspect or advance pipeline-gates state from the terminal."""
    conv_id = os.environ.get("ANTIGRAVITY_CONVERSATION_ID") or ""
    runs = load_runs()
    if not conv_id and runs:
        conv_id = list(runs.keys())[-1]
    if not conv_id:
        conv_id = "default"
    now_ms = int(time.time() * 1000)
    verb = argv[0] if argv else "status"
    rest = argv[1:]
    current = runs.get(conv_id)

    if verb == "start":
        task = rest[0].upper() if rest else "PIPELINE"
        current = {
            "task": task,
            "startedAt": now_ms,
            "phase": 0,
            "phaseAt": [now_ms] + [0] * (len(PHASES) - 1),
            "status": None,
            "grill": None,
            "qc": None,
            "qcSeq": 0,
            "seq": 0,
            "lastChange": 0,
            "lastReview": 0,
            "lastGreen": 0,
            "lastTests": "",
            "fixRounds": 0,
            "roundSeq": 0,
            "extraRounds": 0,
            "tasks": [{"key": k.upper(), "title": "", "state": "pending", "at": now_ms, "url": ""} for k in rest],
            "blocked": [],
            "isDone": False,
        }
        runs[conv_id] = current
        save_runs(runs)
    elif verb == "phase" and rest:
        ph = int(rest[0])
        task = rest[1].upper() if len(rest) > 1 else ""
        if not current or current.get("isDone"):
            pipeline_gate_cli(["start", *( [task] if task else [] )])
            runs = load_runs()
            current = runs[conv_id]
        closed = closed_for_dev(current)
        if ph >= 2 and closed:
            sys.stdout.write(f"pipeline-gates: Phase {ph} refused; closed gates: {', '.join(closed)}\n")
            sys.exit(2)
        if ph >= 6 and not qc_holds(current):
            sys.stdout.write("pipeline-gates: Phase 6 refused until QC verdict passes.\n")
            sys.exit(2)
        current["phase"] = ph
        if task:
            current["task"] = task
        phase_at = current.get("phaseAt") or [0] * len(PHASES)
        if 0 <= ph < len(phase_at) and phase_at[ph] == 0:
            phase_at[ph] = now_ms
        current["phaseAt"] = phase_at
        current["isDone"] = ph == len(PHASES) - 1
        runs[conv_id] = current
        save_runs(runs)
    elif verb == "qc-verdict" and len(rest) >= 2:
        verdict, summary = rest[0], " ".join(rest[1:])
        if current and not current.get("isDone"):
            seq = (current.get("seq") or 0) + 1
            current["seq"] = seq
            current["qc"] = {"isOpen": verdict == "pass", "how": f"{verdict}: {summary}", "at": now_ms}
            current["qcSeq"] = seq
            runs[conv_id] = current
            save_runs(runs)
    elif verb == "open" and rest:
        gate = rest[0]
        reason = " ".join(rest[1:]) or "confirmed"
        if current and not current.get("isDone"):
            if gate == "rounds":
                current["extraRounds"] = (current.get("extraRounds") or 0) + 3
            elif gate in ("status", "grill", "qc"):
                current[gate] = {"isOpen": True, "how": reason, "at": now_ms}
                if gate == "qc":
                    seq = (current.get("seq") or 0) + 1
                    current["seq"] = seq
                    current["qcSeq"] = seq
            runs[conv_id] = current
            save_runs(runs)
    elif verb == "end" and current:
        current["isDone"] = True
        runs[conv_id] = current
        save_runs(runs)

    current = runs.get(conv_id)
    if not current:
        sys.stdout.write("pipeline-gates: no pipeline run in this session.\n")
        return
    sys.stdout.write(
        f"pipeline {current.get('task') or '(task?)'} · phase {current.get('phase')} {PHASES[current.get('phase', 0)]}\n"
        f"status: {'open' if is_gate_open(current.get('status')) else 'closed'} · "
        f"grill: {'open' if is_gate_open(current.get('grill')) else 'closed'} · "
        f"qc: {'open' if qc_holds(current) else 'closed'}\n"
    )


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "pipeline-gate":
        sync_ui_plugins()
        pipeline_gate_cli(sys.argv[2:])
        return
    try:
        sync_ui_plugins()
        data = json.loads(sys.stdin.read() or "{}")
        result = {"pre": pre, "post": post, "session-start": session_start}[mode](data)
    except Exception as error:  # noqa: BLE001 - a broken adapter must not stop the agent
        sys.stderr.write(f"claude_hook.py {mode}: {error!r}\n")
        result = None if mode == "pre" else {}
    if result is not None:
        sys.stdout.write(json.dumps(result) + "\n")


if __name__ == "__main__":
    main()
