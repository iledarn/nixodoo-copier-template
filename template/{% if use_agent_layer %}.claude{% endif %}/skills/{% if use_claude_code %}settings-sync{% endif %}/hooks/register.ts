import type { EngineInterface, ProcessRunResult, Register } from 'claude-code'

// The servers among `mcp__<server>__<tool>` names that carry every one of `tools`. The desktop app
// names a claude.ai connector by its id, which differs per account, so a layer declares a connector
// by its tools (connectors.json) and the server is found here, in the session.
export function serversWith(tools: readonly string[], toolNames: readonly string[]): string[] {
  const byServer = new Map<string, Set<string>>()
  for (const name of toolNames) {
    const match = /^mcp__(.+)__([A-Za-z0-9_-]+)$/.exec(name)
    if (match?.[1] === undefined || match[2] === undefined) continue
    const held = byServer.get(match[1]) ?? new Set<string>()
    held.add(match[2])
    byServer.set(match[1], held)
  }
  return [...byServer].filter(([, held]) => tools.every(tool => held.has(tool))).map(([server]) => server)
}

// `--connector NAME=SERVER` for each declared connector found in the session
export function connectorArgs(declared: Record<string, readonly string[]>, toolNames: readonly string[]): string[] {
  return Object.entries(declared).flatMap(([name, tools]) =>
    tools.length === 0 ? [] : serversWith(tools, toolNames).flatMap(server => ['--connector', `${name}=${server}`]),
  )
}

// `/settings-sync [apply]`: with no word a check that writes nothing, since the layers' hooks and rules
// are read before they land; null for any other word. Writing the project layer (`sync.py save`) is its
// maintainer's, from a shell, and not offered here.
export function mode(args: string): 'check' | 'apply' | null {
  const word = args.trim()
  return word === '' || word === 'check' ? 'check' : word === 'apply' ? 'apply' : null
}

function output(run: ProcessRunResult): string {
  const text = [run.stdout.trim(), run.stderr.trim()].filter(part => part !== '').join('\n')
  return run.exitCode === 0 ? text : `${text}\n(sync.py exited ${run.exitCode})`
}

async function declaredConnectors($: EngineInterface, script: string): Promise<Record<string, string[]>> {
  const run = await $.process.run(['python3', script, 'connectors'], { cwd: $.plugin.root, timeoutMs: 30_000 })
  try {
    const parsed: unknown = JSON.parse(run.stdout)
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, string[]>) : {}
  } catch {
    return {}
  }
}

async function toolNames($: EngineInterface): Promise<string[]> {
  try {
    return (await $.tool.list()).filter(tool => tool.mcp).map(tool => tool.name)
  } catch {
    return []
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'settings-sync',
      description:
        "Show what the team's Claude settings would add to ~/.claude/settings.json and this project's settings.local.json; `apply` adds it",
      argumentHint: '[apply]',
    })
    return started
  })

  on('command.run', { command: 'settings-sync' }, async ($, e) => {
    const word = mode(e.args)
    if (word === null) return { text: 'Usage: /settings-sync shows what the team settings would add; /settings-sync apply adds it.' }
    const script = `${$.plugin.root}/sync.py`
    const connectors = connectorArgs(await declaredConnectors($, script), await toolNames($))
    const run = await $.process.run(['python3', script, word, ...connectors], { cwd: $.plugin.root, timeoutMs: 60_000 })
    return { text: output(run) }
  })
}
