import { useEffect, useRef, useState } from 'react'
import { api, qs, stream, useResource } from './api'

type Tool = { id: string; name: string; input: string; result?: string; error?: boolean }
type Msg = { role: 'user' | 'assistant' | 'note'; text: string; tools: Tool[] }
type Session = { id: string; title: string; updated: number; messages: number }
export type TurnResult = { modelUsage?: Record<string, Record<string, number>>; total_cost_usd?: number }

export const MODES = ['manual', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions']
const MODELS = ['opus', 'sonnet', 'haiku']

const HELP = `Commands handled here:
  /new, /clear      start a new session
  /resume           jump to the session list
  /cd <folder>      switch the working folder (project)
  /model <name>     set the model (empty = your settings default)
  /mode <mode>      set the permission mode: ${MODES.join(', ')}
  /help             this list
Any other /command (skills, custom commands) goes to Claude Code as usual.`

function ago(ms: number) {
  const s = (Date.now() - ms) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(ms).toLocaleDateString()
}

/** One-line hint for a tool call: the command, file or pattern it acts on. */
function toolHint(input: string) {
  try {
    const i = JSON.parse(input)
    return String(i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.description ?? '').split('\n')[0]
  } catch {
    return ''
  }
}

type Props = {
  project: string
  defaults: { model: string; permissionMode: string }
  onCd: (dir: string) => void
  onResult: (r: TurnResult) => void
  onLimits: (l: unknown) => void
  onSession: () => void
  onLive: (live: boolean) => void
}

/** One open conversation. Each keeps its own messages and run, so a reply keeps streaming while another is shown. */
type View = { sessionId: string | null; msgs: Msg[]; live: boolean; loading?: boolean; result?: TurnResult }
const EMPTY: View = { sessionId: null, msgs: [], live: false }

export default function Chat({ project, defaults, onCd, onResult, onLimits, onSession, onLive }: Props) {
  const sessions = useResource<Session[]>(() => api('GET', '/api/sessions'), [])
  const [views, setViews] = useState<Record<string, View>>({ v0: EMPTY })
  const [cur, setCur] = useState('v0')
  // Stream callbacks outlive renders; they read the shown view from here, not from a stale closure.
  const curRef = useRef(cur)
  curRef.current = cur
  const nextKey = useRef(1)
  const { sessionId, msgs, live, loading: loadingSession } = views[cur]
  const [input, setInput] = useState('')
  const [mode, setMode] = useState(MODES.includes(defaults.permissionMode) ? defaults.permissionMode : 'manual')
  const [model, setModel] = useState('')
  const aborts = useRef(new Map<string, AbortController>())
  const scroller = useRef<HTMLDivElement>(null)
  // Follow new output only while the reader is at the bottom; scrolling up to read stops the follow.
  const stick = useRef(true)
  const list = useRef<HTMLUListElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [msgs])
  const anyLive = Object.values(views).some(v => v.live)
  useEffect(() => {
    onLive(anyLive)
  }, [anyLive])
  useEffect(() => () => onLive(false), [])
  useEffect(() => () => aborts.current.forEach(a => a.abort()), [])

  const patch = (key: string, f: (v: View) => View) => setViews(vs => (vs[key] ? { ...vs, [key]: f(vs[key]) } : vs))
  const setMsgsOf = (key: string, f: (ms: Msg[]) => Msg[]) => patch(key, v => ({ ...v, msgs: f(v.msgs) }))
  const note = (text: string, key = curRef.current) => setMsgsOf(key, m => [...m, { role: 'note', text, tools: [] }])

  /** Show a view: restore its usage numbers and drop the one we leave if it was an untouched new chat. */
  const show = (key: string, view: View = EMPTY) => {
    const prev = curRef.current
    setViews(vs => {
      const next = { ...vs, [key]: vs[key] ?? view }
      const p = next[prev]
      if (prev !== key && p && !p.live && !p.sessionId && !p.msgs.length) delete next[prev]
      return next
    })
    const result = views[key]?.result
    result ? onResult(result) : onSession()
    curRef.current = key
    setCur(key)
    stick.current = true
  }

  const onEvent = (key: string, mode: string) => (e: any) => {
    /** Apply f to the assistant bubble being streamed, starting one if the last bubble is not it. */
    const patchLast = (f: (m: Msg) => Msg) =>
      setMsgsOf(key, ms => {
        const last = ms.at(-1)
        return last?.role === 'assistant' ? [...ms.slice(0, -1), f(last)] : [...ms, f({ role: 'assistant', text: '', tools: [] })]
      })
    const setMsgs = (f: (ms: Msg[]) => Msg[]) => setMsgsOf(key, f)
    if (e.parent_tool_use_id) return // subagent traffic; the CLI shows only its final answer too
    if (e.type === 'system' && e.subtype === 'init') {
      patch(key, v => ({ ...v, sessionId: e.session_id }))
      sessions.reload() // a new session now has a transcript, so it can show in the list as running
    } else if (e.type === 'stream_event' && e.event?.type === 'message_start') {
      setMsgs(ms => [...ms, { role: 'assistant', text: '', tools: [] }])
    } else if (e.type === 'stream_event' && e.event?.delta?.type === 'text_delta') {
      patchLast(m => ({ ...m, text: m.text + e.event.delta.text }))
    } else if (e.type === 'assistant') {
      patchLast(m => {
        const blocks: any[] = e.message?.content ?? []
        const text = m.text || blocks.filter(b => b.type === 'text').map(b => b.text).join('\n\n')
        const tools = [...m.tools]
        for (const b of blocks)
          if (b.type === 'tool_use' && !tools.some(t => t.id === b.id)) tools.push({ id: b.id, name: b.name, input: JSON.stringify(b.input, null, 2) })
        return { ...m, text, tools }
      })
    } else if (e.type === 'user') {
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b.type !== 'tool_result') continue
        const result = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x: any) => x.text ?? `[${x.type}]`).join('\n')
        setMsgs(ms => ms.map(m => (m.tools.some(t => t.id === b.tool_use_id) ? { ...m, tools: m.tools.map(t => (t.id === b.tool_use_id ? { ...t, result, error: !!b.is_error } : t)) } : m)))
      }
    } else if (e.type === 'rate_limit_event') {
      onLimits(e.rate_limit_info)
    } else if (e.type === 'result') {
      patch(key, v => ({ ...v, sessionId: e.session_id, result: e }))
      if (key === curRef.current) onResult(e)
      if (e.is_error) note(`Error: ${e.result ?? e.subtype}`, key)
      if (e.permission_denials?.length)
        note(`Denied by permission mode "${mode}": ${e.permission_denials.map((d: any) => d.tool_name).join(', ')}. Switch mode to allow.`, key)
    } else if (e.type === 'hub_error') {
      note(`Error: ${e.error}`, key)
    }
  }

  const send = async (text: string) => {
    const key = cur
    stick.current = true
    patch(key, v => ({ ...v, live: true, msgs: [...v.msgs, { role: 'user', text, tools: [] }] }))
    const ac = new AbortController()
    aborts.current.set(key, ac)
    try {
      await stream('/api/chat', { text, sessionId, permissionMode: mode, model: model || undefined }, onEvent(key, mode), ac.signal)
    } catch (e) {
      note((e as Error).name === 'AbortError' ? 'Stopped.' : `Error: ${(e as Error).message}`, key)
    } finally {
      aborts.current.delete(key)
      patch(key, v => ({ ...v, live: false }))
      sessions.reload()
      if (key === curRef.current) box.current?.focus()
    }
  }

  const newSession = () => {
    show(`v${nextKey.current++}`)
    box.current?.focus()
  }

  const open = async (id: string) => {
    // A view already showing this session is reused; a running one is shown as is, an idle one is reloaded from disk.
    const existing = Object.keys(views).find(k => views[k].sessionId === id)
    if (existing && views[existing].live) return show(existing)
    const key = existing ?? `v${nextKey.current++}`
    show(key, { sessionId: id, msgs: [], live: false })
    patch(key, v => ({ ...v, msgs: [], loading: true }))
    try {
      const msgs = await api('GET', `/api/session?${qs({ id })}`)
      setMsgsOf(key, () => msgs)
    } catch (e) {
      note(`Error: ${(e as Error).message}`, key)
    } finally {
      patch(key, v => ({ ...v, loading: false }))
    }
  }

  const remove = async (s: Session) => {
    if (!confirm(`Delete session "${s.title}"? Its transcript is removed from disk and cannot be resumed again.`)) return
    try {
      await api('DELETE', `/api/session?${qs({ id: s.id })}`)
      const key = Object.keys(views).find(k => views[k].sessionId === s.id)
      if (key === cur) newSession()
      if (key) setViews(({ [key]: _, ...rest }) => rest)
      sessions.reload()
    } catch (e) {
      note(`Error: ${(e as Error).message}`)
    }
  }

  const submit = () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    const [cmd] = text.split(/\s/)
    const arg = text.slice(cmd.length).trim()
    switch (cmd) {
      case '/new':
      case '/clear':
        return newSession()
      case '/resume':
        return list.current?.querySelector('button')?.focus()
      case '/help':
        return note(HELP)
      case '/cd':
        if (!arg) return note(`Working folder: ${project}`)
        return api('GET', `/api/resolve?${qs({ path: arg })}`).then(
          r => onCd(r.path),
          e => note(`cd: ${e.message}`),
        )
      case '/model':
        setModel(arg)
        return note(`Model: ${arg || 'settings default'}`)
      case '/mode':
        if (!MODES.includes(arg)) return note(`Unknown mode "${arg}". Use one of: ${MODES.join(', ')}`)
        setMode(arg)
        return note(`Permission mode: ${arg}`)
    }
    if (live) return setInput(text) // this session is still answering; keep the draft
    send(text)
  }
  const liveIds = new Set(Object.values(views).filter(v => v.live).map(v => v.sessionId))

  const current = sessions.data.find(s => s.id === sessionId)
  const shown = msgs.filter(m => m.text || m.tools.length)

  return (
    <div className="split chat">
      <aside>
        <div className="row">
          <h2 className="grow">Sessions</h2>
          <button onClick={newSession}>
            + New
          </button>
        </div>
        <ul className="list" ref={list}>
          {sessions.data.map(s => (
            <li key={s.id} className="with-action">
              <button className={s.id === sessionId ? 'on' : ''} aria-current={s.id === sessionId || undefined} onClick={() => open(s.id)}>
                <span className="name">{s.title}</span>
                <span className="desc">
                  {liveIds.has(s.id) ? <span className="warn">● running · </span> : null}
                  {ago(s.updated)} · {s.messages} prompts
                </span>
              </button>
              <button className="link danger" aria-label={`Delete session ${s.title}`} title={liveIds.has(s.id) ? 'Stop the reply before deleting' : 'Delete session'} disabled={liveIds.has(s.id)} onClick={() => remove(s)}>
                ×
              </button>
            </li>
          ))}
        </ul>
        {sessions.loading && !sessions.data.length && <p className="empty">Loading…</p>}
        {sessions.error && <p className="err-text">{sessions.error}</p>}
        {!sessions.loading && !sessions.error && !sessions.data.length && <p className="empty">No sessions in this folder yet. Say something to start one.</p>}
      </aside>

      <section className="chat-main">
        <div className="row">
          <code className="path" title="Working folder (/cd to change)">
            {project}
          </code>
          <span className="grow" />
          <label>
            Mode{' '}
            <select value={mode} onChange={e => setMode(e.target.value)} disabled={live}>
              {MODES.map(m => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label>
            Model{' '}
            <select value={model} onChange={e => setModel(e.target.value)} disabled={live}>
              <option value="">{defaults.model ? `default (${defaults.model})` : 'default'}</option>
              {[...new Set([...MODELS, model].filter(Boolean))].map(m => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
        </div>
        {mode === 'bypassPermissions' && <p className="hint warn">Bypass mode: Claude can run any command and edit any file without asking.</p>}
        <p className="hint">{current ? current.title : sessionId ? 'Resumed session' : 'New session'} · Same sessions as <code>claude --resume</code></p>

        <div
          className="messages"
          ref={scroller}
          aria-live="polite"
          aria-busy={live}
          onScroll={e => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
          {loadingSession && <p className="empty">Loading session…</p>}
          {!shown.length && !loadingSession && <p className="empty">Ask Claude anything about this folder. Type /help for commands.</p>}
          {shown.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.text && <div className="text">{m.text}</div>}
              {m.tools.map(t => (
                <details key={t.id} className={t.error ? 'tool err' : 'tool'}>
                  <summary>
                    <strong>{t.name}</strong> <span className="muted">{toolHint(t.input)}</span>
                    {t.result === undefined && live && <span className="muted"> · running…</span>}
                  </summary>
                  <pre>{t.input}</pre>
                  {t.result !== undefined && <pre className="result">{t.result || '(no output)'}</pre>}
                </details>
              ))}
            </div>
          ))}
          {live && shown.at(-1)?.role !== 'assistant' && <p className="muted">Claude is thinking…</p>}
        </div>

        <form
          className="composer"
          onSubmit={e => {
            e.preventDefault()
            submit()
          }}
        >
          <textarea
            ref={box}
            aria-label="Message"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder="Message Claude… (Enter to send, Shift+Enter for a new line, /help for commands)"
            spellCheck={false}
          />
          {live ? (
            <button type="button" className="danger" onClick={() => aborts.current.get(cur)?.abort()}>
              Stop
            </button>
          ) : (
            <button type="submit" className="primary" disabled={!input.trim()}>
              Send
            </button>
          )}
        </form>
      </section>
    </div>
  )
}
