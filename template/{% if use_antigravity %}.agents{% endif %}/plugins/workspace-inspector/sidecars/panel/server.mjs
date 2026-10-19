import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp } from 'sidecar_sdk';

const HOME = homedir();
const GEMINI_CONFIG_DIR = join(HOME, '.gemini', 'config');
const ANTIGRAVITY_DIR = process.env.ANTIGRAVITY_APP_DATA_DIR || join(HOME, '.gemini', 'antigravity');
const MCP_CACHE_DIR = join(ANTIGRAVITY_DIR, 'mcp');

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
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseFrontmatter(mdText) {
  const m = mdText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { attrs: {}, body: mdText.trim() };
  const attrs = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) {
      attrs[kv[1].trim()] = kv[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return { attrs, body: m[2].trim() };
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

function loadMcpCacheTools(serverKey) {
  const dir = join(MCP_CACHE_DIR, serverKey);
  if (!existsSync(dir)) return { tools: [], instructions: '' };
  const tools = [];
  let instructions = '';
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (entry === 'instructions.md') {
      try {
        instructions = readFileSync(full, 'utf-8').trim();
      } catch {}
      continue;
    }
    if (entry.endsWith('.json')) {
      const schema = safeReadJson(full);
      if (schema) {
        tools.push({
          name: schema.name || basename(entry, '.json'),
          description: schema.description || '',
          parameters: Object.keys(schema.inputSchema?.properties || schema.parameters?.properties || {}),
        });
      }
    }
  }
  return { tools, instructions };
}

function scanWorkspaceAgentsDir(wsPath) {
  const agentsRoot = join(wsPath, '.agents');
  const result = {
    exists: existsSync(agentsRoot),
    plugins: [],
    mcpServers: [],
    agents: [],
    skills: [],
    rules: [],
    hooks: [],
  };
  if (!result.exists) return result;

  // 1. Workspace Plugins (.agents/plugins/*)
  const pluginsDir = join(agentsRoot, 'plugins');
  if (existsSync(pluginsDir)) {
    for (const dirName of readdirSync(pluginsDir).sort()) {
      if (dirName === 'workspace-inspector') continue;
      const pDir = join(pluginsDir, dirName);
      if (!statSync(pDir).isDirectory()) continue;
      const manifest = safeReadJson(join(pDir, 'plugin.json')) || {};
      const mcpCfg = safeReadJson(join(pDir, 'mcp_config.json')) || {};
      const pluginName = manifest.name || dirName;
      const mcpNames = Object.keys(mcpCfg.mcpServers || {});

      result.plugins.push({
        dir: dirName,
        name: pluginName,
        displayName: manifest.displayName || pluginName,
        description: manifest.description || '',
        path: pDir,
        isGlobal: false,
        disabled: Boolean(manifest.disabled),
        mcpServers: mcpNames,
      });

      for (const [srvName, srvSpec] of Object.entries(mcpCfg.mcpServers || {})) {
        const namespacedKey = `${pluginName}_${srvName}`;
        const cached = loadMcpCacheTools(namespacedKey);
        const fallbackCached = cached.tools.length ? cached : loadMcpCacheTools(srvName);
        result.mcpServers.push({
          name: srvName,
          namespacedName: namespacedKey,
          pluginName,
          pluginDisplayName: manifest.displayName || pluginName,
          scope: 'workspace-plugin',
          configPath: join(pDir, 'mcp_config.json'),
          transport: srvSpec.url || srvSpec.serverUrl ? 'HTTP (Streamable)' : 'Stdio',
          endpointOrCommand:
            srvSpec.url ||
            srvSpec.serverUrl ||
            [srvSpec.command, ...(srvSpec.args || [])].filter(Boolean).join(' '),
          tools: fallbackCached.tools,
          instructions: fallbackCached.instructions,
          status: fallbackCached.tools.length > 0 ? 'CONNECTED' : 'CONFIGURED',
        });
      }
    }
  }

  // 2. Direct workspace .agents/mcp_config.json (if present)
  const rootMcp = safeReadJson(join(agentsRoot, 'mcp_config.json'));
  if (rootMcp?.mcpServers) {
    for (const [srvName, srvSpec] of Object.entries(rootMcp.mcpServers)) {
      const cached = loadMcpCacheTools(srvName);
      result.mcpServers.push({
        name: srvName,
        namespacedName: srvName,
        pluginName: null,
        pluginDisplayName: 'Workspace (.agents/mcp_config.json)',
        scope: 'workspace',
        configPath: join(agentsRoot, 'mcp_config.json'),
        transport: srvSpec.url || srvSpec.serverUrl ? 'HTTP (Streamable)' : 'Stdio',
        endpointOrCommand:
          srvSpec.url ||
          srvSpec.serverUrl ||
          [srvSpec.command, ...(srvSpec.args || [])].filter(Boolean).join(' '),
        tools: cached.tools,
        instructions: cached.instructions,
        status: cached.tools.length > 0 ? 'CONNECTED' : 'CONFIGURED',
      });
    }
  }

  // 3. Custom Agents (.agents/agents/*.md)
  const customAgentsDir = join(agentsRoot, 'agents');
  if (existsSync(customAgentsDir)) {
    for (const f of readdirSync(customAgentsDir).sort()) {
      if (!f.endsWith('.md')) continue;
      const full = join(customAgentsDir, f);
      try {
        const { attrs } = parseFrontmatter(readFileSync(full, 'utf-8'));
        result.agents.push({
          name: attrs.name || basename(f, '.md'),
          description: attrs.description || '',
          model: attrs.model || 'inherit',
          path: full,
        });
      } catch {}
    }
  }

  // 4. Skills (.agents/skills/* and .agents/skills.json)
  const seenSkills = new Set();
  const addSkillDir = (skillFolder, sourceLabel) => {
    const skillMd = join(skillFolder, 'SKILL.md');
    if (!existsSync(skillMd)) return;
    try {
      const { attrs } = parseFrontmatter(readFileSync(skillMd, 'utf-8'));
      const name = attrs.name || basename(skillFolder);
      if (seenSkills.has(name)) return;
      seenSkills.add(name);
      result.skills.push({
        name,
        description: attrs.description || '',
        source: sourceLabel,
        path: skillMd,
      });
    } catch {}
  };

  const directSkillsDir = join(agentsRoot, 'skills');
  if (existsSync(directSkillsDir)) {
    for (const d of readdirSync(directSkillsDir).sort()) {
      const full = join(directSkillsDir, d);
      if (statSync(full).isDirectory()) addSkillDir(full, '.agents/skills');
    }
  }

  const skillsManifest = safeReadJson(join(agentsRoot, 'skills.json'));
  if (skillsManifest?.entries) {
    for (const entry of skillsManifest.entries) {
      if (!entry.path) continue;
      const resolvedDir = entry.path.startsWith('/')
        ? entry.path
        : existsSync(resolve(agentsRoot, entry.path))
          ? resolve(agentsRoot, entry.path)
          : resolve(wsPath, entry.path);
      if (!existsSync(resolvedDir)) continue;
      const excludeRegexes = (entry.exclude || []).map((p) => new RegExp(`^(?:${p})$`));
      for (const d of readdirSync(resolvedDir).sort()) {
        if (excludeRegexes.some((re) => re.test(d))) continue;
        const full = join(resolvedDir, d);
        if (statSync(full).isDirectory()) addSkillDir(full, entry.path);
      }
    }
  }

  // 5. Rules (.agents/rules/*.md)
  const rulesDir = join(agentsRoot, 'rules');
  if (existsSync(rulesDir)) {
    for (const f of readdirSync(rulesDir).sort()) {
      if (!f.endsWith('.md')) continue;
      const full = join(rulesDir, f);
      try {
        const { attrs } = parseFrontmatter(readFileSync(full, 'utf-8'));
        result.rules.push({
          name: basename(f, '.md'),
          trigger: attrs.trigger || 'always_on',
          globs: attrs.globs || '',
          description: attrs.description || '',
          path: full,
        });
      } catch {}
    }
  }

  // 6. Hooks (.agents/hooks.json)
  const hooksJson = safeReadJson(join(agentsRoot, 'hooks.json'));
  if (hooksJson && typeof hooksJson === 'object') {
    const rawGroups = hooksJson.hooks ? { default: hooksJson.hooks } : hooksJson;
    for (const [groupName, groupVal] of Object.entries(rawGroups)) {
      if (!groupVal || typeof groupVal !== 'object' || Array.isArray(groupVal)) continue;
      const enabled = groupVal.enabled !== false;
      const commands = [];
      for (const [eventName, entries] of Object.entries(groupVal)) {
        if (eventName === 'enabled' || !Array.isArray(entries)) continue;
        for (const item of entries) {
          if (Array.isArray(item.hooks)) {
            for (const h of item.hooks) {
              if (h.command) {
                commands.push({
                  event: eventName,
                  matcher: item.matcher || '*',
                  command: h.command,
                });
              }
            }
          } else if (item.command) {
            commands.push({
              event: eventName,
              matcher: item.matcher || '*',
              command: item.command,
            });
          }
        }
      }
      if (commands.length > 0) {
        result.hooks.push({
          event: groupName,
          enabled,
          count: commands.length,
          commands,
        });
      }
    }
  }

  return result;
}

async function inspectWorkspace(requestedUris = []) {
  const projects = loadKnownProjects();
  let activeUris = Array.isArray(requestedUris) && requestedUris.length > 0 ? requestedUris : [];
  if (activeUris.length === 0 && projects.length > 0) {
    activeUris = projects[0].workspaceUris;
  }

  const wsPaths = activeUris.map(uriToPath).filter(Boolean);
  const primaryPath = wsPaths[0] || process.cwd();

  const [lsPluginsRes, lsMcpRes] = await Promise.all([
    lsrpc('GetAllPlugins', { workspaceUris: activeUris }),
    lsrpc('GetMcpServerStates', {}),
  ]);

  const scanned = scanWorkspaceAgentsDir(primaryPath);

  // Enrich workspace plugins with live LS state (disabled flag, etc.)
  const lsPlugins = lsPluginsRes?.plugins || [];
  const globalPlugins = [];
  for (const lp of lsPlugins) {
    const pPath = lp.path || '';
    const dirName = pPath.split('/').filter(Boolean).pop() || lp.name;
    const existingWs = scanned.plugins.find((wp) => wp.name === lp.name || wp.dir === dirName);
    if (existingWs) {
      existingWs.disabled = Boolean(lp.disabled);
    } else if (lp.isGlobal) {
      globalPlugins.push({
        dir: dirName,
        name: lp.name || dirName,
        displayName: lp.displayName || lp.name || dirName,
        description: lp.description || '',
        path: pPath,
        isGlobal: true,
        disabled: Boolean(lp.disabled),
        skillsCount: (lp.skills || []).length,
        mcpServers: (lp.mcpServers || []).map((m) => m.name || m),
      });
    }
  }

  // Enrich MCP servers with live LS GetMcpServerStates
  const lsStates = lsMcpRes?.states || [];
  for (const state of lsStates) {
    const specName = state?.spec?.name || state?.serverInfo?.name || '';
    const match = scanned.mcpServers.find(
      (s) => s.namespacedName === specName || s.name === specName
    );
    if (match) {
      if (state.status) match.status = String(state.status).replace(/^MCP_SERVER_STATUS_/, '');
      if (state.error) match.error = state.error;
      if (Array.isArray(state.tools) && state.tools.length > 0 && match.tools.length === 0) {
        match.tools = state.tools.map((t) => ({
          name: t.name,
          description: t.description || '',
          parameters: [],
        }));
      }
    }
  }

  return {
    activeWorkspacePath: primaryPath,
    activeWorkspaceName: basename(primaryPath),
    activeWorkspaceUris: activeUris,
    projects,
    workspacePlugins: scanned.plugins,
    globalPlugins,
    mcpServers: scanned.mcpServers,
    agents: scanned.agents,
    skills: scanned.skills,
    rules: scanned.rules,
    hooks: scanned.hooks,
  };
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Workspace Customizations</title>
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
      gap: 10px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--wi-border);
      margin-bottom: 12px;
    }
    .title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .title {
      font-size: 15px;
      font-weight: 600;
      color: var(--wi-fg);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .ws-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    select, input[type="search"] {
      background-color: var(--wi-card);
      color: var(--wi-fg);
      border: 1px solid var(--wi-border);
      border-radius: 6px;
      padding: 6px 9px;
      font-size: 12px;
      outline: none;
    }
    select option {
      background-color: #1c2130;
      color: #f8fafc;
    }
    input[type="search"]::placeholder {
      color: var(--wi-text-dim);
    }
    select:focus, input[type="search"]:focus {
      border-color: var(--wi-accent);
    }
    input[type="search"] {
      flex: 1;
      min-width: 140px;
    }
    button {
      background: var(--wi-card);
      color: var(--wi-fg);
      border: 1px solid var(--wi-border);
      border-radius: 6px;
      padding: 5px 10px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    button:hover {
      background: var(--wi-card-hover);
      border-color: rgba(148, 163, 184, 0.4);
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(95px, 1fr));
      gap: 8px;
      margin-bottom: 14px;
    }
    .stat-card {
      background: var(--wi-card);
      border: 1px solid var(--wi-border);
      border-radius: 8px;
      padding: 8px 10px;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    .stat-card:hover {
      background: var(--wi-card-hover);
    }
    .stat-card.active {
      border-color: var(--wi-accent);
      background: rgba(96, 165, 250, 0.16);
    }
    .stat-num {
      font-size: 18px;
      font-weight: 700;
      color: var(--wi-fg);
    }
    .stat-label {
      font-size: 11.5px;
      font-weight: 500;
      color: var(--wi-text-sec);
      margin-top: 2px;
    }
    .section {
      margin-bottom: 18px;
    }
    .section-header {
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
    .card {
      background: var(--wi-card);
      border: 1px solid var(--wi-border);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 8px;
    }
    .card-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }
    .card-title {
      font-weight: 600;
      font-size: 13.5px;
      color: var(--wi-fg);
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
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
    .badge-purple {
      background: rgba(192, 132, 252, 0.18);
      color: #d8b4fe;
      border-color: rgba(192, 132, 252, 0.38);
    }
    .badge-muted {
      background: rgba(148, 163, 184, 0.16);
      color: #e2e8f0;
      border-color: rgba(148, 163, 184, 0.32);
    }
    .desc {
      color: var(--wi-text-sec);
      font-size: 12.5px;
      margin-top: 5px;
    }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11.5px;
      color: var(--wi-text-dim);
      word-break: break-all;
      margin-top: 4px;
    }
    details {
      margin-top: 8px;
      border-top: 1px solid var(--wi-border);
      padding-top: 6px;
    }
    summary {
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      color: #93c5fd;
      user-select: none;
    }
    .tool-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 8px;
      max-height: 260px;
      overflow-y: auto;
      padding-right: 4px;
    }
    .tool-item {
      background: rgba(15, 23, 42, 0.55);
      border: 1px solid var(--wi-border);
      border-radius: 6px;
      padding: 6px 8px;
    }
    .tool-name {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px;
      font-weight: 600;
      color: #6ee7b7;
    }
    .compact-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 6px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title-row">
      <div class="title">
        <span>Workspace Customizations</span>
        <span id="ws-badge" class="badge badge-ws">.agents/</span>
      </div>
      <div style="display:flex;gap:6px;">
        <button id="refresh-mcp-btn" title="Refresh MCP servers in Language Server">Reconnect MCP</button>
        <button id="reload-btn">Refresh</button>
      </div>
    </div>
    <div class="ws-bar">
      <select id="project-select" title="Active project workspace"></select>
      <input type="search" id="search-input" placeholder="Filter plugins, MCP tools, skills, agents..." />
    </div>
  </div>

  <div class="stats" id="stats-bar"></div>
  <div id="content">Loading workspace customizations...</div>

  <script>
    let currentState = null;
    let activeTab = 'all';
    let searchQuery = '';
    let selectedUris = [];

    async function loadData(uris) {
      const res = await window.sidecar.fetch('/api/inspect', {
        method: 'POST',
        body: JSON.stringify({ workspaceUris: uris || selectedUris }),
      });
      currentState = await res.json();
      selectedUris = currentState.activeWorkspaceUris || [];
      renderProjectSelect();
      render();
    }

    function renderProjectSelect() {
      const sel = document.getElementById('project-select');
      const projects = currentState?.projects || [];
      sel.innerHTML = '';
      if (projects.length === 0) {
        const opt = document.createElement('option');
        opt.textContent = currentState?.activeWorkspaceName || 'Current Workspace';
        sel.appendChild(opt);
        return;
      }
      for (const p of projects) {
        const opt = document.createElement('option');
        opt.value = JSON.stringify(p.workspaceUris);
        opt.textContent = p.name + ' (' + p.workspaceUris[0].replace('file://', '') + ')';
        if (
          currentState.activeWorkspaceUris &&
          currentState.activeWorkspaceUris[0] === p.workspaceUris[0]
        ) {
          opt.selected = true;
        }
        sel.appendChild(opt);
      }
    }

    function matchesSearch(...texts) {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return texts.some((t) => String(t || '').toLowerCase().includes(q));
    }

    function escapeHtml(s) {
      return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function render() {
      if (!currentState) return;
      document.getElementById('ws-badge').textContent =
        currentState.activeWorkspaceName + ' · .agents/';

      const totalTools = (currentState.mcpServers || []).reduce(
        (acc, s) => acc + (s.tools?.length || 0),
        0
      );

      const totalItems =
        (currentState.workspacePlugins?.length || 0) +
        (currentState.mcpServers?.length || 0) +
        (currentState.agents?.length || 0) +
        (currentState.skills?.length || 0) +
        (currentState.rules?.length || 0) +
        (currentState.hooks?.length || 0);

      const tabs = [
        { id: 'all', num: totalItems, label: 'All Items' },
        { id: 'plugins', num: currentState.workspacePlugins?.length || 0, label: 'WS Plugins' },
        { id: 'mcp', num: (currentState.mcpServers?.length || 0) + ' (' + totalTools + ')', label: 'MCP & Tools' },
        { id: 'agents', num: currentState.agents?.length || 0, label: 'Custom Agents' },
        { id: 'skills', num: currentState.skills?.length || 0, label: 'WS Skills' },
        { id: 'rules', num: (currentState.rules?.length || 0) + ' + ' + (currentState.hooks?.length || 0), label: 'Rules & Hooks' },
      ];

      document.getElementById('stats-bar').innerHTML = tabs
        .map(
          (t) => \`
          <div class="stat-card \${activeTab === t.id ? 'active' : ''}" data-tab="\${t.id}">
            <div class="stat-num">\${escapeHtml(t.num)}</div>
            <div class="stat-label">\${escapeHtml(t.label)}</div>
          </div>\`
        )
        .join('');

      document.querySelectorAll('.stat-card').forEach((el) => {
        el.onclick = () => {
          activeTab = el.dataset.tab;
          render();
        };
      });

      let html = '';

      // 1. Workspace Plugins
      if (activeTab === 'all' || activeTab === 'plugins') {
        const wsPlugins = (currentState.workspacePlugins || []).filter((p) =>
          matchesSearch(p.name, p.displayName, p.description, p.path, ...(p.mcpServers || []))
        );
        html += \`<div class="section">
          <div class="section-header">
            <span>Workspace Plugins (.agents/plugins)</span>
            <span>\${wsPlugins.length}</span>
          </div>\`;
        if (wsPlugins.length === 0) {
          html += \`<div class="card"><div class="desc">No matching workspace plugins found in .agents/plugins/</div></div>\`;
        }
        for (const p of wsPlugins) {
          html += \`
            <div class="card">
              <div class="card-top">
                <div class="card-title">
                  <span>\${escapeHtml(p.displayName)}</span>
                  <span class="badge badge-ws">workspace</span>
                  <span class="badge \${p.disabled ? 'badge-muted' : 'badge-ok'}">\${p.disabled ? 'Disabled' : 'Active'}</span>
                  \${(p.mcpServers || []).map((m) => \`<span class="badge badge-purple">MCP: \${escapeHtml(m)}</span>\`).join('')}
                </div>
              </div>
              <div class="desc">\${escapeHtml(p.description)}</div>
              <div class="mono">\${escapeHtml(p.path)}</div>
            </div>\`;
        }
        html += \`</div>\`;
      }

      // 2. Workspace MCP Servers
      if (activeTab === 'all' || activeTab === 'mcp') {
        const mcpServers = (currentState.mcpServers || []).filter((s) =>
          matchesSearch(
            s.name,
            s.namespacedName,
            s.pluginDisplayName,
            s.endpointOrCommand,
            ...(s.tools || []).map((t) => t.name + ' ' + t.description)
          )
        );
        html += \`<div class="section">
          <div class="section-header">
            <span>Workspace MCP Servers</span>
            <span>\${mcpServers.length} servers · \${totalTools} tools</span>
          </div>\`;
        if (mcpServers.length === 0) {
          html += \`<div class="card"><div class="desc">No matching workspace MCP servers.</div></div>\`;
        }
        for (const s of mcpServers) {
          const filteredTools = (s.tools || []).filter((t) =>
            matchesSearch(t.name, t.description, s.name)
          );
          html += \`
            <div class="card">
              <div class="card-top">
                <div class="card-title">
                  <span>\${escapeHtml(s.name)}</span>
                  <span class="badge badge-ok">\${escapeHtml(s.status)}</span>
                  <span class="badge badge-purple">\${escapeHtml(s.transport)}</span>
                  <span class="badge badge-ws">Plugin: \${escapeHtml(s.pluginName || 'workspace')}</span>
                </div>
              </div>
              <div class="mono">\${escapeHtml(s.endpointOrCommand)}</div>
              \${s.error ? \`<div class="desc" style="color:#f87171;">Error: \${escapeHtml(s.error)}</div>\` : ''}
              <details \${activeTab === 'mcp' || searchQuery ? 'open' : ''}>
                <summary>\${filteredTools.length} tools exposed (\${escapeHtml(s.namespacedName)})</summary>
                <div class="tool-list">
                  \${filteredTools
                    .map(
                      (t) => \`
                    <div class="tool-item">
                      <div class="tool-name">\${escapeHtml(t.name)}\${t.parameters?.length ? \`(\${escapeHtml(t.parameters.join(', '))})\` : ''}</div>
                      <div class="desc">\${escapeHtml(t.description)}</div>
                    </div>\`
                    )
                    .join('')}
                </div>
              </details>
            </div>\`;
        }
        html += \`</div>\`;
      }

      // 3. Custom Agents
      if (activeTab === 'all' || activeTab === 'agents') {
        const agents = (currentState.agents || []).filter((a) =>
          matchesSearch(a.name, a.description, a.model)
        );
        html += \`<div class="section">
          <div class="section-header">
            <span>Workspace Custom Agents (.agents/agents)</span>
            <span>\${agents.length}</span>
          </div>
          <div class="compact-grid">
            \${agents
              .map(
                (a) => \`
              <div class="card">
                <div class="card-title">
                  <span>@\${escapeHtml(a.name)}</span>
                  <span class="badge badge-ws">model: \${escapeHtml(a.model)}</span>
                </div>
                <div class="desc">\${escapeHtml(a.description)}</div>
              </div>\`
              )
              .join('')}
          </div>
        </div>\`;
      }

      // 4. Skills
      if (activeTab === 'all' || activeTab === 'skills') {
        const skills = (currentState.skills || []).filter((sk) =>
          matchesSearch(sk.name, sk.description, sk.source)
        );
        html += \`<div class="section">
          <div class="section-header">
            <span>Workspace Skills (.agents/skills.json)</span>
            <span>\${skills.length}</span>
          </div>
          <div class="compact-grid">
            \${skills
              .map(
                (sk) => \`
              <div class="card">
                <div class="card-title">
                  <span>/\${escapeHtml(sk.name)}</span>
                  <span class="badge badge-muted">\${escapeHtml(sk.source)}</span>
                </div>
                <div class="desc">\${escapeHtml(sk.description)}</div>
              </div>\`
              )
              .join('')}
          </div>
        </div>\`;
      }

      // 5. Rules & Hooks
      if (activeTab === 'all' || activeTab === 'rules') {
        const rules = (currentState.rules || []).filter((r) =>
          matchesSearch(r.name, r.trigger, r.globs, r.description)
        );
        const hooks = currentState.hooks || [];
        html += \`<div class="section">
          <div class="section-header">
            <span>Workspace Rules & Lifecycle Hooks</span>
            <span>\${rules.length} rules · \${hooks.length} hook events</span>
          </div>
          \${rules
            .map(
              (r) => \`
            <div class="card">
              <div class="card-title">
                <span>\${escapeHtml(r.name)}.md</span>
                <span class="badge badge-ok">\${escapeHtml(r.trigger)}</span>
                \${r.globs ? \`<span class="badge badge-muted">\${escapeHtml(r.globs)}</span>\` : ''}
              </div>
              <div class="mono">\${escapeHtml(r.path)}</div>
            </div>\`
            )
            .join('')}
          \${hooks
            .map(
              (h) => \`
            <div class="card">
              <div class="card-title">
                <span>Hook: \${escapeHtml(h.event)}</span>
                <span class="badge \${h.enabled === false ? 'badge-muted' : 'badge-ok'}">\${h.enabled === false ? 'Disabled' : 'Active'}</span>
                <span class="badge badge-purple">\${h.count} handlers</span>
              </div>
              <details>
                <summary>Show hook commands</summary>
                <div class="tool-list">
                  \${h.commands
                    .map(
                      (c) => \`
                    <div class="tool-item">
                      <div class="tool-name">\${escapeHtml(c.event ? c.event + ' · ' : '')}matcher: \${escapeHtml(c.matcher)}</div>
                      <div class="mono">\${escapeHtml(c.command)}</div>
                    </div>\`
                    )
                    .join('')}
                </div>
              </details>
            </div>\`
            )
            .join('')}
        </div>\`;
      }

      document.getElementById('content').innerHTML = html;
    }

    document.getElementById('search-input').addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      render();
    });

    document.getElementById('project-select').addEventListener('change', (e) => {
      try {
        selectedUris = JSON.parse(e.target.value);
        loadData(selectedUris);
      } catch {}
    });

    document.getElementById('reload-btn').addEventListener('click', () => loadData(selectedUris));

    document.getElementById('refresh-mcp-btn').addEventListener('click', async () => {
      const btn = document.getElementById('refresh-mcp-btn');
      btn.textContent = 'Reconnecting...';
      await window.sidecar.fetch('/api/refresh-mcp', { method: 'POST', body: '{}' });
      await loadData(selectedUris);
      btn.textContent = 'Reconnect MCP';
    });

    window.sidecar.onWorkspaceChange((uris) => {
      if (Array.isArray(uris) && uris.length > 0) {
        selectedUris = uris;
        loadData(uris);
      }
    });

    (async () => {
      const initialUris = await window.sidecar.getWorkspaceUris();
      if (Array.isArray(initialUris) && initialUris.length > 0) {
        selectedUris = initialUris;
      }
      await loadData(selectedUris);
    })();
  </script>
</body>
</html>`;

const app = new SidecarApp();

app.page('/', () => HTML);

app.api('/api/inspect', async (data) => {
  return await inspectWorkspace(data?.workspaceUris || []);
});

app.api('/api/refresh-mcp', async () => {
  const res = await lsrpc('RefreshMcpServers', { shallow: false });
  return { ok: true, result: res };
});

await app.run();
