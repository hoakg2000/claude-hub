import fs from 'node:fs'
import path from 'node:path'
import { HttpError, NAME, inside } from './paths.ts'
import { kindDir, type Kind } from './resources.ts'

export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
const REPO = /^[\w.-]+\/[\w.-]+$/
const MAX_SKILL_FILES = 200

async function gh(url: string): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'claude-hub' }
  if (GITHUB_TOKEN) headers.authorization = `Bearer ${GITHUB_TOKEN}`
  const r = await fetch(url, { headers })
  if (r.ok) return r
  const limited = r.status === 403 || r.status === 429
  const hint = limited && !GITHUB_TOKEN ? ' (rate limited; set GITHUB_TOKEN for higher limits)' : ''
  throw new HttpError(limited ? 429 : 502, `GitHub ${r.status}${hint}: ${(await r.text()).slice(0, 200)}`)
}

function checkRepo(repo: unknown): string {
  if (typeof repo !== 'string' || !REPO.test(repo)) throw new HttpError(400, `invalid repo: ${repo}`)
  return repo
}

export async function searchRepos(q: unknown) {
  if (typeof q !== 'string' || !q.trim()) throw new HttpError(400, 'empty search')
  const r = await gh(`https://api.github.com/search/repositories?per_page=30&sort=stars&q=${encodeURIComponent(q + ' claude')}`)
  const items: any[] = (await r.json()).items
  return items.map(i => ({ repo: i.full_name, description: i.description, stars: i.stargazers_count, url: i.html_url }))
}

export type RemoteItem = { kind: Kind; name: string; path: string }

/** Find skills (dirs holding SKILL.md), agents (agents/*.md) and commands (commands/*.md) in a repo file list. */
export function detectItems(files: string[], repo: string): RemoteItem[] {
  const items: RemoteItem[] = []
  for (const f of files) {
    const parts = f.split('/')
    const file = parts.at(-1)!
    const parent = parts.at(-2)
    if (file === 'SKILL.md') {
      items.push({ kind: 'skills', name: parent ?? repo.split('/')[1], path: parts.slice(0, -1).join('/') })
    } else if ((parent === 'agents' || parent === 'commands') && file.endsWith('.md') && file !== 'README.md') {
      items.push({ kind: parent, name: file.slice(0, -3), path: f })
    }
  }
  return items.filter(i => NAME.test(i.name))
}

/** Files that belong to a skill folder. A skill at the repo root must not swallow other items or git/CI files. */
export function filesOfSkill(files: string[], skill: RemoteItem, items: RemoteItem[]): string[] {
  if (skill.path) return files.filter(f => f.startsWith(skill.path + '/'))
  const others = items.filter(i => i.path).map(i => (i.kind === 'skills' ? i.path + '/' : i.path))
  return files.filter(f => !/^\.git/.test(f) && !others.some(o => f === o || f.startsWith(o)))
}

const trees = new Map<string, { at: number; branch: string; files: string[]; truncated: boolean }>()

async function tree(repo: string) {
  const hit = trees.get(repo)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit
  const { default_branch: branch } = await (await gh(`https://api.github.com/repos/${repo}`)).json()
  const t = await (await gh(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`)).json()
  const files = (t.tree as any[]).filter(e => e.type === 'blob').map(e => e.path as string)
  const entry = { at: Date.now(), branch, files, truncated: !!t.truncated }
  trees.set(repo, entry)
  return entry
}

export async function scanRepo(repo: unknown) {
  const r = checkRepo(repo)
  const { branch, files, truncated } = await tree(r)
  return { repo: r, branch, truncated, isMarketplace: files.includes('.claude-plugin/marketplace.json'), items: detectItems(files, r) }
}

async function raw(repo: string, branch: string, file: string): Promise<Buffer> {
  const url = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/${file.split('/').map(encodeURIComponent).join('/')}`
  const r = await fetch(url, { headers: { 'user-agent': 'claude-hub' } })
  if (!r.ok) throw new HttpError(502, `download failed ${r.status}: ${file}`)
  return Buffer.from(await r.arrayBuffer())
}

export async function readRemote(repo: unknown, file: unknown) {
  const r = checkRepo(repo)
  const { branch, files } = await tree(r)
  if (typeof file !== 'string' || !files.includes(file)) throw new HttpError(404, `not in repo: ${file}`)
  return { content: (await raw(r, branch, file)).toString('utf8') }
}

export async function installItem(b: any, project: string | null) {
  const repo = checkRepo(b.repo)
  const { branch, files } = await tree(repo)
  const item = detectItems(files, repo).find(i => i.kind === b.kind && i.path === b.path)
  if (!item) throw new HttpError(404, `${b.kind} not found in ${repo}: ${b.path}`)
  const dir = kindDir(item.kind, b.scope, project)

  if (item.kind !== 'skills') {
    const dest = path.join(dir, item.name + '.md')
    if (fs.existsSync(dest) && !b.overwrite) throw new HttpError(409, `${item.name} already exists in this scope`)
    const content = await raw(repo, branch, item.path)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(dest, content)
    return { path: dest }
  }

  const dest = path.join(dir, item.name)
  if (fs.existsSync(dest) && !b.overwrite) throw new HttpError(409, `skill ${item.name} already exists in this scope`)
  const prefix = item.path ? item.path + '/' : ''
  const skillFiles = filesOfSkill(files, item, detectItems(files, repo))
  if (skillFiles.length > MAX_SKILL_FILES) throw new HttpError(400, `skill has ${skillFiles.length} files; refusing over ${MAX_SKILL_FILES}`)
  // Download everything first so a failed fetch never leaves an existing skill half-replaced.
  const downloaded = await Promise.all(skillFiles.map(async f => [inside(dest, f.slice(prefix.length)), await raw(repo, branch, f)] as const))
  fs.rmSync(dest, { recursive: true, force: true })
  for (const [target, content] of downloaded) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  return { path: dest }
}
