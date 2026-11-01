import { useEffect, useState } from 'react'
import { api } from './api'

type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type SessionUsage = { input: number; output: number; cost: number }
type Window = { utilization?: number; resetsAt?: number }
export type Limits = { unifiedWindows?: Record<string, Window> } | null

const fmt = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n))
const total = (t: Tokens) => t.input + t.output + t.cacheRead + t.cacheWrite
const LIMIT_NAMES: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

/** Live usage: this chat session from the CLI's result events, and recent totals from local transcripts. */
export default function Usage({ session, limits, tick }: { session: SessionUsage; limits: Limits; tick: number }) {
  const [recent, setRecent] = useState<{ fiveHours: Tokens; today: Tokens } | null>(null)

  useEffect(() => {
    const load = (fresh = false) => api('GET', `/api/usage${fresh ? '?fresh=1' : ''}`).then(setRecent, () => {})
    load(tick > 0)
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [tick])

  const windows = Object.entries(limits?.unifiedWindows ?? {}).filter(([, w]) => w.utilization != null)

  return (
    <div className="usage" role="group" aria-label="Usage">
      <div title="This chat session: input incl. cache, output, and the CLI's API-price estimate">
        <span className="muted">Session</span> {fmt(session.input)} in · {fmt(session.output)} out · ${session.cost.toFixed(2)}
      </div>
      {recent && (
        <div title="All Claude Code sessions on this machine, all token types">
          <span className="muted">5h</span> {fmt(total(recent.fiveHours))} · <span className="muted">today</span> {fmt(total(recent.today))} tokens
        </div>
      )}
      {windows.length > 0 && (
        <div title="Plan limits reported by Claude Code on the last reply">
          <span className="muted">Limits</span>{' '}
          {windows.map(([k, w]) => (
            <span key={k} className={w.utilization! >= 0.8 ? 'warn' : ''} title={w.resetsAt ? `Resets ${new Date(w.resetsAt * 1000).toLocaleString()}` : ''}>
              {LIMIT_NAMES[k] ?? k} {Math.round(w.utilization! * 100)}%{' '}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
