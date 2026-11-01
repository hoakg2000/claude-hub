import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { api, confirmLeave, setProject, unsaved, type Run, type Scope } from './api'
import Chat, { type TurnResult } from './Chat'
import Community from './Community'
import { FileTab, ItemsTab } from './Local'
import Mcp from './Mcp'
import Plugins from './Plugins'
import Usage, { type Limits, type SessionUsage } from './Usage'

const TABS = ['Chat', 'Agents', 'Skills', 'Commands', 'Memory', 'Settings', 'MCP', 'Plugins', 'Community'] as const
type Tab = (typeof TABS)[number]
// Agents, skills and commands only exist in user and project scope.
const NO_LOCAL: Tab[] = ['Agents', 'Skills', 'Commands', 'Community']

const SCOPES: { id: Scope; label: string; hint: string }[] = [
  { id: 'user', label: 'User', hint: '~/.claude — all your projects' },
  { id: 'project', label: 'Project', hint: '.claude/ in the project — shared via git' },
  { id: 'local', label: 'Local', hint: 'this project, only you — not committed' },
]

function stored(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

/** Arrow/Home/End move between buttons of a tablist or radiogroup, as the ARIA patterns expect. */
function arrowKeys(e: KeyboardEvent<HTMLElement>) {
  const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
  const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: buttons.length - 1 }[e.key]
  if (next === undefined || i < 0) return
  e.preventDefault()
  const b = buttons[(next + buttons.length) % buttons.length]
  b.focus()
  b.click()
}

const NO_USAGE: SessionUsage = { input: 0, output: 0, cost: 0 }

