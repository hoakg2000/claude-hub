import { useEffect, useState } from 'react'
import { api, type Scope, type TabProps } from './api'

type Installed = { id: string; version: string; scope: Scope; enabled: boolean }
type Available = { pluginId: string; name: string; description?: string; marketplaceName: string; installCount?: number }
type Market = { name: string; repo?: string; url?: string; source: string }

export default function Plugins({ scope, run, busy }: TabProps) {
  const [loaded, setLoaded] = useState({ installed: false, available: false })
  const [error, setError] = useState('')
  const [installed, setInstalled] = useState<Installed[]>([])
  const [markets, setMarkets] = useState<Market[]>([])
  const [available, setAvailable] = useState<Available[]>([])
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('')

  const loadInstalled = async () => {
    const [i, m] = await Promise.all([api('GET', '/api/plugins'), api('GET', '/api/marketplaces')])
    setInstalled(i)
    setMarkets(m)
    setLoaded(l => ({ ...l, installed: true }))
  }
  const loadAll = () =>
    run(async () => {
      setError('')
      try {
        await loadInstalled()
        setAvailable(await api('GET', '/api/plugins/available'))
      } catch (e) {
        setError((e as Error).message)
        throw e
      } finally {
        // Stop showing "Loading…" even on failure; the error and Retry take its place.
        setLoaded({ installed: true, available: true })
      }
    })
  useEffect(() => {
    loadAll()
  }, [])

  const act = (action: string, id: string, s: Scope, done: string) =>
    run(async () => {
      await api('POST', '/api/plugins', { action, id, scope: s })
      await loadInstalled()
    }, `${done}. Restart Claude Code to apply.`)

  const market = (action: string, arg?: string) =>
    run(async () => {
      await api('POST', '/api/marketplaces', { action, arg, scope })
      setSource('')
      await loadInstalled()
      setAvailable(await api('GET', '/api/plugins/available'))
    }, action === 'add' ? `Added marketplace ${arg}` : action === 'remove' ? `Removed marketplace ${arg}` : 'Marketplaces updated')

  const q = query.toLowerCase()
  // Installed is per scope: a plugin in user scope can still be installed to a project.
  const installedHere = new Set(installed.filter(i => i.scope === scope).map(i => i.id))
  const matches = available
    .filter(a => !q || a.name.toLowerCase().includes(q) || a.description?.toLowerCase().includes(q))
    .sort((a, b) => (b.installCount ?? 0) - (a.installCount ?? 0))
  const results = matches.slice(0, 60)

  return (
    <div className="stack">
      {error && (
        <p className="err-text">
          Could not load plugins: {error}{' '}
          <button disabled={busy} onClick={loadAll}>
            Retry
          </button>
        </p>
      )}
      <section>
        <h2>Installed plugins</h2>
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Plugin</th>
              <th>Scope / state</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {installed.map(p => (
              <tr key={p.id + p.scope}>
                <td>
                  <strong>{p.id}</strong> <span className="muted">v{p.version}</span>
                </td>
                <td>
                  <span className="badge">{p.scope}</span> {p.enabled ? <span className="badge ok">enabled</span> : <span className="badge">disabled</span>}
                </td>
                <td className="actions">
                  {p.enabled ? (
                    <button disabled={busy} onClick={() => act('disable', p.id, p.scope, `Disabled ${p.id}`)}>Disable</button>
                  ) : (
                    <button disabled={busy} onClick={() => act('enable', p.id, p.scope, `Enabled ${p.id}`)}>Enable</button>
                  )}
                  <button disabled={busy} onClick={() => act('update', p.id, p.scope, `Updated ${p.id}`)}>Update</button>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() => confirm(`Uninstall ${p.id} from ${p.scope} scope?`) && act('uninstall', p.id, p.scope, `Uninstalled ${p.id}`)}
                  >
                    Uninstall
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {!loaded.installed && <p className="empty">Loading…</p>}
        {loaded.installed && !installed.length && <p className="empty">No plugins installed.</p>}
      </section>

      <section>
        <h2>Marketplaces</h2>
        <ul className="plain">
          {markets.map(m => (
            <li key={m.name} className="row">
              <strong>{m.name}</strong>
              <span className="muted">{m.repo ?? m.url ?? m.source}</span>
              <span className="grow" />
              <button disabled={busy} onClick={() => market('update', m.name)}>Update</button>
              <button className="danger" disabled={busy} onClick={() => confirm(`Remove marketplace ${m.name}?`) && market('remove', m.name)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
        {loaded.installed && !markets.length && <p className="empty">No marketplaces yet. Add one below or from Community.</p>}
        <form
          className="row"
          onSubmit={e => {
            e.preventDefault()
            market('add', source)
          }}
        >
          <label htmlFor="mk-src">Add marketplace</label>
          <input id="mk-src" value={source} onChange={e => setSource(e.target.value)} placeholder="owner/repo, git URL or path" />
          <button type="submit" disabled={!source.trim() || busy}>
            Add to {scope}
          </button>
        </form>
      </section>

      <section>
        <h2>Browse {available.length} plugins from your marketplaces</h2>
        <input className="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search plugins…" aria-label="Search plugins" />
        {!loaded.available && <p className="empty">Loading plugin catalog…</p>}
        {loaded.available && !matches.length && <p className="empty">{q ? `No plugins match "${query}".` : 'No plugins in your marketplaces.'}</p>}
        {matches.length > results.length && <p className="hint">Showing {results.length} of {matches.length}. Search to narrow down.</p>}
        <ul className="cards">
          {results.map(a => (
            <li key={a.pluginId} className="card">
              <div className="row">
                <strong>{a.name}</strong>
                <span className="muted">@{a.marketplaceName}</span>
                <span className="grow" />
                {a.installCount != null && <span className="muted">{a.installCount.toLocaleString()} installs</span>}
              </div>
              <p>{a.description}</p>
              <button
                className="primary"
                disabled={installedHere.has(a.pluginId) || busy}
                onClick={() => act('install', a.pluginId, scope, `Installed ${a.pluginId} in ${scope} scope`)}
              >
                {installedHere.has(a.pluginId) ? `Installed in ${scope}` : `Install to ${scope}`}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
