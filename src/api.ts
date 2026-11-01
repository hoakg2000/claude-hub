import { useCallback, useEffect, useState } from 'react'

export type Scope = 'user' | 'project' | 'local'

const fromUrl = new URLSearchParams(location.search).get('token')
if (fromUrl) {
  sessionStorage.setItem('hub-token', fromUrl)
  history.replaceState(null, '', location.pathname)
}
const TOKEN = sessionStorage.getItem('hub-token') ?? ''

let project = ''
export const setProject = (p: string) => (project = p)

const withProject = (url: string) => url + (url.includes('?') ? '&' : '?') + 'project=' + encodeURIComponent(project)
const headers = { 'x-hub-token': TOKEN, 'content-type': 'application/json' }

/** Error carrying the HTTP status, so callers can branch on 409 and friends instead of message text. */
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(withProject(url), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(r.status, data.error ?? r.statusText)
  return data
}

/** POST and call onEvent for each NDJSON line of the streamed reply. Abort the signal to stop. */
export async function stream(url: string, body: unknown, onEvent: (e: any) => void, signal: AbortSignal) {
  const r = await fetch(withProject(url), { method: 'POST', headers, body: JSON.stringify(body), signal })
  if (!r.ok) throw new ApiError(r.status, (await r.json().catch(() => ({}))).error ?? r.statusText)
  const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    const parts = (buf + value).split('\n')
    buf = parts.pop()!
    for (const p of parts) {
      if (!p.trim()) continue
      try {
        onEvent(JSON.parse(p))
      } catch {}
    }
  }
}

/** Load data on mount; `loading` stays true until the first answer so lists never flash "empty". */
export function useResource<T>(load: () => Promise<T>, initial: T) {
  const [data, setData] = useState(initial)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setData(await load())
      setError('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    reload()
  }, [reload])
  return { data, loading, error, reload }
}

/** Set by editors with unsaved text; anything that would drop the editor asks first. */
export const unsaved = { current: false }
export const confirmLeave = () => !unsaved.current || confirm('You have unsaved changes. Discard them?')

export const qs = (o: Record<string, string>) => new URLSearchParams(o).toString()

export const singular = (kind: string) => kind.slice(0, -1)

export type Run = (fn: () => Promise<unknown>, done?: string) => Promise<void>
export type TabProps = { scope: Scope; run: Run; busy: boolean }
