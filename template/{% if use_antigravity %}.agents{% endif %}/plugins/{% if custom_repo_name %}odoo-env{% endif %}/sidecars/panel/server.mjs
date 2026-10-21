import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, watchFile } from 'node:fs';
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
// wt-stop and a restoring wt-start wait out a wt-test run on the env (its test.lock). A kill ends
// only bash: its children run on while the script's later steps (service restart, teardown) are lost.
const WT_SCRIPT_TIMEOUT_MS = 60 * 60 * 1000;

const WT_PATH_RE = /\.worktrees\/([A-Za-z0-9][A-Za-z0-9._-]*)/g;
const WT_SCRIPT_RE = /\bwt-(?:start|stop|bootstrap|restore|link)\.sh\s+([A-Za-z0-9][A-Za-z0-9._-]*)/g;
const GIT_WRITE_RE =
  /\bgit\b((?:\s+-[Cc]\s+\S+)*)\s+(?:commit|checkout|switch|pull|push|merge|rebase|reset|stash|cherry-pick|revert|am|apply|add|rm|mv|restore)\b/g;

function enrichedEnv(extra = {}) {
  const nixPaths = [
    join(HOME, '.nix-profile', 'bin'),
    '/nix/var/nix/profiles/default/bin',
    join(HOME, '.local', 'bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  const currentPath = process.env.PATH || '';
  return {
    ...process.env,
    PATH: [...nixPaths, currentPath].filter(Boolean).join(':'),
    ...extra,
  };
}

async function runCmd(bin, args, cwd, timeout = 10000) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd: cwd || process.cwd(),
      env: enrichedEnv(),
      timeout,
      maxBuffer: 5 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: stdout || '', stderr: stderr || '' };
  } catch (err) {
    return {
      exitCode: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || String(err),
    };
  }
}

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

function loadEnvConfig(wsRoot) {
  const cfg = {
    answersFile: '.copier-answers.yml',
    addons: 'src/odoo-addons-16',
    addonsBranch: '16.0',
    envBranches: ['main', 'master'],
    serviceSuffix: '',
    pgPort: '16432',
  };
  const cfgPath = join(wsRoot, '.claude', 'skills', 'odoo-env-band', 'hooks', 'config.ts');
  if (existsSync(cfgPath)) {
    try {
      const raw = readFileSync(cfgPath, 'utf-8');
      const mAddons = raw.match(/ADDONS\s*=\s*['"]([^'"]+)['"]/);
      if (mAddons) cfg.addons = mAddons[1];
      const mBranch = raw.match(/ADDONS_BRANCH\s*=\s*['"]([^'"]+)['"]/);
      if (mBranch) cfg.addonsBranch = mBranch[1];
      const mSuffix = raw.match(/SERVICE_SUFFIX\s*=\s*['"]([^'"]*)['"]/);
      if (mSuffix) cfg.serviceSuffix = mSuffix[1];
      const mPg = raw.match(/pg:\s*['"]([^'"]+)['"]/);
      if (mPg) cfg.pgPort = mPg[1];
    } catch {}
  }
  return cfg;
}

function parseGitStatus(out) {
  let branch = '?';
  let oid = '';
  let ahead = 0;
  let behind = 0;
  let hasUpstream = false;
  let dirty = 0;
  const changedFiles = [];

  for (const line of String(out || '').split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length).trim();
    else if (line.startsWith('# branch.oid ')) oid = line.slice('# branch.oid '.length).trim();
    else if (line.startsWith('# branch.upstream ')) hasUpstream = true;
    else if (line.startsWith('# branch.ab ')) {
      const ab = /\+(\d+) -(\d+)/.exec(line);
      if (ab) {
        ahead = Number(ab[1]);
        behind = Number(ab[2]);
      }
    } else if (line !== '' && !line.startsWith('#')) {
      dirty += 1;
      const parts = line.trim().split(/\s+/);
      const file = parts[parts.length - 1] || line;
      if (changedFiles.length < 25) changedFiles.push(file);
    }
  }
  if (branch === '(detached)') branch = oid.slice(0, 8) || 'detached';
  return { branch, dirty, ahead, behind, hasUpstream, changedFiles };
}

