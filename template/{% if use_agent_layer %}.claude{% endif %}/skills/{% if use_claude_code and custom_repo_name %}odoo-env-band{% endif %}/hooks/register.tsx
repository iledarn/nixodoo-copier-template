import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { EnvSnapshot, GitStatus, Service, Touched, WtEnv } from '../types'
import {
  isSameTouched,
  mergeTouched,
  parseActive,
  parseGitStatus,
  touchedBy,
  worktreeSlug,
  wtDb,
} from './env'
import type { Where } from './env'
import { ADDONS, ADDONS_BRANCH, ANSWERS_FILE, ENV_BRANCHES, PORTS, SERVICE_SUFFIX } from './config'

const REFRESH_MS = 20_000
// the one service outside the worktree envs: the postgres cluster holding every wt_* database
const SERVICES = [{ name: 'pg', unit: `postgres${SERVICE_SUFFIX}.service`, port: PORTS.pg }] as const

const snapshot = atom({ plugin: 'odoo-env-band', key: 'snapshot' } as const, null)
const touched = atom({ plugin: 'odoo-env-band', key: 'touched' } as const, { env: false, addons: false, wts: [] })

let project: string | null = null

// the project root: the nearest folder up from the session's root holding the copier answers file
async function projectDir($: EngineInterface): Promise<string> {
  if (project !== null) return project
  const root = await $.session.root()
  for (let dir = root; dir !== ''; dir = dir.slice(0, dir.lastIndexOf('/'))) {
    if (await $.fs.exists(`${dir}/${ANSWERS_FILE}`)) return (project = dir)
  }
  return (project = root)
}

async function gitStatus($: EngineInterface, dir: string): Promise<GitStatus | null> {
  const run = await $.process.run(['git', '-C', dir, 'status', '--porcelain=v2', '--branch'], { timeoutMs: 5000 })
  return run.exitCode === 0 ? parseGitStatus(run.stdout) : null
}

async function collect($: EngineInterface): Promise<EnvSnapshot> {
  const project = await projectDir($)
  const cwd = await $.session.cwd()
  const here = worktreeSlug(cwd, project)
  // the cwd counts for addons and a worktree (going there is deliberate), never for the env repo it starts in
  const mine = mergeTouched(await read($, touched), {
    env: false,
    addons: `${cwd}/`.startsWith(`${project}/${ADDONS}/`),
    wts: here === null ? [] : [here],
  })

  const envRoot = `${project}/.worktrees/_env`
  const slugs = (await $.fs.exists(envRoot))
    ? (await $.fs.list(envRoot)).filter(entry => entry.kind === 'dir').map(entry => entry.name).sort()
    : []
  const ports = await Promise.all(
    slugs.map(slug => $.fs.read(`${envRoot}/${slug}/port`).then(text => text.trim(), () => '?')),
  )
  // wt-start records each env's database (wt_<slug>_<MMDDYY>, the day of its dump)
  const dbs = await Promise.all(
    slugs.map(slug => $.fs.read(`${envRoot}/${slug}/db`).then(text => text.trim() || wtDb(slug), () => wtDb(slug))),
  )
  const wtUnit = (slug: string) => `odoo${SERVICE_SUFFIX}-wt@${slug}.service`
  const units = [...SERVICES.map(service => service.unit), ...slugs.map(wtUnit)]
  const systemctl = await $.process.run(['systemctl', '--user', 'is-active', ...units], { timeoutMs: 5000 })
  const active = parseActive(systemctl.stdout, units)

  const wts: WtEnv[] = await Promise.all(
    slugs.map(async (slug, i) => {
      const isMine = mine.wts.includes(slug)
      return {
        slug,
        port: ports[i] ?? '?',
        db: dbs[i] ?? wtDb(slug),
        isActive: active[wtUnit(slug)] === true,
        isMine,
        git: isMine ? await gitStatus($, `${project}/.worktrees/${slug}`) : null,
      }
    }),
  )
  const services: Service[] = SERVICES.map(service => ({
    name: service.name,
    port: service.port,
    isActive: active[service.unit] === true,
  }))
  return {
    env: mine.env ? { git: await gitStatus($, project) } : null,
    addons: mine.addons ? { git: await gitStatus($, `${project}/${ADDONS}`) } : null,
    services,
    wts,
  }
}

// a worktree env's address: its database is the subdomain
const webUrl = (wt: WtEnv) => `http://${wt.db}.localhost:${wt.port}/web`

async function openUrl($: EngineInterface, url: string): Promise<void> {
  const run = await $.process.run(['xdg-open', url], { timeoutMs: 10_000 })
  if (run.exitCode !== 0) $.ui.toast(`odoo-env-band: xdg-open ${url} failed: ${run.stderr.trim() || run.exitCode}`)
}

let running: Promise<void> | null = null

