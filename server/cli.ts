import { execFile, spawn } from 'node:child_process'
import { HOME, HttpError, checkName, checkScope, projectDir } from './paths.ts'
import { checkSessionId } from './sessions.ts'

// shortcut: resolves claude.exe / the claude binary only; an npm `claude.cmd` shim on Windows would need shell mode.
export function claude(args: string[], project: string | null): Promise<string> {
  const cwd = project ? projectDir(project) : HOME
  return new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      args,
      { cwd, timeout: 180_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(new HttpError(502, (stderr || stdout || err.message).trim())) : resolve(stdout)),
    )
    child.stdin?.end()
  })
}

// Model names may carry a context suffix such as opus[1m].
const MODEL = /^\w[\w.\-[\]]*$/

export const PERMISSION_MODES = ['manual', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions']

/** One chat turn in print mode; stdout is the CLI's stream-json, one event per line. Resuming continues the same transcript the terminal uses. */
export function chat(b: any, project: string | null) {
  if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 100_000) throw new HttpError(400, 'message must be 1 to 100000 characters')
  if (!PERMISSION_MODES.includes(b.permissionMode)) throw new HttpError(400, `invalid permission mode: ${b.permissionMode}`)
  if (b.model && !MODEL.test(b.model)) throw new HttpError(400, `invalid model: ${b.model}`)
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', b.permissionMode]
  if (b.permissionMode === 'bypassPermissions') args.push('--allow-dangerously-skip-permissions')
  if (b.model) args.push('--model', b.model)
  if (b.sessionId) args.push('--resume', checkSessionId(b.sessionId))
  // Same claude-binary shortcut as claude() above.
  const child = spawn('claude', args, { cwd: projectDir(project), windowsHide: true })
  // If claude exits before reading stdin the write fails with EPIPE; the exit code is reported instead.
  child.stdin.on('error', () => {})
  child.stdin.end(b.text)
  return child
}

const PLUGIN_ID =/^\w[\w.-]*(@\w[\w.-]*)?$/
const PLUGIN_ACTIONS = ['install', 'uninstall', 'enable', 'disable', 'update']

let catalog: { at: number; data: unknown } | null = null

export async function availablePlugins(project: string | null) {
  if (!catalog || Date.now() - catalog.at > 5 * 60_000) {
    catalog = { at: Date.now(), data: JSON.parse(await claude(['plugin', 'list', '--json', '--available'], project)).available }
  }
  return catalog.data
}

export function pluginAction(action: unknown, id: unknown, scope: unknown, project: string | null) {
  if (!PLUGIN_ACTIONS.includes(action as string)) throw new HttpError(400, `invalid action: ${action}`)
  if (typeof id !== 'string' || !PLUGIN_ID.test(id)) throw new HttpError(400, `invalid plugin id: ${id}`)
  // No -y: a plugin that runs a marketplace-declared command must be confirmed by a person in the terminal.
  return claude(['plugin', action as string, id, '--scope', checkScope(scope)], project)
}

export async function marketplaceAction(action: unknown, arg: unknown, scope: unknown, project: string | null) {
  catalog = null
  if (action === 'update') return claude(['plugin', 'marketplace', 'update', ...(arg ? [checkName(arg)] : [])], project)
  if (action === 'remove') return claude(['plugin', 'marketplace', 'remove', checkName(arg)], project)
  if (action === 'add') {
    if (typeof arg !== 'string' || !arg.trim() || arg.startsWith('-')) throw new HttpError(400, 'invalid marketplace source')
    return claude(['plugin', 'marketplace', 'add', arg.trim(), '--scope', checkScope(scope)], project)
  }
  throw new HttpError(400, `invalid action: ${action}`)
}

export function addMcp(name: unknown, config: unknown, scope: unknown, project: string | null) {
  if (!config || typeof config !== 'object') throw new HttpError(400, 'config must be a JSON object')
  return claude(['mcp', 'add-json', checkName(name), JSON.stringify(config), '--scope', checkScope(scope)], project)
}

export function removeMcp(name: unknown, scope: unknown, project: string | null) {
  return claude(['mcp', 'remove', checkName(name), '--scope', checkScope(scope)], project)
}
