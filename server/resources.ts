import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { HOME, HttpError, USER_DIR, checkName, checkScope, projectDir, readJson, samePath } from './paths.ts'

export type Kind = 'agents' | 'commands' | 'skills'
const KINDS: string[] = ['agents', 'commands', 'skills']

export function frontmatter(text: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  try {
    return (m && parse(m[1])) || {}
  } catch {
    return {}
  }
}

export function kindDir(kind: unknown, scope: unknown, project: string | null): string {
  if (!KINDS.includes(kind as string)) throw new HttpError(400, `invalid kind: ${kind}`)
  const s = checkScope(scope)
  if (s === 'local') throw new HttpError(400, `${kind} have no local scope; use user or project`)
  return path.join(s === 'user' ? USER_DIR : path.join(projectDir(project), '.claude'), kind as string)
}

function itemFile(kind: unknown, scope: unknown, project: string | null, name: unknown): string {
  const dir = kindDir(kind, scope, project)
  const n = checkName(name)
  return kind === 'skills' ? path.join(dir, n, 'SKILL.md') : path.join(dir, n + '.md')
}

// shortcut: only top-level items; nested command namespaces (commands/foo/bar.md) are not listed yet.
export function listItems(kind: unknown, scope: unknown, project: string | null) {
  const dir = kindDir(kind, scope, project)
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []
  return entries.flatMap(e => {
    const file =
      kind === 'skills'
        ? e.isDirectory() && path.join(dir, e.name, 'SKILL.md')
        : e.isFile() && e.name.endsWith('.md') && path.join(dir, e.name)
    if (!file || !fs.existsSync(file)) return []
    const meta = frontmatter(fs.readFileSync(file, 'utf8'))
    const name = kind === 'skills' ? e.name : e.name.slice(0, -3)
    return [{ name, description: String(meta.description ?? ''), path: file }]
  })
}

export function readItem(kind: unknown, scope: unknown, project: string | null, name: unknown) {
  const file = itemFile(kind, scope, project, name)
  if (!fs.existsSync(file)) throw new HttpError(404, `${name} not found`)
  return { path: file, content: fs.readFileSync(file, 'utf8') }
}

export function writeItem(kind: unknown, scope: unknown, project: string | null, name: unknown, content: unknown) {
  if (typeof content !== 'string') throw new HttpError(400, 'content must be a string')
  const file = itemFile(kind, scope, project, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

export function deleteItem(kind: unknown, scope: unknown, project: string | null, name: unknown) {
  const file = itemFile(kind, scope, project, name)
  fs.rmSync(kind === 'skills' ? path.dirname(file) : file, { recursive: true, force: true })
}

const FILES: Record<string, Record<string, (p: string) => string>> = {
  memory: {
    user: () => path.join(USER_DIR, 'CLAUDE.md'),
    project: p => path.join(p, 'CLAUDE.md'),
    local: p => path.join(p, 'CLAUDE.local.md'),
  },
  settings: {
    user: () => path.join(USER_DIR, 'settings.json'),
    project: p => path.join(p, '.claude', 'settings.json'),
    local: p => path.join(p, '.claude', 'settings.local.json'),
  },
}

function configFile(kind: unknown, scope: unknown, project: string | null): string {
  const s = checkScope(scope)
  const f = FILES[kind as string]?.[s]
  if (!f) throw new HttpError(400, `invalid file kind: ${kind}`)
  return f(s === 'user' ? '' : projectDir(project))
}

export function readConfigFile(kind: unknown, scope: unknown, project: string | null) {
  const file = configFile(kind, scope, project)
  return { path: file, content: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' }
}

export function writeConfigFile(kind: unknown, scope: unknown, project: string | null, content: unknown) {
  if (typeof content !== 'string') throw new HttpError(400, 'content must be a string')
  if (kind === 'settings') {
    try {
      JSON.parse(content)
    } catch (e) {
      throw new HttpError(400, `settings is not valid JSON: ${(e as Error).message}`)
    }
  }
  const file = configFile(kind, scope, project)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

/** Model and permission mode from settings files, later ones winning. A repo can never switch chat to bypass on its own. */
export function mergeDefaults(settings: any[]) {
  let model = ''
  let permissionMode = 'manual'
  for (const s of settings) {
    if (typeof s.model === 'string') model = s.model
    const m = s.permissions?.defaultMode
    if (typeof m === 'string') permissionMode = m === 'default' ? 'manual' : m
  }
  if (permissionMode === 'bypassPermissions') permissionMode = 'manual'
  return { model, permissionMode }
}

/** Defaults the CLI would start with here: user, then project, then local settings. */
export function cliDefaults(project: string | null) {
  const files = [FILES.settings.user('')]
  try {
    const p = projectDir(project)
    files.push(FILES.settings.project(p), FILES.settings.local(p))
  } catch {}
  return mergeDefaults(files.map(readJson))
}

/** Read-only view of MCP servers. Writes go through the claude CLI so ~/.claude.json is never rewritten here. */
export function listMcp(project: string | null) {
  const cfg = readJson(path.join(HOME, '.claude.json'))
  const out: { name: string; scope: string; config: unknown }[] = []
  const add = (servers: Record<string, unknown> | undefined, scope: string) => {
    for (const [name, config] of Object.entries(servers ?? {})) out.push({ name, scope, config })
  }
  add(cfg.mcpServers, 'user')
  if (project) {
    const p = projectDir(project)
    const key = Object.keys(cfg.projects ?? {}).find(k => samePath(k, p))
    add(key ? cfg.projects[key].mcpServers : undefined, 'local')
    add(readJson(path.join(p, '.mcp.json')).mcpServers, 'project')
  }
  return out
}