// one refresh at a time; a call while one runs joins it
function refresh($: EngineInterface): Promise<void> {
  running ??= collect($)
    .then(next => update($, snapshot, () => next))
    .then(
      () => undefined,
      error => $.ui.log(`odoo-env-band: ${String(error)}`, { to: 'debug' }),
    )
    .finally(() => {
      running = null
    })
  return running
}

async function where($: EngineInterface): Promise<Where> {
  return { project: await projectDir($), cwd: await $.session.cwd(), addons: ADDONS }
}

// Recomputed from the transcripts, the main thread's and each subagent's, on every load: what this
// session works in is a fact of its tool calls, so a value an earlier version of these rules kept is
// replaced, never merged in.
async function rescan($: EngineInterface): Promise<void> {
  const at = await where($)
  const uses = (await $.session.messages()).flatMap(message => message.toolUses)
  for (const agent of await $.agent.list()) {
    const found = await $.session.messages({ agentId: agent.id })
    if (Array.isArray(found)) uses.push(...found.flatMap(message => message.toolUses))
  }
  const found = uses
    .filter(use => use.isError !== true)
    .reduce<Touched>((all, use) => mergeTouched(all, touchedBy(String(use.tool), use.input, at)), {
      env: false,
      addons: false,
      wts: [],
    })
  await update($, touched, () => found)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await rescan($)
    void refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    return started
  })

  // a checkout this session starts working in shows at once; so does a git command or a service restart
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const tool = String(e.tool)
    const found = touchedBy(tool, e as unknown as Record<string, unknown>, await where($))
    const before = await read($, touched)
    const after = mergeTouched(before, found)
    if (!isSameTouched(before, after)) await update($, touched, () => after)
    if (tool === 'Bash' || !isSameTouched(before, after)) void refresh($)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    void refresh($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const env = await read($, snapshot)
    if (env === null || e.props.hasSurvey) return below

    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const mine = env.wts.filter(wt => wt.isMine)
    const others = env.wts.filter(wt => !wt.isMine)

    const gitState = (git: GitStatus | null, defaults: readonly string[], isWorktree: boolean) =>
      git === null ? (
        <Text color="red">no git</Text>
      ) : (
        <Box flexDirection="row" columnGap={1}>
          <Text bold color={defaults.includes(git.branch) ? undefined : 'cyan'}>
            {git.hasUpstream || defaults.includes(git.branch) || isWorktree
              ? git.branch
              : `${git.branch} (local)`}
          </Text>
          {git.dirty > 0 ? <Text color="yellow">{`±${git.dirty}`}</Text> : <Text color="green">✓</Text>}
          {git.ahead > 0 && <Text dimColor>{`↑${git.ahead}`}</Text>}
          {git.behind > 0 && <Text color="yellow">{`↓${git.behind}`}</Text>}
        </Box>
      )

    // the postgres cluster first, then one group per checkout (a worktree's port and state right after its
    // label, its open button last), then the other envs
    const groups: JSX.Element[] = [
      <Box flexDirection="row" columnGap={1}>
        {env.services.map(service => (
          <Text color={service.isActive ? 'green' : 'red'}>
            {`${service.name} :${service.port} ${service.isActive ? '●' : '○'}`}
          </Text>
        ))}
      </Box>,
      ...(env.env === null
        ? []
        : [
            <Box flexDirection="row" columnGap={1}>
              <Text dimColor>env</Text>
              {gitState(env.env.git, ENV_BRANCHES, false)}
            </Box>,
          ]),
      ...(env.addons === null
        ? []
        : [
            <Box flexDirection="row" columnGap={1}>
              <Text dimColor>addons</Text>
              {gitState(env.addons.git, [ADDONS_BRANCH], false)}
            </Box>,
          ]),
      ...mine.map(wt => (
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor>wt</Text>
          <Text color={wt.isActive ? 'green' : undefined} dimColor={!wt.isActive}>
            {`:${wt.port} ${wt.isActive ? '●' : '○'}`}
          </Text>
          {gitState(wt.git, [ADDONS_BRANCH], true)}
          {/* the session is served by its database's subdomain (dbfilter ^%d$); a remote surface draws only an
              https: Link as a link, so there `open` is a button that opens the browser */}
          {e.surface === 'terminal' ? (
            <Link href={webUrl(wt)} label="open" />
          ) : (
            <Button key={`wt-open-${wt.slug}`} label="open" onPress={() => openUrl($, webUrl(wt))} />
          )}
        </Box>
      )),
      ...(others.length === 0
        ? []
        : [
            <Text dimColor>{`${others.length} other wt env${others.length === 1 ? '' : 's'}`}</Text>,
          ]),
    ]

    const row = (
      <Box key="odoo-env" flexDirection="row" columnGap={1} flexWrap="wrap">
        {groups.map((group, i) => (
          <Box flexDirection="row" columnGap={1}>
            {group}
            {i < groups.length - 1 && <Text dimColor>│</Text>}
          </Box>
        ))}
      </Box>
    )
    return (
      <Box flexDirection="column" rowGap="sm">
        {below}
        {row}
      </Box>
    )
  })
}
