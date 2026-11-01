import { useEffect, useRef, useState } from 'react'
import { ApiError, api, qs, singular, type TabProps } from './api'

type Repo = { repo: string; description: string | null; stars: number; url: string }
type Item = { kind: 'agents' | 'skills' | 'commands'; name: string; path: string }
type Scan = { repo: string; truncated: boolean; isMarketplace: boolean; items: Item[] }

const previewPath = (i: Item) => (i.kind === 'skills' ? (i.path ? i.path + '/' : '') + 'SKILL.md' : i.path)

export default function Community({ scope, run, busy, github }: TabProps & { github: boolean }) {
  const [query, setQuery] = useState('')
  const [repos, setRepos] = useState<Repo[] | null>(null)
  const [scan, setScan] = useState<Scan | null>(null)
  const [preview, setPreview] = useState<{ item: Item; content: string } | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  useEffect(() => previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), [preview])

  const search = () => run(async () => setRepos(await api('GET', `/api/gh/search?${qs({ q: query })}`)))

  const open = (repo: string) =>
    run(async () => {
      setPreview(null)
      setScan(await api('GET', `/api/gh/scan?${qs({ repo })}`))
    })

  const show = (item: Item) =>
    run(async () => {
      const r = await api('GET', `/api/gh/file?${qs({ repo: scan!.repo, path: previewPath(item) })}`)
      setPreview({ item, content: r.content })
    })

  const install = (item: Item) =>
    run(async () => {
      const body = { repo: scan!.repo, kind: item.kind, path: item.path, scope }
      try {
        await api('POST', '/api/gh/install', body)
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409) || !confirm(`${item.name} already exists in ${scope} scope. Overwrite?`)) throw e
        await api('POST', '/api/gh/install', { ...body, overwrite: true })
      }
    }, `Installed ${singular(item.kind)} ${item.name} to ${scope} scope`)

  const addMarket = () => run(() => api('POST', '/api/marketplaces', { action: 'add', arg: scan!.repo, scope }), `Added marketplace ${scan!.repo}. See the Plugins tab.`)

  return (
    <div className="stack">
      <form
        className="row"
        onSubmit={e => {
          e.preventDefault()
          if (/^[\w.-]+\/[\w.-]+$/.test(query.trim())) open(query.trim())
          else search()
        }}
      >
        <input className="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search GitHub (e.g. code review agents) or type owner/repo" aria-label="Search GitHub" />
        <button className="primary" type="submit" disabled={!query.trim() || busy}>
          Search
        </button>
      </form>
      <div>
        {!github && <p className="hint">No GITHUB_TOKEN set: GitHub allows ~10 searches/min and 60 requests/hour.</p>}
      <p className="hint warn">Community items are untrusted prompts and scripts. Preview before installing.</p>
      </div>

      <div className="split">
        <aside>
          <ul className="list">
            {repos?.map(r => (
              <li key={r.repo}>
                <button className={scan?.repo === r.repo ? 'on' : ''} disabled={busy} onClick={() => open(r.repo)}>
                  <span className="name">
                    {r.repo} <span className="muted">★ {r.stars.toLocaleString()}</span>
                  </span>
                  <span className="desc">{r.description}</span>
                </button>
              </li>
            ))}
          </ul>
          {!repos && <p className="empty">Search to list repos, or type owner/repo to open one.</p>}
          {repos && !repos.length && <p className="empty">No repos found. Try other words.</p>}
        </aside>
        <section>
          {scan ? (
            <>
              <div className="row">
                <h2>{scan.repo}</h2>
                <span className="grow" />
                {scan.isMarketplace && <button disabled={busy} onClick={addMarket}>Add as plugin marketplace</button>}
              </div>
              {scan.truncated && <p className="hint warn">Repo is very large; some items may be missing.</p>}
              {!scan.items.length && <p className="empty">No agents, skills or commands found in this repo.</p>}
              <div className="table-wrap">
              <table>
                <tbody>
                  {scan.items.map(i => (
                    <tr key={i.kind + i.path} className={preview?.item === i ? 'on' : ''}>
                      <td>
                        <span className="badge">{singular(i.kind)}</span>
                      </td>
                      <td>
                        <strong>{i.name}</strong>
                        <div className="muted small">{i.path || '(repo root)'}</div>
                      </td>
                      <td className="actions">
                        <button disabled={busy} onClick={() => show(i)}>Preview</button>
                        <button className="primary" disabled={busy} onClick={() => install(i)}>
                          Install to {scope}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              {preview && (
                <div ref={previewRef} className="preview-block">
                  <div className="row">
                    <h3 className="grow">Preview: {preview.item.name}</h3>
                    <button className="primary" disabled={busy} onClick={() => install(preview.item)}>
                      Install to {scope}
                    </button>
                  </div>
                  <pre className="preview">{preview.content}</pre>
                </div>
              )}
            </>
          ) : (
            <p className="empty">Search, then pick a repo to see what it contains.</p>
          )}
        </section>
      </div>
    </div>
  )
}
