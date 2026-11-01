import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type Scope = 'user' | 'project' | 'local'

export const HOME = os.homedir()
export const USER_DIR = path.join(HOME, '.claude')

// Starts with a word char, so it can never be "..", "-flag" or contain a separator.
export const NAME = /^\w[\w.-]*$/

export function checkName(name: unknown): string {
  if (typeof name !== 'string' || !NAME.test(name)) throw new HttpError(400, `invalid name: ${name}`)
  return name
}

export function checkScope(scope: unknown): Scope {
  if (scope !== 'user' && scope !== 'project' && scope !== 'local') throw new HttpError(400, `invalid scope: ${scope}`)
  return scope
}

export function projectDir(p: unknown): string {
  if (typeof p !== 'string' || !path.isAbsolute(p) || !fs.statSync(p, { throwIfNoEntry: false })?.isDirectory())
    throw new HttpError(400, 'pick an existing absolute project folder first')
  return path.resolve(p)
}

/** Resolve parts under root, refusing anything that escapes it. */
export function inside(root: string, ...parts: string[]): string {
  const p = path.resolve(root, ...parts)
  if (p !== root && !p.startsWith(root + path.sep)) throw new HttpError(400, `path escapes ${root}`)
  return p
}

export function samePath(a: string, b: string): boolean {
  const [x, y] = [path.resolve(a), path.resolve(b)]
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

export function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}
