import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, watchFile, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SidecarApp } from 'sidecar_sdk';

const execFileAsync = promisify(execFile);

watchFile(fileURLToPath(import.meta.url), { interval: 1000 }, () => process.exit(1));

const HOME = homedir();
const GEMINI_CONFIG_DIR = join(HOME, '.gemini', 'config');
const ANTIGRAVITY_DIR = process.env.ANTIGRAVITY_APP_DATA_DIR || join(HOME, '.gemini', 'antigravity');
const BRAIN_DIR = join(ANTIGRAVITY_DIR, 'brain');
const PLUGIN_DATA_DIR = join(ANTIGRAVITY_DIR, 'plugin_data', 'pipeline-gates');
const RUNS_FILE = join(PLUGIN_DATA_DIR, 'runs.json');

const PHASES = [
  'Memory bootstrap',
  'Task reading',
  'Development',
  'QC gate',
  'Documentation',
  'Demo GIF (optional)',
  'Pull request',
  'Memory closure',
];

const GATE_LABELS = {
  status: 'Teams status',
  grill: 'grill alignment',
  qc: 'QC verdict',
};

const MAX_FIX_ROUNDS = 3;
const WORKTREE_RE = /\/\.worktrees\/(?!_env\/)[A-Za-z0-9][A-Za-z0-9._-]*\//;
const DOC_PATH_RE = /\/readme\/|\/README\.(?:rst|md)$|\/static\/description\/|\.puml$/;
const TEST_SUMMARY_RE = /(\d+) failed, (\d+) error\(s\) of (\d+) tests/g;
const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

