import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { connectorArgs, mode, serversWith } from '../hooks/register'

const ID = 'f00dcafe-0000-4000-8000-000000000001'
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

function engine(on: On, runs: string[][], exitCode = 0): void {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.list', () => ({
    value: [
      ...['status', 'read', 'count'].map(tool => ({ name: `mcp__${ID}__${tool}`, description: '', mcp: true })),
      { name: 'mcp__other__read', description: '', mcp: true },
      { name: 'Bash', description: '', mcp: false },
    ],
  }))
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    const stdout = e.argv[2] === 'connectors' ? JSON.stringify({ SHOP: ['status', 'read'] }) : 'team settings\n~/.claude/settings.json: would add 2'
    return { value: { exitCode: e.argv[2] === 'connectors' ? 0 : exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

describe('arguments', () => {
  test('a connector is found by the tools its layer declares', async () => {
    const names = [`mcp__${ID}__status`, `mcp__${ID}__read`, 'mcp__other__read']
    expect(serversWith(['status', 'read'], names)).toEqual([ID])
    expect(serversWith(['read'], names)).toEqual([ID, 'other'])
    expect(connectorArgs({ SHOP: ['status', 'read'], NONE: ['nothing'] }, names)).toEqual(['--connector', `SHOP=${ID}`])
    expect(connectorArgs({ EMPTY: [] }, names)).toEqual([])
  })

  test('the words', async () => {
    expect(mode('')).toBe('check')
    expect(mode('check')).toBe('check')
    expect(mode(' apply ')).toBe('apply')
    expect(mode('save')).toBeNull()
  })
})

test('/settings-sync checks with the connectors this session has', async ($, on) => {
  const runs: string[][] = []
  engine(on, runs)
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })

  const answered = await $.command.run({ command: 'settings-sync', args: '', ...TYPED })

  expect(runs.map(argv => argv.slice(2))).toEqual([['connectors'], ['check', '--connector', `SHOP=${ID}`]])
  expect(runs[1]?.[1]).toMatch(/settings-sync\/sync\.py$/)
  expect(answered.text).toContain('would add 2')
})

test('apply runs it; a failing run says so', async ($, on) => {
  const runs: string[][] = []
  engine(on, runs, 1)
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })

  const answered = await $.command.run({ command: 'settings-sync', args: 'apply', ...TYPED })

  expect(runs[1]?.slice(2)).toEqual(['apply', '--connector', `SHOP=${ID}`])
  expect(answered.text).toContain('(sync.py exited 1)')
})

test('save is not a word the command takes', async ($, on) => {
  const runs: string[][] = []
  engine(on, runs)
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })

  const answered = await $.command.run({ command: 'settings-sync', args: 'save', ...TYPED })

  expect(runs.length).toBe(0)
  expect(answered.text).toContain('Usage:')
})
