import fs from 'node:fs'
import path from 'node:path'
import { HttpError, USER_DIR, inside, projectDir } from './paths.ts'

export const PROJECTS_DIR = path.join(USER_DIR, 'projects')
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// shortcut: the CLI shortens very long folder names with a hash; those projects will show no sessions.
export const projectKey = (dir: string) => dir.replace(/[^a-zA-Z0-9]/g, '-')

export function checkSessionId(id: unknown): string {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new HttpError(400, `invalid session id: ${id}`)
  return id
}

function* lines(file: string): Generator<any> {
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l) continue
    try {
      yield JSON.parse(l)
    } catch {}
  }
}

// Transcripts only grow, so a parse is reused until the file's size or mtime changes.
const memo = new Map<string, { key: string; value: unknown }>()
function cached<T>(tag: string, file: string, fn: () => T, st: fs.Stats): T {
  const key = `${st.size}:${st.mtimeMs}`
  const hit = memo.get(tag + file)
  if (hit?.key === key) return hit.value as T
  const value = fn()
  memo.set(tag + file, { key, value })
  return value
}

function sessionsDir(project: string | null) {
  return path.join(PROJECTS_DIR, projectKey(projectDir(project)))
}

/** Text a person typed, or '' for tool results, meta lines and CLI-injected command markup. */
function humanText(l: any): string {
  if (l.type !== 'user' || l.isMeta || l.isSidechain) return ''
  const c = l.message?.content
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') : ''
  return /^<(command-|local-command|system-reminder|bash-)/.test(text) ? '' : text
}

export function listSessions(project: string | null) {
  const dir = sessionsDir(project)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.jsonl') && SESSION_ID.test(f.slice(0, -6)))
    .flatMap(f => {
      const file = path.join(dir, f)
      // The CLI or another tab may delete a transcript between readdir and stat.
      const st = fs.statSync(file, { throwIfNoEntry: false })
      if (!st) return []
      const info = cached('list', file, () => {
        let title = ''
        let first = ''
        let messages = 0
        for (const l of lines(file)) {
          if (l.type === 'ai-title' && l.aiTitle) title = l.aiTitle
          const t = humanText(l)
          if (t) {
            messages++
            first ||= t
          }
        }
        return { title: title || first.slice(0, 80) || '(empty)', messages }
      }, st)
      return [{ id: f.slice(0, -6), updated: st.mtimeMs, ...info }]
    })
    .sort((a, b) => b.updated - a.updated)
}

export type Tool = { id: string; name: string; input: string; result?: string; error?: boolean }
export type Msg = { role: 'user' | 'assistant'; text: string; tools: Tool[] }

const clip = (s: string, n = 2000) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s)

/** Parse transcript lines into chat bubbles: assistant lines sharing a message id merge, tool results join their call. */
export function parseTranscript(rows: Iterable<any>): Msg[] {
  const out: Msg[] = []
  const tools = new Map<string, Tool>()
  let lastId = ''
  for (const l of rows) {
    if (l.isSidechain) continue
    if (l.type === 'user') {
      const text = humanText(l)
      if (text) out.push({ role: 'user', text, tools: [] })
      for (const b of Array.isArray(l.message?.content) ? l.message.content : []) {
        const t = b.type === 'tool_result' && tools.get(b.tool_use_id)
        if (!t) continue
        const c = b.content
        t.result = clip(typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => x.text ?? `[${x.type}]`).join('\n') : '')
        t.error = !!b.is_error
      }
      lastId = ''
    } else if (l.type === 'assistant') {
      const id = l.message?.id ?? ''
      let m = out.at(-1)
      if (!m || m.role !== 'assistant' || !id || id !== lastId) out.push((m = { role: 'assistant', text: '', tools: [] }))
      lastId = id
      for (const b of l.message?.content ?? []) {
        if (b.type === 'text') m.text += (m.text ? '\n\n' : '') + b.text
        if (b.type === 'tool_use') {
          const t = { id: b.id, name: b.name, input: clip(JSON.stringify(b.input, null, 2)) }
          tools.set(b.id, t)
          m.tools.push(t)
        }
      }
    }
  }
  return out.filter(m => m.text || m.tools.length)
}

function sessionFile(project: string | null, id: unknown) {
  const file = inside(sessionsDir(project), checkSessionId(id) + '.jsonl')
  if (!fs.existsSync(file)) throw new HttpError(404, `session ${id} not found in this project`)
  return file
}

export function readSession(project: string | null, id: unknown) {
  return parseTranscript(lines(sessionFile(project, id)))
}

export function deleteSession(project: string | null, id: unknown) {
  const file = sessionFile(project, id)
  fs.rmSync(file)
  // The CLI keeps subagent transcripts and tool output in a folder named after the session.
  fs.rmSync(file.slice(0, -6), { recursive: true, force: true })
}

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }
const zero = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

/** One entry per API request; streamed transcripts repeat the same usage on several lines. */
export function requestUsage(rows: Iterable<any>) {
  const seen = new Map<string, { at: number; u: Usage }>()
  for (const l of rows) {
    const u = l.type === 'assistant' && l.message?.usage
    if (!u) continue
    const key = l.requestId ?? l.message.id ?? l.uuid
    seen.set(key, {
      at: Date.parse(l.timestamp),
      u: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
    })
  }
  return [...seen.values()]
}

let usageCache: { at: number; data: unknown } | null = null

/** Sum requests into the 5-hour and since-midnight windows; a request without a valid timestamp counts nowhere. */
export function sumWindows(entries: { at: number; u: Usage }[], now: number, midnight: number) {
  const fiveHours = zero()
  const today = zero()
  for (const { at, u } of entries) {
    for (const [bucket, from] of [[fiveHours, now - 5 * 3600_000], [today, midnight]] as const) {
      if (!(at >= from)) continue
      bucket.input += u.input
      bucket.output += u.output
      bucket.cacheRead += u.cacheRead
      bucket.cacheWrite += u.cacheWrite
    }
  }
  return { fiveHours, today }
}

/** Session transcripts (<project>/<id>.jsonl) and their subagents (<project>/<id>/subagents/*.jsonl), skipping tool-output folders. */
function transcripts(): string[] {
  const jsonl = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)) : [])
  if (!fs.existsSync(PROJECTS_DIR)) return []
  return fs.readdirSync(PROJECTS_DIR).flatMap(p => {
    const dir = path.join(PROJECTS_DIR, p)
    const main = jsonl(dir)
    return [...main, ...main.flatMap(f => jsonl(path.join(f.slice(0, -6), 'subagents')))]
  })
}

/** Token totals across every local transcript (CLI and hub sessions) for the last 5 hours and since local midnight. */
export function usage(fresh = false) {
  if (!fresh && usageCache && Date.now() - usageCache.at < 10_000) return usageCache.data
  const now = Date.now()
  const midnight = new Date().setHours(0, 0, 0, 0)
  const since = Math.min(midnight, now - 5 * 3600_000)
  const files = transcripts()
  const seen = new Set(files)
  for (const k of memo.keys()) if (!seen.has(k.replace(/^(list|usage)/, ''))) memo.delete(k)
  const entries = files.flatMap(file => {
    const st = fs.statSync(file, { throwIfNoEntry: false })
    return st && st.mtimeMs >= since ? cached('usage', file, () => requestUsage(lines(file)), st) : []
  })
  usageCache = { at: now, data: sumWindows(entries, now, midnight) }
  return usageCache.data
}