async function lsrpc(method, body = {}) {
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!lsAddr || !csrf) return null;
  try {
    const res = await fetch(
      `http://${lsAddr}/exa.language_server_pb.LanguageServerService/${method}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': csrf,
        },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function safeReadJson(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function saveRunsMap(runsMap) {
  mkdirSync(PLUGIN_DATA_DIR, { recursive: true });
  const keys = Object.keys(runsMap);
  if (keys.length > 25) {
    for (const k of keys.slice(0, keys.length - 20)) {
      delete runsMap[k];
    }
  }
  writeFileSync(RUNS_FILE, JSON.stringify(runsMap, null, 2));
}

function uriToPath(uri) {
  if (!uri) return '';
  if (uri.startsWith('file://')) {
    try {
      return fileURLToPath(uri);
    } catch {
      return uri.replace(/^file:\/\//, '');
    }
  }
  return uri;
}

function loadKnownProjects() {
  const projectsDir = join(GEMINI_CONFIG_DIR, 'projects');
  const projects = [];
  if (!existsSync(projectsDir)) return projects;
  for (const file of readdirSync(projectsDir)) {
    if (!file.endsWith('.json')) continue;
    const data = safeReadJson(join(projectsDir, file));
    if (!data) continue;
    const uris = [];
    for (const r of data?.projectResources?.resources || []) {
      const folderUri = r?.gitFolder?.folderUri || r?.folderUri;
      if (folderUri) uris.push(folderUri);
    }
    if (uris.length > 0) {
      projects.push({
        id: data.id || basename(file, '.json'),
        name: data.name || basename(uriToPath(uris[0])),
        workspaceUris: uris,
      });
    }
  }
  return projects;
}

function loadPipelineConfig(wsRoot) {
  const cfgPath = join(wsRoot, '.claude', 'skills', 'pipeline-gates', 'hooks', 'config.ts');
  const cfg = {
    hasStatusGate: true,
    odooWebUrl: 'https://kaertech.com/web',
    taskUrlBase: 'https://kaertech.com/tasks/',
    ticketPrefixes: ['KIO', 'KAI'],
  };
  if (existsSync(cfgPath)) {
    try {
      const raw = readFileSync(cfgPath, 'utf-8');
      const mStatus = raw.match(/HAS_STATUS_GATE[^=]*=\s*(true|false)/);
      if (mStatus) cfg.hasStatusGate = mStatus[1] === 'true';
      const mWeb = raw.match(/ODOO_WEB_URL[^=]*=\s*["']([^"']*)["']/);
      if (mWeb) cfg.odooWebUrl = mWeb[1];
      const mTask = raw.match(/TASK_URL_BASE[^=]*=\s*["']([^"']*)["']/);
      if (mTask) cfg.taskUrlBase = mTask[1];
      const mPref = raw.match(/TICKET_PREFIXES[^=]*=\s*\[([^\]]*)\]/);
      if (mPref) {
        cfg.ticketPrefixes = [...mPref[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
      }
    } catch {}
  }
  return cfg;
}

function makeTaskKeyRegex(prefixes, globalFlag = false) {
  const keyPrefix =
    !prefixes || prefixes.length === 0
      ? '[A-Z][A-Z0-9]{1,9}'
      : `(?:${prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
  return new RegExp(`\\b${keyPrefix}-[1-9]\\d*\\b`, globalFlag ? 'g' : '');
}

function taskKeyIn(text, prefixes) {
  return makeTaskKeyRegex(prefixes, false).exec(String(text || '').toUpperCase())?.[0] || '';
}

function taskKeysIn(text, prefixes) {
  return [...new Set(String(text || '').toUpperCase().match(makeTaskKeyRegex(prefixes, true)) || [])];
}

function taskUrlIn(item, webUrl) {
  const url = /https:\/\/\S+/.exec(item)?.[0] || '';
  const base = (webUrl || '').replace(/\/+$/, '');
  return base !== '' && (url.startsWith(`${base}#`) || url.startsWith(`${base}?`))
    ? url.slice(0, 500)
    : '';
}

function newRun(task, now, hasStatusGate = true) {
  return {
    task: task || '',
    startedAt: now,
    phase: 0,
    phaseAt: PHASES.map((_, i) => (i === 0 ? now : 0)),
    status: hasStatusGate
      ? null
      : { isOpen: true, how: 'no Teams status flow in this project', at: now },
    grill: null,
    qc: null,
    qcSeq: 0,
    seq: 0,
    lastChange: 0,
    lastReview: 0,
    lastGreen: 0,
    lastTests: '',
    fixRounds: 0,
    roundSeq: 0,
    extraRounds: 0,
    tasks: [],
    blocked: [],
    isAskMuted: false,
    isDone: false,
    pr: '',
    syncedStepIndex: -1,
  };
}

function isOpen(gate) {
  return gate?.isOpen === true;
}

function closedForDev(run) {
  return ['status', 'grill'].filter((name) => !isOpen(run[name]));
}

function qcHolds(run) {
  return isOpen(run.qc) && run.qcSeq > run.lastChange;
}

function qcEvidence(run) {
  return {
    review: run.lastReview > run.lastChange,
    tests: run.lastGreen > run.lastChange,
  };
}

function qcMissing(run) {
  const ev = qcEvidence(run);
  return [
    !ev.review ? 'a review agent that finished after the last code change' : '',
    !ev.tests ? 'a green Odoo test run (more than 0 tests) after the last code change' : '',
  ].filter(Boolean);
}

function bump(run) {
  const seq = (run.seq || 0) + 1;
  return [{ ...run, seq }, seq];
}

function addTasksToRun(run, items, now, cfg) {
  let tasks = [...(run.tasks || [])];
  for (const item of items || []) {
    const key = taskKeyIn(item, cfg.ticketPrefixes);
    if (!key) continue;
    const url = taskUrlIn(item, cfg.odooWebUrl);
    const text = String(item).replace(/https?:\/\/\S+/g, ' ');
    const idx = text.toUpperCase().indexOf(key);
    const title =
      idx >= 0
        ? text
            .slice(idx + key.length)
            .replace(/^[\s:·,-]+/, '')
            .trim()
            .slice(0, 80)
        : '';
    const existingIdx = tasks.findIndex((t) => t.key === key);
    if (existingIdx === -1) {
      tasks.push({ key, title, state: 'pending', at: now, url });
    } else {
      const prev = tasks[existingIdx];
      tasks[existingIdx] = {
        ...prev,
        title: title || prev.title,
        url: url || prev.url,
      };
    }
  }
  const primaryTask = run.task || tasks[0]?.key || '';
  return { ...run, task: primaryTask, tasks };
}

function moveTasksInRun(run, keys, state, now, cfg) {
  let updated = addTasksToRun(run, keys, now, cfg);
  const wanted = new Set(keys.map((k) => taskKeyIn(k, cfg.ticketPrefixes)).filter(Boolean));
  updated.tasks = (updated.tasks || []).map((t) =>
    wanted.has(t.key) && t.state !== state ? { ...t, state, at: now } : t
  );
  return updated;
}

function openGateInRun(run, name, how, now) {
  const gate = { isOpen: true, how, at: now };
  if (name !== 'qc') return { ...run, [name]: gate };
  const [next, seq] = bump(run);
  return { ...next, qc: gate, qcSeq: seq };
}

function enterPhaseInRun(run, phase, task, now) {
  if (!Number.isInteger(phase) || phase < 0 || phase >= PHASES.length) {
    return `phase must be 0 to ${PHASES.length - 1}`;
  }
  if (phase >= 2 && closedForDev(run).length > 0) {
    const closedNames = closedForDev(run).map((n) => GATE_LABELS[n]).join(' and ');
    return `pipeline-gates: Phase ${phase} is refused while ${closedNames} closed.`;
  }
  if (phase >= 6 && !qcHolds(run)) {
    const missing = [...qcMissing(run), 'a pass recorded on QC verdict'];
    return `pipeline-gates: Phase ${phase} is refused until QC gate passes; missing: ${missing.join(', ')}.`;
  }
  const isNewCycle = phase === 2 && run.phase !== 2 && run.phase !== 3;
  return {
    ...run,
    ...(isNewCycle ? { fixRounds: 0, roundSeq: run.seq, extraRounds: 0 } : {}),
    task: task || run.task,
    phase,
    phaseAt: (run.phaseAt || PHASES.map(() => 0)).map((at, i) => (i === phase && at === 0 ? now : at)),
    isDone: phase === PHASES.length - 1,
  };
}

function recordVerdictInRun(run, verdict, summary, now) {
  if (verdict === 'blocking') {
    const [next, seq] = bump(run);
    return { ...next, qc: { isOpen: false, how: `blocking: ${summary}`, at: now }, qcSeq: seq };
  }
  if (verdict !== 'pass') return 'pipeline-gates: verdict must be pass or blocking.';
  const missing = qcMissing(run);
  if (missing.length > 0) {
    return `pipeline-gates: the pass is refused; missing: ${missing.join(', ')}.`;
  }
  const [next, seq] = bump(run);
  return { ...next, qc: { isOpen: true, how: `pass: ${summary}`, at: now }, qcSeq: seq };
}

function unwrapArg(val) {
  if (typeof val !== 'string') return val;
  if (val.startsWith('"') && val.endsWith('"')) {
    try {
      return JSON.parse(val);
    } catch {
      return val.slice(1, -1);
    }
  }
  return val;
}

function testSummaryFromOutput(output) {
  const matches = [...String(output || '').matchAll(TEST_SUMMARY_RE)];
  if (matches.length === 0) return null;
  const failed = matches.reduce((s, m) => s + Number(m[1]), 0);
  const errors = matches.reduce((s, m) => s + Number(m[2]), 0);
  const tests = matches.reduce((s, m) => s + Number(m[3]), 0);
  return {
    isGreen: failed === 0 && errors === 0 && tests > 0,
    text: `${failed} failed, ${errors} error(s) of ${tests} tests`,
  };
}

async function resolveActiveConversationId(requestedConvId, activeUris) {
  if (requestedConvId) return requestedConvId;
  const lsTrajRes = await lsrpc('GetAllCascadeTrajectories', {});
  const summariesObj = lsTrajRes?.trajectorySummaries || {};
  const allTrajs = Object.entries(summariesObj).map(([cascadeId, t]) => {
    const wsUris = [
      ...(t.workspaces || []).map((w) => w.workspaceFolderAbsoluteUri).filter(Boolean),
      ...(t.trajectoryMetadata?.workspaceUris || []),
    ];
    return {
      cascadeId,
      lastModifiedTime: t.lastModifiedTime || t.annotations?.lastUserViewTime || '',
      wsUris,
    };
  });
  const matching = allTrajs.filter(
    (t) => activeUris.length === 0 || t.wsUris.some((u) => activeUris.includes(u))
  );
  const pool = matching.length > 0 ? matching : allTrajs;
  pool.sort((a, b) => new Date(b.lastModifiedTime || 0) - new Date(a.lastModifiedTime || 0));
  return pool[0]?.cascadeId || process.env.ANTIGRAVITY_CONVERSATION_ID || '';
}

function syncRunFromTranscript(convId, cfg) {
  const runsMap = safeReadJson(RUNS_FILE) || {};
  let run = runsMap[convId] || null;
  if (!convId || !run || run.isDone) return run;

  const transcriptPath = join(BRAIN_DIR, convId, '.system_generated', 'logs', 'transcript.jsonl');
  if (!existsSync(transcriptPath)) return run;

  let changed = false;
  let lastCmdWasTest = false;
  let lastCmdWasPr = false;

  try {
    const lines = readFileSync(transcriptPath, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let step;
      try {
        step = JSON.parse(line);
      } catch {
        continue;
      }
      const stepIdx = typeof step.step_index === 'number' ? step.step_index : -1;
      if (stepIdx <= (run.syncedStepIndex ?? -1)) continue;

      const stepTime = step.created_at ? new Date(step.created_at).getTime() : Date.now();

      for (const tc of step.tool_calls || []) {
        const name = tc.name || '';
        const args = tc.args || {};

        if (
          name === 'write_file' ||
          name === 'edit_file' ||
          name === 'write_to_file' ||
          name === 'replace_file_content' ||
          name === 'multi_replace_file_content'
        ) {
          const path = unwrapArg(args.Path || args.TargetFile || '');
          if (path && WORKTREE_RE.test(path) && !DOC_PATH_RE.test(path)) {
            const [next, seq] = bump(run);
            run = { ...next, lastChange: seq };
            changed = true;
          }
        } else if (name === 'invoke_subagent') {
          const subType = unwrapArg(args.TypeName || '');
          if (subType === 'dev') {
            if (run.phase >= 2 && run.phase <= 3 && run.lastReview > (run.roundSeq || 0)) {
              const [next, seq] = bump(run);
              run = {
                ...next,
                fixRounds: (run.fixRounds || 0) + 1,
                roundSeq: seq,
                lastChange: seq,
              };
            } else {
              const [next, seq] = bump(run);
              run = { ...next, lastChange: seq };
            }
            changed = true;
          } else if (subType === 'review') {
            const [next, seq] = bump(run);
            run = { ...next, lastReview: seq };
            changed = true;
          }
        } else if (name === 'call_mcp_tool') {
          const toolName = unwrapArg(args.ToolName || '');
          if (toolName === 'send_chat_message' || toolName === 'send_channel_message') {
            if (!isOpen(run.status)) {
              run = openGateInRun(run, 'status', `sent via teams-mcp (${toolName})`, stepTime);
              changed = true;
            }
          }
        } else if (name === 'run_command') {
          const cmd = unwrapArg(args.CommandLine || '') || '';
          lastCmdWasTest = cmd.includes('--test-enable');
          lastCmdWasPr = /\bgh\s+pr\s+(?:create|new)\b/.test(cmd);
        }
      }

      if (step.type === 'GENERIC' && typeof step.content === 'string') {
        if (lastCmdWasTest) {
          const summary = testSummaryFromOutput(step.content);
          if (summary) {
            const [next, seq] = bump(run);
            run = {
              ...next,
              lastTests: summary.text,
              lastGreen: summary.isGreen ? seq : run.lastGreen,
            };
            changed = true;
          }
          lastCmdWasTest = false;
        }
        if (lastCmdWasPr) {
          const prUrl = PR_URL_RE.exec(step.content)?.[0] || '';
          if (prUrl) {
            run = { ...run, pr: prUrl };
            changed = true;
          }
          lastCmdWasPr = false;
        }
      }

      if (stepIdx > (run.syncedStepIndex ?? -1)) {
        run.syncedStepIndex = stepIdx;
        changed = true;
      }
    }
  } catch {}

  if (changed) {
    runsMap[convId] = run;
    saveRunsMap(runsMap);
  }
  return run;
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pipeline</title>
  <script src="/preload.js"></script>
  <style>
    :root {
      color-scheme: dark;
      --wi-bg: #13161f;
      --wi-fg: #f8fafc;
      --wi-text-sec: #cbd5e1;
      --wi-text-dim: #94a3b8;
      --wi-card: #1c2130;
      --wi-card-hover: #252b3d;
      --wi-border: rgba(148, 163, 184, 0.22);
      --wi-accent: #60a5fa;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0 !important;
      padding: 14px !important;
      background: var(--wi-bg) !important;
      color: var(--wi-fg) !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      line-height: 1.45;
    }
    .header {
      display: flex;
      flex-direction: column;
      gap: 9px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--wi-border);
      margin-bottom: 12px;
    }
    .title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .title {
      font-size: 15px;
      font-weight: 600;
      color: var(--wi-fg);
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .bar-row {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    input[type="text"] {
      background-color: var(--wi-card);
      color: var(--wi-fg);
      border: 1px solid var(--wi-border);
      border-radius: 6px;
      padding: 6px 9px;
      font-size: 12px;
      outline: none;
      flex: 1;
      min-width: 140px;
    }
    input::placeholder { color: var(--wi-text-dim); }
    input:focus { border-color: var(--wi-accent); }
    button {
      background: var(--wi-card);
      color: var(--wi-fg);
      border: 1px solid var(--wi-border);
      border-radius: 6px;
      padding: 4px 9px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    button:hover {
      background: var(--wi-card-hover);
      border-color: rgba(148, 163, 184, 0.45);
    }
    button.btn-primary {
      background: rgba(96, 165, 250, 0.2);
      border-color: rgba(96, 165, 250, 0.45);
      color: #93c5fd;
    }
    button.btn-ok {
      background: rgba(52, 211, 153, 0.2);
      border-color: rgba(52, 211, 153, 0.45);
      color: #6ee7b7;
    }
    button.btn-danger {
      background: rgba(248, 113, 113, 0.2);
      border-color: rgba(248, 113, 113, 0.45);
      color: #fca5a5;
    }
    .card {
      background: var(--wi-card);
      border: 1px solid var(--wi-border);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 10px;
    }
    .card-header {
      font-size: 11.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--wi-text-sec);
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      border: 1px solid transparent;
    }
    .badge-ws {
      background: rgba(96, 165, 250, 0.18);
      color: #93c5fd;
      border-color: rgba(96, 165, 250, 0.38);
    }
    .badge-ok {
      background: rgba(52, 211, 153, 0.18);
      color: #6ee7b7;
      border-color: rgba(52, 211, 153, 0.38);
    }
    .badge-amber {
      background: rgba(251, 191, 36, 0.18);
      color: #fde68a;
      border-color: rgba(251, 191, 36, 0.38);
    }
    .badge-red {
      background: rgba(248, 113, 113, 0.18);
      color: #fca5a5;
      border-color: rgba(248, 113, 113, 0.38);
    }
    .badge-muted {
      background: rgba(148, 163, 184, 0.16);
      color: #e2e8f0;
      border-color: rgba(148, 163, 184, 0.32);
    }
    .phase-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 6px;
      border-radius: 6px;
      gap: 8px;
    }
    .phase-row.current {
      background: rgba(96, 165, 250, 0.14);
      border: 1px solid rgba(96, 165, 250, 0.3);
    }
    .gate-box {
      padding: 8px 0;
      border-top: 1px solid var(--wi-border);
    }
    .gate-box:first-of-type {
      border-top: none;
      padding-top: 0;
    }
    .toast {
      position: fixed;
      bottom: 12px;
      right: 12px;
      background: #1e293b;
      color: #f8fafc;
      border: 1px solid var(--wi-accent);
      border-radius: 6px;
      padding: 7px 12px;
      font-size: 12px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      z-index: 100;
      display: none;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title-row">
      <div class="title">
        <span>Pipeline</span>
        <span id="run-badge" class="badge badge-ws">idle</span>
      </div>
      <div class="bar-row">
        <button id="end-run-btn" class="btn-danger" style="display:none;">End Run</button>
        <button id="refresh-btn">Refresh</button>
      </div>
    </div>
    <div class="bar-row">
      <input type="text" id="task-input" placeholder="Start or add tasks: KIO-1909 Short title https://..." />
      <button id="start-add-btn" class="btn-primary">Start / Add</button>
    </div>
  </div>

  <div id="band-bar"></div>
  <div id="content">Loading pipeline state...</div>
  <div id="toast" class="toast"></div>

  <script>
    const PHASES = [
      'Memory bootstrap',
      'Task reading',
      'Development',
      'QC gate',
      'Documentation',
      'Demo GIF (optional)',
      'Pull request',
      'Memory closure',
    ];

    let state = null;
    let workspaceUris = [];

    function showToast(msg) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.style.display = 'block';
      setTimeout(() => { el.style.display = 'none'; }, 3500);
    }

    function escapeHtml(s) {
      return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function formatAgo(at) {
      if (!at) return '';
      const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      return Math.floor(mins / 60) + 'h' + (mins % 60) + 'm ago';
    }

    async function loadState() {
      const res = await window.sidecar.fetch('/api/state', {
        method: 'POST',
        body: JSON.stringify({
          workspaceUris,
          conversationId: window.sidecar.conversationId || '',
        }),
      });
      state = await res.json();
      render();
    }

    async function mutate(action, payload = {}) {
      const res = await window.sidecar.fetch('/api/mutate', {
        method: 'POST',
        body: JSON.stringify({
          action,
          ...payload,
          workspaceUris,
          conversationId: window.sidecar.conversationId || '',
        }),
      });
      const out = await res.json();
      if (out.message) showToast(out.message);
      state = out.state || state;
      render();
    }

    function taskLink(task, cfg) {
      if (task.url) return task.url;
      return cfg?.taskUrlBase ? cfg.taskUrlBase + task.key : '';
    }

    function render() {
      const run = state?.run;
      const cfg = state?.config || {};
      const badgeEl = document.getElementById('run-badge');
      const endBtn = document.getElementById('end-run-btn');
      const bandEl = document.getElementById('band-bar');
      const contentEl = document.getElementById('content');

      if (!run) {
        badgeEl.textContent = 'no active run';
        badgeEl.className = 'badge badge-muted';
        endBtn.style.display = 'none';
        bandEl.innerHTML = '';
        contentEl.innerHTML = \`
          <div class="card">
            <div style="color:var(--wi-text-sec);">No pipeline run in this session.</div>
            <div style="color:var(--wi-text-dim);font-size:12px;margin-top:4px;">
              Enter a task key above (e.g. <code>\${escapeHtml((cfg.ticketPrefixes?.[0] || 'KIO') + '-1234')}</code>) and click <strong>Start / Add</strong> to start one, or invoke the <code>/pipeline</code> skill.
            </div>
          </div>\`;
        return;
      }

      const tasks = run.tasks || [];
      const counts = {
        pending: tasks.filter((t) => t.state === 'pending').length,
        active: tasks.filter((t) => t.state === 'active').length,
        done: tasks.filter((t) => t.state === 'done').length,
        total: tasks.length,
      };

      if (run.isDone) {
        badgeEl.textContent = (run.task || 'pipeline') + ' · ended';
        badgeEl.className = 'badge badge-ok';
        endBtn.style.display = 'none';
        bandEl.innerHTML = '';
        const how = run.phase === PHASES.length - 1 ? 'ended at' : 'was ended by you at';
        contentEl.innerHTML = \`
          <div class="card">
            <div style="font-weight:700;font-size:14px;">
              The pipeline run for \${escapeHtml(run.task || '(task not set)')} \${how} Phase \${run.phase} (\${escapeHtml(PHASES[run.phase])}).
            </div>
            \${counts.total > 1 ? \`<div style="color:var(--wi-text-sec);font-size:12px;margin-top:4px;">tasks: \${counts.done}/\${counts.total} done · \${counts.active} in work · \${counts.pending} pending</div>\` : ''}
            \${run.pr ? \`<div style="margin-top:6px;">PR: <a href="\${escapeHtml(run.pr)}" target="_blank" style="color:#60a5fa;">\${escapeHtml(run.pr)}</a></div>\` : ''}
            <div style="color:var(--wi-text-dim);font-size:12px;margin-top:6px;">
              Nothing is gated. Enter a new task key above to start a new run.
            </div>
          </div>\`;
        return;
      }

      const statusOpen = run.status?.isOpen === true;
      const grillOpen = run.grill?.isOpen === true;
      const qcOpen = run.qc?.isOpen === true && (run.qcSeq || 0) > (run.lastChange || 0);
      const devAllowed = statusOpen && grillOpen;
      const prAllowed = qcOpen;
      const evReview = (run.lastReview || 0) > (run.lastChange || 0);
      const evTests = (run.lastGreen || 0) > (run.lastChange || 0);
      const maxRounds = 3 + (run.extraRounds || 0);

      badgeEl.textContent = \`\${run.task || 'task?'}\${counts.total > 1 ? \` (\${counts.done}/\${counts.total})\` : ''} · P\${run.phase}\`;
      badgeEl.className = 'badge badge-ws';
      endBtn.style.display = 'inline-flex';

      // AbovePrompt style compact band
      bandEl.innerHTML = \`
        <div class="card" style="padding:8px 11px;">
          <div class="bar-row" style="justify-content:space-between;">
            <div class="bar-row">
              <span style="color:var(--wi-text-dim);font-size:12px;">pipeline</span>
              <strong>\${escapeHtml(run.task || 'task?')}</strong>
              \${counts.total > 1 ? \`<span class="badge \${counts.done === counts.total ? 'badge-ok' : 'badge-ws'}">\${counts.done}/\${counts.total}</span>\` : ''}
              <span style="font-size:12px;color:var(--wi-text-sec);">\${run.phase} \${escapeHtml(PHASES[run.phase])}</span>
            </div>
            <div class="bar-row">
              <span class="badge \${statusOpen ? 'badge-ok' : 'badge-amber'}">status \${statusOpen ? '✓' : '○'}</span>
              <span class="badge \${grillOpen ? 'badge-ok' : 'badge-amber'}">grill \${grillOpen ? '✓' : '○'}</span>
              <span class="badge \${qcOpen ? 'badge-ok' : 'badge-amber'}">qc \${qcOpen ? '✓' : '○'}</span>
            </div>
          </div>
          <div style="font-size:11.5px;color:var(--wi-text-dim);margin-top:4px;">
            started \${formatAgo(run.startedAt)} · dev <strong>\${devAllowed ? 'allowed' : 'gated'}</strong> · PR <strong>\${prAllowed ? 'allowed' : 'gated'}</strong>
          </div>
        </div>\`;

      let html = '';

      // 1. Tasks Card (shown whenever tasks exist)
      if (tasks.length > 0) {
        const blocks =
          '<span style="color:#34d399;">' + '■'.repeat(counts.done) + '</span>' +
          '<span style="color:#60a5fa;">' + '■'.repeat(counts.active) + '</span>' +
          '<span style="color:#64748b;">' + '□'.repeat(counts.pending) + '</span>';

        html += \`
          <div class="card">
            <div class="card-header">
              <span>Tasks (\${counts.done}/\${counts.total} done · \${counts.active} in work · \${counts.pending} pending)</span>
              <span style="font-family:monospace;letter-spacing:1px;">\${blocks}</span>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px;">
              \${tasks.map((t) => {
                const link = taskLink(t, cfg);
                const glyph = t.state === 'done' ? '✓' : t.state === 'active' ? '●' : '○';
                const color = t.state === 'done' ? '#34d399' : t.state === 'active' ? '#60a5fa' : '#94a3b8';
                return \`
                  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:4px 0;border-top:1px dashed rgba(148,163,184,0.14);">
                    <div class="bar-row">
                      <span style="color:\${color};font-weight:700;">\${glyph}</span>
                      <strong style="color:\${t.state === 'pending' ? 'var(--wi-text-dim)' : 'var(--wi-fg)'};">\${escapeHtml(t.key)}</strong>
                      \${t.title ? \`<span style="color:var(--wi-text-sec);font-size:12px;">\${escapeHtml(t.title)}</span>\` : ''}
                      \${t.state !== 'pending' ? \`<span style="color:var(--wi-text-dim);font-size:11px;">\${t.state === 'done' ? 'done' : 'in work'} \${formatAgo(t.at)}</span>\` : ''}
                    </div>
                    <div class="bar-row">
                      \${link ? \`<button class="open-url-btn" data-url="\${escapeHtml(link)}">open in Odoo</button>\` : ''}
                      \${t.state !== 'active' ? \`<button class="task-state-btn" data-key="\${escapeHtml(t.key)}" data-state="active">active</button>\` : ''}
                      \${t.state !== 'done' ? \`<button class="task-state-btn btn-ok" data-key="\${escapeHtml(t.key)}" data-state="done">done</button>\` : ''}
                      \${t.state !== 'pending' ? \`<button class="task-state-btn" data-key="\${escapeHtml(t.key)}" data-state="pending">pending</button>\` : ''}
                    </div>
                  </div>\`;
              }).join('')}
            </div>
          </div>\`;
      }

      // 2. Gates Card
      html += \`
        <div class="card">
          <div class="card-header"><span>Gates</span></div>

          <div class="gate-box">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
              <div class="bar-row">
                <span style="color:\${statusOpen ? '#34d399' : '#fbbf24'};font-weight:700;">\${statusOpen ? '✓' : '○'}</span>
                <strong>Teams status</strong>
                <span style="color:var(--wi-text-dim);font-size:12px;">\${run.status ? \`\${escapeHtml(run.status.how)} · \${formatAgo(run.status.at)}\` : 'closed'}</span>
              </div>
              \${!statusOpen ? \`<button class="open-gate-btn" data-gate="status">open manually</button>\` : ''}
            </div>
          </div>

          <div class="gate-box">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
              <div class="bar-row">
                <span style="color:\${grillOpen ? '#34d399' : '#fbbf24'};font-weight:700;">\${grillOpen ? '✓' : '○'}</span>
                <strong>grill alignment</strong>
                <span style="color:var(--wi-text-dim);font-size:12px;">\${run.grill ? \`\${escapeHtml(run.grill.how)} · \${formatAgo(run.grill.at)}\` : 'closed'}</span>
              </div>
            </div>
            \${!grillOpen ? \`
              <div class="bar-row" style="margin-top:6px;padding-left:16px;">
                <span style="color:var(--wi-text-sec);font-size:12px;">after you agree with the Alignment Summary:</span>
                <button id="grill-confirm-btn" class="btn-ok">confirm</button>
                <button id="grill-mechanical-btn" class="btn-primary">mechanical</button>
              </div>
            \` : ''}
          </div>

          <div class="gate-box">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
              <div class="bar-row">
                <span style="color:\${qcOpen ? '#34d399' : '#fbbf24'};font-weight:700;">\${qcOpen ? '✓' : '○'}</span>
                <strong>QC verdict</strong>
                <span style="color:var(--wi-text-dim);font-size:12px;">\${run.qc ? \`\${escapeHtml(run.qc.how)} · \${formatAgo(run.qc.at)}\${!qcOpen && run.qc.isOpen ? ' (voided by later edit)' : ''}\` : 'closed'}</span>
              </div>
              <div class="bar-row">
                \${!qcOpen ? \`<button id="qc-pass-btn" class="btn-ok">record pass</button>\` : ''}
                \${!qcOpen ? \`<button class="open-gate-btn" data-gate="qc">force open</button>\` : ''}
              </div>
            </div>
            <div style="padding-left:16px;margin-top:5px;font-size:12px;color:var(--wi-text-sec);display:flex;flex-direction:column;gap:3px;">
              <div>since the last code change: review <strong style="color:\${evReview ? '#34d399' : '#fbbf24'};">\${evReview ? '✓' : '○'}</strong> · green tests <strong style="color:\${evTests ? '#34d399' : '#fbbf24'};">\${evTests ? '✓' : '○'}</strong></div>
              \${run.lastTests ? \`<div style="color:var(--wi-text-dim);">last test run: \${escapeHtml(run.lastTests)}</div>\` : ''}
              <div class="bar-row" style="margin-top:2px;">
                <span>fix rounds: <strong>\${run.fixRounds || 0} of \${maxRounds}</strong></span>
                <button id="grant-rounds-btn">+3 rounds</button>
              </div>
            </div>
          </div>
        </div>\`;

      // 3. Phases Card
      html += \`
        <div class="card">
          <div class="card-header"><span>Phases</span></div>
          <div style="display:flex;flex-direction:column;gap:3px;">
            \${PHASES.map((name, i) => {
              const reached = (run.phaseAt?.[i] || 0) > 0;
              const isSkipped = i < run.phase && !reached;
              const isCurrent = i === run.phase;
              const glyph = isSkipped ? '–' : i < run.phase ? '✓' : isCurrent ? '●' : '○';
              const color = i < run.phase && !isSkipped ? '#34d399' : isCurrent ? '#60a5fa' : '#94a3b8';
              return \`
                <div class="phase-row \${isCurrent ? 'current' : ''}">
                  <div class="bar-row">
                    <span style="color:\${color};font-weight:700;width:14px;display:inline-block;">\${glyph}</span>
                    <span style="font-weight:\${isCurrent ? '700' : '400'};color:\${i > run.phase || isSkipped ? 'var(--wi-text-dim)' : 'var(--wi-fg)'};">
                      \${i} \${escapeHtml(name)}\${isSkipped ? ' · skipped' : ''}
                    </span>
                    \${reached ? \`<span style="color:var(--wi-text-dim);font-size:11px;">\${formatAgo(run.phaseAt[i])}</span>\` : ''}
                  </div>
                  \${!isCurrent ? \`<button class="phase-btn" data-phase="\${i}" style="padding:2px 7px;font-size:11px;">enter</button>\` : ''}
                </div>\`;
            }).join('')}
          </div>
        </div>\`;

      // 4. Blocked Card
      if ((run.blocked || []).length > 0) {
        html += \`
          <div class="card">
            <div class="card-header"><span>Blocked Attempts</span></div>
            <div style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--wi-text-sec);">
              \${run.blocked.map((b) => \`<div><span style="color:var(--wi-text-dim);">\${formatAgo(b.at)}</span>  \${escapeHtml(b.what)}</div>\`).join('')}
            </div>
          </div>\`;
      }

      contentEl.innerHTML = html;

      // Bind handlers
      const grillConfirm = document.getElementById('grill-confirm-btn');
      if (grillConfirm) {
        grillConfirm.onclick = () => mutate('confirm_grill', { how: 'confirmed by you' });
      }
      const grillMech = document.getElementById('grill-mechanical-btn');
      if (grillMech) {
        grillMech.onclick = () =>
          mutate('confirm_grill', { how: 'mechanical task, grill skipped by you' });
      }
      const qcPassBtn = document.getElementById('qc-pass-btn');
      if (qcPassBtn) {
        qcPassBtn.onclick = () =>
          mutate('qc_verdict', { verdict: 'pass', summary: 'verified in Pipeline panel' });
      }
      const grantRoundsBtn = document.getElementById('grant-rounds-btn');
      if (grantRoundsBtn) {
        grantRoundsBtn.onclick = () =>
          mutate('grant_rounds', { reason: 'granted in Pipeline panel' });
      }
      document.querySelectorAll('.open-gate-btn').forEach((btn) => {
        btn.onclick = () => {
          const gate = btn.dataset.gate;
          mutate('open_gate', { gate, reason: 'opened manually in Pipeline panel' });
        };
      });
      document.querySelectorAll('.phase-btn').forEach((btn) => {
        btn.onclick = () => mutate('enter_phase', { phase: Number(btn.dataset.phase) });
      });
      document.querySelectorAll('.task-state-btn').forEach((btn) => {
        btn.onclick = () =>
          mutate('move_task', { key: btn.dataset.key, taskState: btn.dataset.state });
      });
      document.querySelectorAll('.open-url-btn').forEach((btn) => {
        btn.onclick = () => mutate('open_url', { url: btn.dataset.url });
      });
    }

    document.getElementById('start-add-btn').onclick = () => {
      const val = document.getElementById('task-input').value.trim();
      if (!val) return;
      document.getElementById('task-input').value = '';
      mutate('start_or_add', { text: val });
    };
    document.getElementById('task-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('start-add-btn').click();
    });
    document.getElementById('end-run-btn').onclick = () => mutate('end_run');
    document.getElementById('refresh-btn').onclick = () => loadState();

    window.sidecar.onWorkspaceChange((uris) => {
      if (Array.isArray(uris) && uris.length > 0) {
        workspaceUris = uris;
        loadState();
      }
    });

    (async () => {
      const uris = await window.sidecar.getWorkspaceUris();
      if (Array.isArray(uris) && uris.length > 0) workspaceUris = uris;
      await loadState();
      setInterval(() => loadState(), 10000);
    })();
  </script>
</body>
</html>`;

function resolveWorkspaceRoot(requestedUris = []) {
  const projects = loadKnownProjects();
  let activeUris = Array.isArray(requestedUris) && requestedUris.length > 0 ? requestedUris : [];
  if (activeUris.length === 0 && projects.length > 0) {
    activeUris = projects[0].workspaceUris;
  }
  const wsPaths = activeUris.map(uriToPath).filter(Boolean);
  return {
    wsRoot: wsPaths[0] || process.cwd(),
    activeUris,
  };
}

async function getFullState(requestedUris, requestedConvId) {
  const { wsRoot, activeUris } = resolveWorkspaceRoot(requestedUris);
  const convId = await resolveActiveConversationId(requestedConvId, activeUris);
  const cfg = loadPipelineConfig(wsRoot);
  const run = syncRunFromTranscript(convId, cfg);
  return {
    workspaceName: basename(wsRoot),
    conversationId: convId,
    config: cfg,
    run,
  };
}

const app = new SidecarApp();

app.page('/', () => HTML);

app.api('/api/state', async (data) => {
  return await getFullState(data?.workspaceUris, data?.conversationId);
});

app.api('/api/mutate', async (data) => {
  const { wsRoot, activeUris } = resolveWorkspaceRoot(data?.workspaceUris);
  const convId = await resolveActiveConversationId(data?.conversationId, activeUris);
  const cfg = loadPipelineConfig(wsRoot);
  const runsMap = safeReadJson(RUNS_FILE) || {};
  let current = runsMap[convId] || null;
  const now = Date.now();
  const action = String(data?.action || '');
  let message = '';

  if (action === 'open_url') {
    const url = String(data?.url || '');
    if (url.startsWith('https://') || url.startsWith('http://')) {
      try {
        await execFileAsync('xdg-open', [url], { timeout: 5000 });
      } catch {}
    }
    return { message: `Opened ${url}`, state: await getFullState(activeUris, convId) };
  }

  if (action === 'start_or_add') {
    const rawText = String(data?.text || '').trim();
    const keys = taskKeysIn(rawText, cfg.ticketPrefixes);
    const items = keys.length > 1 ? keys : [rawText];
    const primaryKey = keys[0] || rawText.split(/\s+/)[0]?.toUpperCase().slice(0, 40) || 'PIPELINE';
    if (!current || current.isDone) {
      current = addTasksToRun(newRun(primaryKey, now, cfg.hasStatusGate), items, now, cfg);
      message = `Started pipeline run for ${current.task}`;
    } else {
      current = addTasksToRun(current, items, now, cfg);
      message = `Added task(s) to pipeline ${current.task}`;
    }
    runsMap[convId] = current;
    saveRunsMap(runsMap);
  } else if (action === 'end_run') {
    if (current && !current.isDone) {
      current = { ...current, isDone: true };
      runsMap[convId] = current;
      saveRunsMap(runsMap);
      message = 'Pipeline run ended; nothing is gated any more.';
    }
  } else if (action === 'confirm_grill') {
    if (current && !current.isDone) {
      const how = String(data?.how || 'confirmed by you');
      current = openGateInRun(current, 'grill', how, now);
      runsMap[convId] = current;
      saveRunsMap(runsMap);
      message = `Grill gate open (${how})`;
    }
  } else if (action === 'open_gate') {
    const gate = String(data?.gate || '');
    const reason = String(data?.reason || 'opened by you');
    if (current && !current.isDone && ['status', 'grill', 'qc'].includes(gate)) {
      current = openGateInRun(current, gate, `opened by you: ${reason}`, now);
      runsMap[convId] = current;
      saveRunsMap(runsMap);
      message = `${GATE_LABELS[gate]} gate opened`;
    }
  } else if (action === 'qc_verdict') {
    if (current && !current.isDone) {
      const res = recordVerdictInRun(
        current,
        String(data?.verdict || 'pass'),
        String(data?.summary || 'pass'),
        now
      );
      if (typeof res === 'string') {
        message = res;
      } else {
        current = res;
        runsMap[convId] = current;
        saveRunsMap(runsMap);
        message = 'QC verdict recorded: pass';
      }
    }
  } else if (action === 'grant_rounds') {
    if (current && !current.isDone) {
      current = { ...current, extraRounds: (current.extraRounds || 0) + MAX_FIX_ROUNDS };
      runsMap[convId] = current;
      saveRunsMap(runsMap);
      message = `Granted +3 fix rounds (now ${current.fixRounds || 0} of ${3 + current.extraRounds})`;
    }
  } else if (action === 'enter_phase') {
    if (current && !current.isDone) {
      const entered = enterPhaseInRun(current, Number(data?.phase), '', now);
      if (typeof entered === 'string') {
        current = {
          ...current,
          blocked: [{ what: `Phase ${data?.phase}`, at: now }, ...(current.blocked || [])].slice(0, 5),
        };
        runsMap[convId] = current;
        saveRunsMap(runsMap);
        message = entered;
      } else {
        current = entered;
        runsMap[convId] = current;
        saveRunsMap(runsMap);
        message = `Entered Phase ${current.phase}: ${PHASES[current.phase]}`;
      }
    }
  } else if (action === 'move_task') {
    if (current && !current.isDone) {
      const key = String(data?.key || '');
      const taskState = String(data?.taskState || 'active');
      current = moveTasksInRun(current, [key], taskState, now, cfg);
      runsMap[convId] = current;
      saveRunsMap(runsMap);
      message = `${key} -> ${taskState}`;
    }
  }

  return {
    message,
    state: await getFullState(activeUris, convId),
  };
});

await app.run();
