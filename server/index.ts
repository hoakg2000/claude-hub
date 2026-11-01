#!/usr/bin/env node
import './env.ts'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { addMcp, availablePlugins, chat, claude, marketplaceAction, pluginAction, removeMcp } from './cli.ts'
import { GITHUB_TOKEN, installItem, readRemote, scanRepo, searchRepos } from './github.ts'
import { HOME, HttpError, inside, projectDir } from './paths.ts'
import { deleteSession, listSessions, readSession, usage } from './sessions.ts'
import {
  cliDefaults,
  deleteItem,
  listItems,
  listMcp,
  readConfigFile,
  readItem,
  writeConfigFile,
  writeItem,
} from './resources.ts'

const PORT = Number(process.env.PORT) || 4178
const TOKEN = crypto.randomBytes(16).toString('hex')
const DIST = path.join(import.meta.dirname, '..', 'dist')
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

type Route = (q: URLSearchParams, body: any, project: string | null) => unknown

const routes: Record<string, Route> = {
  'GET /api/context': (_, __, p) => ({ home: HOME, cwd: process.cwd(), github: !!GITHUB_TOKEN, defaults: cliDefaults(p) }),

  'GET /api/sessions': (_, __, p) => listSessions(p),
  'GET /api/session': (q, _, p) => readSession(p, q.get('id')),
  'DELETE /api/session': (q, _, p) => deleteSession(p, q.get('id')),
  'GET /api/usage': q => usage(q.get('fresh') === '1'),
  'GET /api/resolve': (q, _, p) => ({ path: projectDir(path.resolve(projectDir(p), q.get('path') ?? '')) }),

  'GET /api/items': (q, _, p) => listItems(q.get('kind'), q.get('scope'), p),
  'GET /api/item': (q, _, p) => readItem(q.get('kind'), q.get('scope'), p, q.get('name')),
  'PUT /api/item': (_, b, p) => writeItem(b.kind, b.scope, p, b.name, b.content),
  'DELETE /api/item': (q, _, p) => deleteItem(q.get('kind'), q.get('scope'), p, q.get('name')),

  'GET /api/file': (q, _, p) => readConfigFile(q.get('kind'), q.get('scope'), p),
  'PUT /api/file': (_, b, p) => writeConfigFile(b.kind, b.scope, p, b.content),

  'GET /api/mcp': (_, __, p) => listMcp(p),
  'POST /api/mcp': (_, b, p) => addMcp(b.name, b.config, b.scope, p),
  'DELETE /api/mcp': (q, _, p) => removeMcp(q.get('name'), q.get('scope'), p),

  'GET /api/plugins': async (_, __, p) => JSON.parse(await claude(['plugin', 'list', '--json'], p)),
  'GET /api/plugins/available': (_, __, p) => availablePlugins(p),
  'POST /api/plugins': (_, b, p) => pluginAction(b.action, b.id, b.scope, p),
  'GET /api/marketplaces': async (_, __, p) => JSON.parse(await claude(['plugin', 'marketplace', 'list', '--json'], p)),
  'POST /api/marketplaces': (_, b, p) => marketplaceAction(b.action, b.arg, b.scope, p),

  'GET /api/gh/search': q => searchRepos(q.get('q')),
  'GET /api/gh/scan': q => scanRepo(q.get('repo')),
  'GET /api/gh/file': q => readRemote(q.get('repo'), q.get('path')),
  'POST /api/gh/install': (_, b, p) => installItem(b, p),
}

function send(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(data ?? { ok: true }))
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const c of req) {
    if ((size += c.length) > 5_000_000) throw new HttpError(413, 'body too large')
    chunks.push(c)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    throw new HttpError(400, 'body is not JSON')
  }
}

/** Pipe the CLI's NDJSON events to the browser. Closing the request (Stop button) kills the run. */
async function streamChat(req: http.IncomingMessage, res: http.ServerResponse, project: string | null) {
  const child = chat(await readBody(req), project)
  let stderr = ''
  child.stderr.on('data', d => (stderr = (stderr + d).slice(-4000)))
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  child.stdout.pipe(res, { end: false })
  let done = false
  // A spawn failure may emit 'error' and then 'close', so the reply is finished exactly once.
  const finish = (error?: string) => {
    if (done) return
    done = true
    if (error) res.write(JSON.stringify({ type: 'hub_error', error }) + '\n')
    res.end()
  }
  child.on('error', e => finish(`could not start claude: ${e.message}`))
  child.on('close', code => finish(code ? stderr.trim() || `claude exited with code ${code}` : undefined))
  res.on('close', () => {
    if (done || child.exitCode !== null) return
    // On Windows kill() stops only claude.exe; /T also ends the shells and MCP servers it started.
    if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {})
    else child.kill()
  })
}

function serveStatic(pathname: string, res: http.ServerResponse) {
  let file = path.join(DIST, 'index.html')
  try {
    const candidate = inside(DIST, '.' + decodeURIComponent(pathname))
    if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) file = candidate
  } catch {}
  if (!fs.existsSync(file)) return send(res, 404, { error: 'UI not built; run `npm run build` or use `npm run dev`' })
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
}

http
  .createServer(async (req, res) => {
    // Answer only requests addressed to loopback, which blocks DNS-rebinding pages from reaching the API.
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? '')) return send(res, 403, { error: 'bad host' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res)
    // The token only reaches pages opened from the printed URL, so other sites cannot call the API.
    if (req.headers['x-hub-token'] !== TOKEN) return send(res, 401, { error: 'missing or wrong token; reopen the URL printed in the terminal' })
    const project = url.searchParams.get('project') || null
    const route = routes[`${req.method} ${url.pathname}`]
    if (!route && !(req.method === 'POST' && url.pathname === '/api/chat')) return send(res, 404, { error: 'no such endpoint' })
    try {
      if (!route) return await streamChat(req, res, project)
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req)
      send(res, 200, await route(url.searchParams, body, project))
    } catch (e) {
      send(res, e instanceof HttpError ? e.status : 500, { error: (e as Error).message })
    }
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`Claude Hub running: http://127.0.0.1:${PORT}/?token=${TOKEN}`)
    if (!fs.existsSync(DIST)) console.log(`Dev UI (npm run dev):  http://localhost:5173/?token=${TOKEN}`)
  })
