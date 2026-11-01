import { useEffect, useState, type KeyboardEvent } from 'react'
import { api, confirmLeave, qs, singular, unsaved, useResource, type TabProps } from './api'

type Kind = 'agents' | 'skills' | 'commands'
type Item = { name: string; description: string; path: string }

const TEMPLATES: Record<Kind, (n: string) => string> = {
  agents: n => `---\nname: ${n}\ndescription: When Claude should delegate to this agent\ntools: Read, Grep, Glob\n---\n\nYou are a ...\n`,
  skills: n => `---\nname: ${n}\ndescription: What this skill does and when to use it\n---\n\n# ${n}\n\n`,
  commands: () => `---\ndescription: What this command does\n---\n\n$ARGUMENTS\n`,
}
const NAME = /^\w[\w.-]*$/

/** Editor text plus the last saved copy, so leaving with unsaved edits can ask first. */
function useDraft() {
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const dirty = content !== original
  useEffect(() => {
    unsaved.current = dirty
  }, [dirty])
  useEffect(() => () => void (unsaved.current = false), [])
  const reset = (text: string) => {
    setContent(text)
    setOriginal(text)
  }
  return { content, setContent, dirty, reset, saved: () => setOriginal(content) }
}

const ctrlS = (save: () => void) => (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault()
    save()
  }
}

export function ItemsTab({ kind, scope, run, busy }: TabProps & { kind: Kind }) {
  const items = useResource<Item[]>(() => api('GET', `/api/items?${qs({ kind, scope })}`), [])
  const [sel, setSel] = useState<string | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [path, setPath] = useState('')
  const [newName, setNewName] = useState<string | null>(null)
  const draft = useDraft()

  const open = (name: string) => {
    if (name === sel || !confirmLeave()) return
    run(async () => {
      const r = await api('GET', `/api/item?${qs({ kind, scope, name })}`)
      setSel(name)
      setIsNew(false)
      draft.reset(r.content)
      setPath(r.path)
    })
  }

  const name = newName?.trim() ?? ''
  const nameError = !name ? '' : !NAME.test(name) ? 'Use letters, digits, - _ . and start with a letter or digit.' : items.data.some(i => i.name === name) ? `${name} already exists.` : ''

  const create = () => {
    if (!name || nameError || !confirmLeave()) return
    setSel(name)
    setIsNew(true)
    draft.reset('')
    draft.setContent(TEMPLATES[kind](name))
    setPath('(not saved yet)')
    setNewName(null)
  }

  const save = () => {
    if (!sel || busy) return
    run(async () => {
      await api('PUT', '/api/item', { kind, scope, name: sel, content: draft.content })
      draft.saved()
      setIsNew(false)
      await items.reload()
    }, `Saved ${sel}`)
  }

  const remove = () => {
    if (!sel || !confirm(`Delete ${singular(kind)} "${sel}" from ${scope} scope? This cannot be undone.`)) return
    run(async () => {
      await api('DELETE', `/api/item?${qs({ kind, scope, name: sel })}`)
      setSel(null)
      draft.reset('')
      await items.reload()
    }, `Deleted ${sel}`)
  }

  return (
    <div className="split">
      <aside>
        <div className="row">
          <h2 className="grow">
            {items.data.length} {kind}
          </h2>
          <button onClick={() => setNewName(newName === null ? '' : null)} aria-expanded={newName !== null}>
            + New
          </button>
        </div>
        {newName !== null && (
          <form
            className="row"
            onSubmit={e => {
              e.preventDefault()
              create()
            }}
          >
            <input
              autoFocus
              aria-label={`New ${singular(kind)} name`}
              aria-invalid={!!nameError}
              aria-describedby="new-name-err"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Escape' && setNewName(null)}
              placeholder={`${singular(kind)}-name`}
              className="grow"
            />
            <button type="submit" className="primary" disabled={!name || !!nameError}>
              Create
            </button>
            {nameError && (
              <span id="new-name-err" className="err-text">
                {nameError}
              </span>
            )}
          </form>
        )}
        <ul className="list">
          {items.data.map(i => (
            <li key={i.name}>
              <button className={sel === i.name ? 'on' : ''} onClick={() => open(i.name)}>
                <span className="name">{i.name}</span>
                <span className="desc">{i.description}</span>
              </button>
            </li>
          ))}
        </ul>
        {items.loading && !items.data.length && <p className="empty">Loading…</p>}
        {items.error && <p className="err-text">{items.error}</p>}
        {!items.loading && !items.error && !items.data.length && <p className="empty">None in this scope. Create one or install from Community.</p>}
      </aside>
      <section onKeyDown={ctrlS(save)}>
        {sel ? (
          <>
            <div className="row">
              <code className="path">{path}</code>
              <span className="grow" />
              <button className="primary" disabled={busy || (!draft.dirty && !isNew)} onClick={save} title="Ctrl+S">
                {draft.dirty ? 'Save ●' : 'Save'}
              </button>
            </div>
            <textarea aria-label={`${sel} content`} value={draft.content} onChange={e => draft.setContent(e.target.value)} spellCheck={false} />
            {!isNew && (
              <div className="row end">
                <button className="danger" disabled={busy} onClick={remove}>
                  Delete {singular(kind)}
                </button>
              </div>
            )}
          </>
        ) : (
          <p className="empty">Select an item or create a new one.</p>
        )}
      </section>
    </div>
  )
}

export function FileTab({ kind, scope, run, busy }: TabProps & { kind: 'memory' | 'settings' }) {
  const [path, setPath] = useState('')
  const [loaded, setLoaded] = useState(false)
  const draft = useDraft()

  useEffect(() => {
    run(async () => {
      const r = await api('GET', `/api/file?${qs({ kind, scope })}`)
      draft.reset(r.content)
      setPath(r.path)
      setLoaded(true)
    })
  }, [])

  let jsonError = ''
  if (kind === 'settings' && draft.content.trim()) {
    try {
      JSON.parse(draft.content)
    } catch (e) {
      jsonError = (e as Error).message
    }
  }

  // Save waits for a successful load, so a failed read can never overwrite the file with an empty editor.
  const canSave = loaded && draft.dirty && !jsonError && !busy
  const save = () => canSave && run(async () => {
    await api('PUT', '/api/file', { kind, scope, content: draft.content })
    draft.saved()
  }, `Saved ${path}`)

  return (
    <section className="full" onKeyDown={ctrlS(save)}>
      <div className="row">
        <code className="path">{path || 'Loading…'}</code>
        <span className="grow" />
        {jsonError && (
          <span id="json-err" className="err-text">
            Invalid JSON: {jsonError}
          </span>
        )}
        <button className="primary" disabled={!canSave} onClick={save} title="Ctrl+S">
          {draft.dirty ? 'Save ●' : 'Save'}
        </button>
      </div>
      {kind === 'settings' && (
        <p className="hint">Hooks, permissions, env, enabledPlugins and model live here. Claude Code reads changes on next start.</p>
      )}
      <textarea
        aria-label={`${kind} file`}
        aria-invalid={!!jsonError}
        aria-describedby={jsonError ? 'json-err' : undefined}
        value={draft.content}
        disabled={!loaded}
        onChange={e => draft.setContent(e.target.value)}
        spellCheck={false}
      />
    </section>
  )
}