export default function App() {
  const [project, setProjectState] = useState(stored('hub-project'))
  const [draft, setDraft] = useState(project)
  const [scope, setScope] = useState<Scope>('user')
  const [tab, setTab] = useState<Tab>('Chat')
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'busy'; text: string } | null>(null)
  const [github, setGithub] = useState(false)
  const [defaults, setDefaults] = useState<{ model: string; permissionMode: string } | null>(null)
  const [chatUsage, setChatUsage] = useState(NO_USAGE)
  const [limits, setLimits] = useState<Limits>(null)
  const [usageTick, setUsageTick] = useState(0)
  const hideTimer = useRef(0)
  const chatLive = useRef(false)

  setProject(project)

  const applyProject = (p: string) => {
    if (!confirmLeave() || (chatLive.current && !confirm('A reply is still running. Stop it and switch folder?'))) return setDraft(project)
    unsaved.current = false
    setProject(p)
    setProjectState(p)
    setDraft(p)
    setDefaults(null)
    setChatUsage(NO_USAGE)
    try {
      localStorage.setItem('hub-project', p)
    } catch {}
  }

  useEffect(() => {
    let cancelled = false // a slower reply for an older project must not overwrite this one
    api('GET', '/api/context')
      .then(c => {
        if (cancelled) return
        setGithub(c.github)
        setDefaults(c.defaults)
        if (!project) applyProject(c.cwd)
      })
      .catch(e => !cancelled && setStatus({ kind: 'err', text: e.message }))
    return () => {
      cancelled = true
    }
  }, [project])

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => unsaved.current && e.preventDefault()
    addEventListener('beforeunload', warn)
    return () => removeEventListener('beforeunload', warn)
  }, [])

  const showStatus = (s: typeof status) => {
    clearTimeout(hideTimer.current)
    setStatus(s)
    if (s?.kind === 'ok') hideTimer.current = window.setTimeout(() => setStatus(null), 4000)
  }

  const [busy, setBusy] = useState(false)
  const run: Run = async (fn, done) => {
    setBusy(true)
    showStatus({ kind: 'busy', text: 'Working…' })
    try {
      await fn()
      showStatus(done ? { kind: 'ok', text: done } : null)
    } catch (e) {
      showStatus({ kind: 'err', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const switchTab = (t: Tab) => {
    if (t === tab || !confirmLeave()) return
    unsaved.current = false
    setTab(t)
    if (NO_LOCAL.includes(t) && scope === 'local') setScope('project')
    if (status?.kind !== 'busy') showStatus(null)
  }

  const switchScope = (s: Scope) => {
    if (s === scope || !confirmLeave()) return
    unsaved.current = false
    setScope(s)
  }

  // modelUsage and total_cost_usd already cover the whole session (earlier turns too), so they replace, not add.
  const onResult = (r: TurnResult) => {
    const models = Object.values(r.modelUsage ?? {})
    const sum = (k: string) => models.reduce((n, m) => n + (m[k] ?? 0), 0)
    setChatUsage({
      input: sum('inputTokens') + sum('cacheReadInputTokens') + sum('cacheCreationInputTokens'),
      output: sum('outputTokens'),
      cost: r.total_cost_usd ?? 0,
    })
    setUsageTick(t => t + 1)
  }

  const key = `${tab}|${scope}|${project}`
  const props = { scope, run, busy }
  const scopeHint = SCOPES.find(s => s.id === scope)!.hint

  return (
    <div className="app">
      <header>
        <h1>Claude Hub</h1>
        <form
          className="project"
          onSubmit={e => {
            e.preventDefault()
            applyProject(draft.trim())
          }}
        >
          <label htmlFor="project">Project</label>
          <input id="project" value={draft} onChange={e => setDraft(e.target.value)} placeholder="C:\path\to\project" />
          <button type="submit" disabled={!draft.trim() || draft.trim() === project}>
            Open
          </button>
        </form>
        <Usage session={chatUsage} limits={limits} tick={usageTick} />
      </header>

      <nav role="tablist" aria-label="Sections" onKeyDown={arrowKeys}>
        {TABS.map(t => (
          <button
            key={t}
            id={`tab-${t}`}
            role="tab"
            aria-selected={tab === t}
            aria-controls={`panel-${t}`}
            tabIndex={tab === t ? 0 : -1}
            className={tab === t ? 'on' : ''}
            onClick={() => switchTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>

      {tab !== 'Chat' && (
          <div className="scopebar">
            <div className="scopes" role="radiogroup" aria-label="Scope" onKeyDown={arrowKeys}>
              {SCOPES.map(s => (
                <button
                  key={s.id}
                  role="radio"
                  aria-checked={scope === s.id}
                  tabIndex={scope === s.id ? 0 : -1}
                  className={scope === s.id ? 'on' : ''}
                  disabled={s.id === 'local' && NO_LOCAL.includes(tab)}
                  title={s.id === 'local' && NO_LOCAL.includes(tab) ? `${tab} have no local scope` : s.hint}
                  onClick={() => switchScope(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <span className="hint">{scopeHint}</span>
          </div>
      )}

      <div className="status-slot">
        {status && (
          <div className={`status ${status.kind}`} role={status.kind === 'err' ? 'alert' : 'status'}>
            <span>{status.text}</span>
            <button className="link" onClick={() => showStatus(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
      </div>

      {/* Chat stays mounted across tabs so a running reply is not cut off. */}
      <div id="panel-Chat" role="tabpanel" aria-labelledby="tab-Chat" hidden={tab !== 'Chat'}>
        {defaults && project && (
          <Chat
            key={project}
            project={project}
            defaults={defaults}
            onCd={applyProject}
            onResult={onResult}
            onLimits={l => setLimits(l as Limits)}
            onSession={() => setChatUsage(NO_USAGE)}
            onLive={l => (chatLive.current = l)}
          />
        )}
      </div>

      {tab !== 'Chat' && (
        <main key={key} id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === 'Agents' && <ItemsTab kind="agents" {...props} />}
          {tab === 'Skills' && <ItemsTab kind="skills" {...props} />}
          {tab === 'Commands' && <ItemsTab kind="commands" {...props} />}
          {tab === 'Memory' && <FileTab kind="memory" {...props} />}
          {tab === 'Settings' && <FileTab kind="settings" {...props} />}
          {tab === 'MCP' && <Mcp {...props} />}
          {tab === 'Plugins' && <Plugins {...props} />}
          {tab === 'Community' && <Community {...props} github={github} />}
        </main>
      )}
    </div>
  )
}
