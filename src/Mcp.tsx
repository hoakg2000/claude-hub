import { useState } from 'react'
import { api, qs, useResource, type Scope, type TabProps } from './api'

type Server = { name: string; scope: Scope; config: Record<string, unknown> }

const EXAMPLE = JSON.stringify({ type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] }, null, 2)

export default function Mcp({ scope, run, busy }: TabProps) {
  const servers = useResource<Server[]>(() => api('GET', '/api/mcp'), [])
  const [name, setName] = useState('')
  const [json, setJson] = useState(EXAMPLE)

  let config: unknown = null
  try {
    config = JSON.parse(json)
  } catch {}

  const add = () =>
    run(async () => {
      await api('POST', '/api/mcp', { name, scope, config })
      setName('')
      await servers.reload()
    }, `Added ${name} to ${scope} scope`)

  const remove = (s: Server) => {
    if (!confirm(`Remove MCP server "${s.name}" from ${s.scope} scope?`)) return
    run(async () => {
      await api('DELETE', `/api/mcp?${qs({ name: s.name, scope: s.scope })}`)
      await servers.reload()
    }, `Removed ${s.name}`)
  }

  return (
    <div className="stack">
      <section>
        <h2>Configured servers (all scopes)</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Scope</th>
                <th>Command / URL</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {servers.data.map(s => (
                <tr key={s.scope + s.name}>
                  <td>{s.name}</td>
                  <td>
                    <span className="badge">{s.scope}</span>
                  </td>
                  <td>
                    <code>{String(s.config.url ?? [s.config.command, ...((s.config.args as string[]) ?? [])].join(' '))}</code>
                  </td>
                  <td className="actions">
                    <button className="danger" disabled={busy} onClick={() => remove(s)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {servers.loading && !servers.data.length && <p className="empty">Loading…</p>}
        {servers.error && <p className="err-text">{servers.error}</p>}
        {!servers.loading && !servers.error && !servers.data.length && <p className="empty">No MCP servers in user, local or project scope.</p>}
      </section>
      <section>
        <h2>Add server to {scope} scope</h2>
        <form
          onSubmit={e => {
            e.preventDefault()
            add()
          }}
        >
          <div className="row">
            <label htmlFor="mcp-name">Name</label>
            <input id="mcp-name" value={name} onChange={e => setName(e.target.value)} placeholder="filesystem" />
          </div>
          <textarea
            className="short"
            aria-label="Server JSON config"
            aria-invalid={!config}
            aria-describedby="mcp-json-err"
            value={json}
            onChange={e => setJson(e.target.value)}
            spellCheck={false}
          />
          {!config && (
            <p id="mcp-json-err" className="err-text">
              Config is not valid JSON.
            </p>
          )}
          <p className="hint">
            Same format as <code>claude mcp add-json</code>. HTTP servers: <code>{'{"type":"http","url":"https://…"}'}</code>
          </p>
          <button type="submit" className="primary" disabled={!name || !config || busy}>
            Add server to {scope}
          </button>
        </form>
      </section>
    </div>
  )
}