async function gitStatus(dir) {
  if (!existsSync(dir)) return null;
  const run = await runCmd('git', ['-C', dir, 'status', '--porcelain=v2', '--branch'], dir, 5000);
  return run.exitCode === 0 ? parseGitStatus(run.stdout) : null;
}

function wtDb(slug) {
  return `wt_${slug.replace(/-/g, '_')}`;
}

function slugsIn(text) {
  const s = String(text || '');
  return [...s.matchAll(WT_PATH_RE), ...s.matchAll(WT_SCRIPT_RE)]
    .map((m) => m[1] || '')
    .filter((slug) => slug !== '' && slug !== '_env');
}

function classifyPath(pathStr, wsRoot, addonsRel) {
  const project = `${wsRoot.replace(/\/+$/, '')}/`;
  const target = `${String(pathStr || '').replace(/\/+$/, '')}/`;
  if (!target.startsWith(project)) return { env: false, addons: false, wts: [] };
  const wts = slugsIn(target);
  if (wts.length > 0) return { env: false, addons: false, wts };
  if (target.startsWith(`${project}${addonsRel}/`)) return { env: false, addons: true, wts: [] };
  if (target.startsWith(`${project}src/`) || target.startsWith(`${project}.worktrees/`)) {
    return { env: false, addons: false, wts: [] };
  }
  return { env: true, addons: false, wts: [] };
}

function mergeTouched(a, b) {
  return {
    env: Boolean(a.env || b.env),
    addons: Boolean(a.addons || b.addons),
    wts: [...a.wts, ...(b.wts || []).filter((s) => !a.wts.includes(s))],
  };
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

function scanTouchedFromTranscript(convId, wsRoot, cfg) {
  let touched = { env: false, addons: false, wts: [] };
  if (!convId) return touched;
  const transcriptPath = join(BRAIN_DIR, convId, '.system_generated', 'logs', 'transcript.jsonl');
  if (!existsSync(transcriptPath)) return touched;

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
          const p = unwrapArg(args.Path || args.TargetFile || '');
          if (p) touched = mergeTouched(touched, classifyPath(p, wsRoot, cfg.addons));
        } else if (name === 'run_command') {
          const cmd = unwrapArg(args.CommandLine || '') || '';
          touched = mergeTouched(touched, { env: false, addons: false, wts: slugsIn(cmd) });
          for (const match of cmd.matchAll(GIT_WRITE_RE)) {
            const rawDir = /-C\s+(\S+)/.exec(match[1] || '')?.[1];
            const resolvedDir = rawDir
              ? rawDir
                  .replace(/^["']|["']$/g, '')
                  .replace(/^\$\{?ODOO\d*_PROJECT_DIR\}?/, wsRoot)
              : wsRoot;
            const fullDir = resolvedDir.startsWith('/') ? resolvedDir : join(wsRoot, resolvedDir);
            touched = mergeTouched(touched, classifyPath(fullDir, wsRoot, cfg.addons));
          }
        }
      }
    }
  } catch {}
  return touched;
}

