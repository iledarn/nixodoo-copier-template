// PostToolUse under Antigravity: mask secrets in a tool's result before the model reads it.
// The rules are the redact-secrets mod's (.claude/skills/redact-secrets), one copy for both agents.
// NOTE: Disabled in .agents/hooks.json because Antigravity's jsonhook.dropUnsupportedFields strips
// PostToolHookArgs.result before invoking hooks.json PostToolUse commands and ignores overwriteResult.
import { redactText } from '../../.claude/skills/redact-secrets/hooks/redact'

let out = {}
try {
  const data = JSON.parse((await Bun.stdin.text()) || '{}')
  const result = (data.postToolHookArgs ?? data).result
  if (typeof result === 'string') {
    const done = redactText(result)
    if (done.count > 0) out = { overwriteResult: done.text }
  }
} catch (error) {
  console.error(`redact.ts: ${error}`)
}
console.log(JSON.stringify(out))