async function collectEnvSnapshot(wsRoot, cfg, touched) {
  const envRoot = join(wsRoot, '.worktrees', '_env');
  const slugs = existsSync(envRoot)
    ? readdirSync(envRoot)
        .filter((name) => {
          try {
            return statSync(join(envRoot, name)).isDirectory();
          } catch {
            return false;
          }
        })
        .sort()
    : [];

  const ports = slugs.map((slug) => {
    try {
      return readFileSync(join(envRoot, slug, 'port'), 'utf-8').trim();
    } catch {
      return '?';
    }
  });

  const pgUnit = `postgres${cfg.serviceSuffix}.service`;
  const wtUnit = (slug) => `odoo${cfg.serviceSuffix}-wt@${slug}.service`;
  const units = [pgUnit, ...slugs.map(wtUnit)];

  const systemctlRes = await runCmd('systemctl', ['--user', 'is-active', ...units], wsRoot, 5000);
  const states = (systemctlRes.stdout || '').split('\n').map((l) => l.trim());
  const activeMap = Object.fromEntries(units.map((u, i) => [u, states[i] === 'active']));

  const [envGit, addonsGit, ...wtGits] = await Promise.all([
    gitStatus(wsRoot),
    gitStatus(join(wsRoot, cfg.addons)),
    ...slugs.map((slug) => gitStatus(join(wsRoot, '.worktrees', slug))),
  ]);

  const services = [
    {
      name: 'pg',
      unit: pgUnit,
      port: cfg.pgPort,
      isActive: activeMap[pgUnit] === true,
    },
  ];

  const wts = slugs.map((slug, i) => {
    const db = wtDb(slug);
    const port = ports[i] || '?';
    const address = `${db}.localhost:${port}`;
    return {
      slug,
      port,
      db,
      unit: wtUnit(slug),
      isActive: activeMap[wtUnit(slug)] === true,
      isMine: touched.wts.includes(slug),
      git: wtGits[i] || null,
      address,
      webUrl: `http://${address}/web`,
    };
  });

  // Sort session's own worktrees first
  wts.sort((a, b) => (a.isMine === b.isMine ? a.slug.localeCompare(b.slug) : a.isMine ? -1 : 1));

  return {
    workspaceName: basename(wsRoot),
    config: cfg,
    touched,
    services,
    envCheckout: {
      label: 'env',
      path: wsRoot,
      defaults: cfg.envBranches,
      isMine: touched.env,
      git: envGit,
    },
    addonsCheckout: {
      label: 'addons',
      path: join(wsRoot, cfg.addons),
      defaults: [cfg.addonsBranch],
      isMine: touched.addons,
      git: addonsGit,
    },
    wts,
  };
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Odoo Env & Worktrees</title>
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
    .card.mine {
      border-color: rgba(96, 165, 250, 0.5);
    }
    .section-header {
      font-size: 11.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--wi-text-sec);
      margin: 12px 0 8px 0;
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
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px;
      color: var(--wi-text-dim);
      word-break: break-all;
    }
    details {
      margin-top: 6px;
      border-top: 1px solid var(--wi-border);
      padding-top: 6px;
    }
    summary {
      cursor: pointer;
      font-size: 11.5px;
      color: #93c5fd;
      user-select: none;
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
        <span>Odoo Env & Worktrees</span>
        <span id="ws-badge" class="badge badge-ws">loading...</span>
      </div>
      <div class="bar-row">
        <button id="refresh-btn">Refresh</button>
      </div>
    </div>
    <div class="bar-row">
      <input type="text" id="wt-slug-input" placeholder="Start worktree env by slug (e.g. kio-1910-fix)..." />
      <button id="wt-start-btn" class="btn-primary">+ Start WT Env</button>
    </div>
  </div>

  <div id="band-bar"></div>
  <div id="content">Loading environment status...</div>
  <div id="toast" class="toast"></div>

  <script>
    let state = null;
    let workspaceUris = [];
    let armedWtStop = null;
    let busyKey = null;

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

    function renderGitInline(git, defaults = [], isWorktree = false) {
      if (!git) return '<span style="color:#f87171;">no git</span>';
      const isDefault = defaults.includes(git.branch);
      const branchLabel =
        git.hasUpstream || isDefault || isWorktree ? git.branch : git.branch + ' (local)';
      const branchColor = isDefault ? 'var(--wi-fg)' : '#22d3ee';
      const cleanHtml =
        git.dirty > 0
          ? \`<span style="color:#fbbf24;">±\${git.dirty} changed</span>\`
          : '<span style="color:#34d399;">✓ clean</span>';
      const aheadHtml = git.ahead > 0 ? \` <span style="color:var(--wi-text-dim);">↑\${git.ahead} ahead</span>\` : '';
      const behindHtml = git.behind > 0 ? \` <span style="color:#fbbf24;">↓\${git.behind} behind</span>\` : '';
      return \`<strong style="color:\${branchColor};">\${escapeHtml(branchLabel)}</strong> \${cleanHtml}\${aheadHtml}\${behindHtml}\`;
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

    async function doAction(action, payload = {}, key = '') {
      busyKey = key || action;
      armedWtStop = null;
      render();
      try {
        const res = await window.sidecar.fetch('/api/action', {
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
      } finally {
        busyKey = null;
        render();
      }
    }

    function render() {
      if (!state) return;
      document.getElementById('ws-badge').textContent = state.workspaceName || 'kaertech-odoo-16';

      const pg = state.services?.[0];
      const mineWts = (state.wts || []).filter((w) => w.isMine);
      const otherWts = (state.wts || []).filter((w) => !w.isMine);

      // 1. Exact odoo-env-band AbovePrompt bar at the top
      const bandSegments = [];
      if (pg) {
        bandSegments.push(
          \`<span style="color:\${pg.isActive ? '#34d399' : '#f87171'};font-weight:600;">\${escapeHtml(pg.name)} :\${escapeHtml(pg.port)} \${pg.isActive ? '●' : '○'}</span>\`
        );
      }
      if (state.envCheckout?.git) {
        bandSegments.push(
          \`<span><span style="color:var(--wi-text-dim);">env</span> \${renderGitInline(state.envCheckout.git, state.envCheckout.defaults, false)}</span>\`
        );
      }
      if (state.addonsCheckout?.git) {
        bandSegments.push(
          \`<span><span style="color:var(--wi-text-dim);">addons</span> \${renderGitInline(state.addonsCheckout.git, state.addonsCheckout.defaults, false)}</span>\`
        );
      }
      for (const wt of mineWts) {
        bandSegments.push(
          \`<span><span style="color:var(--wi-text-dim);">wt</span> <span style="color:\${wt.isActive ? '#34d399' : 'var(--wi-text-dim)'};">:\${escapeHtml(wt.port)} \${wt.isActive ? '● up' : '○ down'}</span> \${renderGitInline(wt.git, [state.config?.addonsBranch || '16.0'], true)}</span>\`
        );
      }
      if (otherWts.length > 0) {
        bandSegments.push(
          \`<span style="color:var(--wi-text-dim);">\${otherWts.length} wt env\${otherWts.length === 1 ? '' : 's'}</span>\`
        );
      }

      document.getElementById('band-bar').innerHTML = \`
        <div class="card" style="padding:8px 11px;">
          <div class="bar-row" style="font-size:12px;">
            \${bandSegments.join(' <span style="color:var(--wi-text-dim);">│</span> ')}
          </div>
        </div>\`;

      let html = '';

      // 2. Services & Checkouts
      html += \`<div class="section-header"><span>Cluster Services & Checkouts</span></div>\`;
      if (pg) {
        const isBusy = busyKey === pg.unit;
        html += \`
          <div class="card">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
              <div class="bar-row">
                <strong>PostgreSQL (\${escapeHtml(pg.unit)})</strong>
                <span class="badge \${pg.isActive ? 'badge-ok' : 'badge-red'}">\${pg.isActive ? '● active' : '○ inactive'} · :\${escapeHtml(pg.port)}</span>
              </div>
              <div class="bar-row">
                \${isBusy ? '<span style="color:var(--wi-text-dim);font-size:12px;">working…</span>' : \`
                  \${!pg.isActive ? \`<button class="svc-btn btn-ok" data-unit="\${escapeHtml(pg.unit)}" data-op="start">Start</button>\` : ''}
                  <button class="svc-btn" data-unit="\${escapeHtml(pg.unit)}" data-op="restart">Restart</button>
                  \${pg.isActive ? \`<button class="svc-btn btn-danger" data-unit="\${escapeHtml(pg.unit)}" data-op="stop">Stop</button>\` : ''}
                \`}
              </div>
            </div>
          </div>\`;
      }

      for (const co of [state.envCheckout, state.addonsCheckout].filter(Boolean)) {
        const g = co.git;
        html += \`
          <div class="card \${co.isMine ? 'mine' : ''}">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
              <div class="bar-row">
                <span class="badge badge-muted">\${escapeHtml(co.label)}</span>
                \${renderGitInline(g, co.defaults, false)}
                \${co.isMine ? '<span class="badge badge-ws">touched this session</span>' : ''}
              </div>
            </div>
            <div class="mono" style="margin-top:4px;">\${escapeHtml(co.path)}</div>
            \${g?.changedFiles?.length ? \`
              <details>
                <summary>Show \${g.changedFiles.length} changed file(s)</summary>
                <div class="mono" style="margin-top:5px;display:flex;flex-direction:column;gap:2px;">
                  \${g.changedFiles.map((f) => \`<div>• \${escapeHtml(f)}</div>\`).join('')}
                </div>
              </details>
            \` : ''}
          </div>\`;
      }

      // 3. Worktree Environments
      const wts = state.wts || [];
      html += \`
        <div class="section-header">
          <span>Worktree Environments (.worktrees/_env)</span>
          <span>\${wts.length}</span>
        </div>\`;

      if (wts.length === 0) {
        html += \`<div class="card"><div style="color:var(--wi-text-dim);">No active worktree environments. Enter a slug above to start one.</div></div>\`;
      }

      for (const wt of wts) {
        const isBusy = busyKey === wt.slug || busyKey === wt.unit;
        const g = wt.git;
        html += \`
          <div class="card \${wt.isMine ? 'mine' : ''}">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
              <div class="bar-row">
                <strong style="font-size:13.5px;">\${escapeHtml(wt.slug)}</strong>
                <span class="badge \${wt.isActive ? 'badge-ok' : 'badge-muted'}">:\${escapeHtml(wt.port)} \${wt.isActive ? '● up' : '○ down'}</span>
                \${wt.isMine ? '<span class="badge badge-ws">this session</span>' : ''}
              </div>
              <div class="bar-row">
                <button class="open-web-btn btn-primary" data-url="\${escapeHtml(wt.webUrl)}">\${escapeHtml(wt.address)}</button>
              </div>
            </div>

            <div class="bar-row" style="margin-top:6px;font-size:12px;">
              \${renderGitInline(g, [state.config?.addonsBranch || '16.0'], true)}
              <span class="badge badge-muted">DB: \${escapeHtml(wt.db)}</span>
            </div>

            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:8px;padding-top:7px;border-top:1px dashed rgba(148,163,184,0.16);">
              <span class="mono">\${escapeHtml(wt.unit)}</span>
              \${isBusy ? '<span style="color:var(--wi-text-dim);font-size:12px;">working…</span>' : armedWtStop === wt.slug ? \`
                <div class="bar-row">
                  <span style="color:#fbbf24;font-size:12px;font-weight:600;">tear down \${escapeHtml(wt.slug)}?</span>
                  <button class="wt-stop-confirm-btn btn-danger" data-slug="\${escapeHtml(wt.slug)}">yes, remove</button>
                  <button class="wt-stop-cancel-btn">no</button>
                </div>
              \` : \`
                <div class="bar-row">
                  \${!wt.isActive ? \`<button class="svc-btn btn-ok" data-unit="\${escapeHtml(wt.unit)}" data-op="start">Start</button>\` : ''}
                  <button class="svc-btn" data-unit="\${escapeHtml(wt.unit)}" data-op="restart">Restart</button>
                  \${wt.isActive ? \`<button class="svc-btn" data-unit="\${escapeHtml(wt.unit)}" data-op="stop">Stop</button>\` : ''}
                  <button class="wt-stop-arm-btn btn-danger" data-slug="\${escapeHtml(wt.slug)}">Tear Down</button>
                </div>
              \`}
            </div>

            \${g?.changedFiles?.length ? \`
              <details>
                <summary>Show \${g.changedFiles.length} changed file(s) in worktree</summary>
                <div class="mono" style="margin-top:5px;display:flex;flex-direction:column;gap:2px;">
                  \${g.changedFiles.map((f) => \`<div>• \${escapeHtml(f)}</div>\`).join('')}
                </div>
              </details>
            \` : ''}
          </div>\`;
      }

      document.getElementById('content').innerHTML = html;

      document.querySelectorAll('.svc-btn').forEach((btn) => {
        btn.onclick = () =>
          doAction('systemctl', { unit: btn.dataset.unit, op: btn.dataset.op }, btn.dataset.unit);
      });
      document.querySelectorAll('.open-web-btn').forEach((btn) => {
        btn.onclick = () => doAction('open_url', { url: btn.dataset.url });
      });
      document.querySelectorAll('.wt-stop-arm-btn').forEach((btn) => {
        btn.onclick = () => {
          armedWtStop = btn.dataset.slug;
          render();
        };
      });
      document.querySelectorAll('.wt-stop-cancel-btn').forEach((btn) => {
        btn.onclick = () => {
          armedWtStop = null;
          render();
        };
      });
      document.querySelectorAll('.wt-stop-confirm-btn').forEach((btn) => {
        btn.onclick = () =>
          doAction('wt_stop', { slug: btn.dataset.slug }, btn.dataset.slug);
      });
    }

    document.getElementById('wt-start-btn').onclick = () => {
      const slug = document.getElementById('wt-slug-input').value.trim();
      if (!slug) return;
      document.getElementById('wt-slug-input').value = '';
      showToast(\`Starting worktree env \${slug} (restoring DB & linking addons)...\`);
      doAction('wt_start', { slug }, slug);
    };
    document.getElementById('wt-slug-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('wt-start-btn').click();
    });
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
      setInterval(() => {
        if (!busyKey && !armedWtStop) loadState();
      }, 15000);
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
  const cfg = loadEnvConfig(wsRoot);
  const touched = scanTouchedFromTranscript(convId, wsRoot, cfg);
  return await collectEnvSnapshot(wsRoot, cfg, touched);
}

const app = new SidecarApp();

app.page('/', () => HTML);

app.api('/api/state', async (data) => {
  return await getFullState(data?.workspaceUris, data?.conversationId);
});

app.api('/api/action', async (data) => {
  const { wsRoot, activeUris } = resolveWorkspaceRoot(data?.workspaceUris);
  const convId = await resolveActiveConversationId(data?.conversationId, activeUris);
  const action = String(data?.action || '');
  let message = '';

  if (action === 'open_url') {
    const url = String(data?.url || '');
    if (url.startsWith('http://') || url.startsWith('https://')) {
      await runCmd('xdg-open', [url], wsRoot, 5000);
      message = `Opened ${url}`;
    }
  } else if (action === 'systemctl') {
    const unit = String(data?.unit || '');
    const op = String(data?.op || '');
    if (['start', 'stop', 'restart'].includes(op) && /^(?:postgres|odoo)[A-Za-z0-9_.@-]*\.service$/.test(unit)) {
      const res = await runCmd('systemctl', ['--user', op, unit], wsRoot, 15000);
      message =
        res.exitCode === 0
          ? `systemctl --user ${op} ${unit}`
          : `Failed: ${(res.stderr || res.stdout).trim().split('\n')[0]}`;
    }
  } else if (action === 'wt_start') {
    const slug = String(data?.slug || '').trim();
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) {
      const script = join(wsRoot, '.claude', 'skills', 'worktree-env', 'scripts', 'wt-start.sh');
      const res = await runCmd('bash', [script, slug], wsRoot, WT_SCRIPT_TIMEOUT_MS);
      message =
        res.exitCode === 0
          ? `Started worktree env ${slug}`
          : `wt-start.sh failed: ${(res.stderr || res.stdout).trim().split('\n').pop()}`;
    }
  } else if (action === 'wt_stop') {
    const slug = String(data?.slug || '').trim();
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) {
      const script = join(wsRoot, '.claude', 'skills', 'worktree-env', 'scripts', 'wt-stop.sh');
      const res = await runCmd('bash', [script, slug], wsRoot, WT_SCRIPT_TIMEOUT_MS);
      message =
        res.exitCode === 0
          ? `Torn down worktree env ${slug}`
          : `wt-stop.sh failed: ${(res.stderr || res.stdout).trim().split('\n').pop()}`;
    }
  }

  return {
    message,
    state: await getFullState(activeUris, convId),
  };
});

await app.run();
