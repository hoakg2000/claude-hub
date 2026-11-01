import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { detectItems, filesOfSkill } from './github.ts'
import { checkName, inside } from './paths.ts'
import { frontmatter, mergeDefaults } from './resources.ts'
import { checkSessionId, parseTranscript, projectKey, requestUsage, sumWindows } from './sessions.ts'

test('detectItems finds skills, agents and commands', () => {
  const items = detectItems(
    [
      'README.md',
      'skills/pdf/SKILL.md',
      'skills/pdf/scripts/x.py',
      'plugins/p/agents/reviewer.md',
      'agents/README.md',
      '.claude/commands/ship.md',
      'docs/agents.md',
      'SKILL.md',
      'agents/bad name.md',
    ],
    'me/repo',
  )
  assert.deepEqual(items, [
    { kind: 'skills', name: 'pdf', path: 'skills/pdf' },
    { kind: 'agents', name: 'reviewer', path: 'plugins/p/agents/reviewer.md' },
    { kind: 'commands', name: 'ship', path: '.claude/commands/ship.md' },
    { kind: 'skills', name: 'repo', path: '' },
  ])
})

test('inside refuses paths escaping the root', () => {
  const root = path.resolve('/tmp/hub')
  assert.equal(inside(root, 'a/b.md'), path.join(root, 'a', 'b.md'))
  assert.throws(() => inside(root, '../evil'))
  assert.throws(() => inside(root, '/etc/passwd'))
})

test('checkName rejects traversal and flags', () => {
  assert.equal(checkName('code-reviewer.v2'), 'code-reviewer.v2')
  for (const bad of ['..', '../x', '-rf', 'a/b', 'a\\b', '', null]) assert.throws(() => checkName(bad))
})

test('frontmatter parses yaml and tolerates garbage', () => {
  assert.deepEqual(frontmatter('---\nname: a\ndescription: does b\n---\nbody'), { name: 'a', description: 'does b' })
  assert.deepEqual(frontmatter('no frontmatter'), {})
  assert.deepEqual(frontmatter('---\n: : [\n---'), {})
})

test('projectKey matches the CLI transcript folder names', () => {
  assert.equal(projectKey('C:\\project\\claude-hub'), 'C--project-claude-hub')
  assert.equal(projectKey('/home/me/my.app'), '-home-me-my-app')
})

test('checkSessionId only accepts uuids', () => {
  assert.equal(checkSessionId('2e74e4c2-2003-4bed-a7f7-404999990974'), '2e74e4c2-2003-4bed-a7f7-404999990974')
  for (const bad of ['../x', '2e74e4c2', '', null]) assert.throws(() => checkSessionId(bad))
})

test('parseTranscript merges streamed lines, joins tool results and skips noise', () => {
  const rows = [
    { type: 'user', message: { content: 'fix it' } },
    { type: 'user', isMeta: true, message: { content: 'meta' } },
    { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Looking.' }] } },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a' } }] } },
    { type: 'assistant', isSidechain: true, message: { id: 'sub', content: [{ type: 'text', text: 'hidden' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] } },
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Done.' }] } },
  ]
  const msgs = parseTranscript(rows)
  assert.deepEqual(
    msgs.map(m => [m.role, m.text, m.tools.length]),
    [['user', 'fix it', 0], ['assistant', 'Looking.', 1], ['assistant', 'Done.', 0]],
  )
  assert.equal(msgs[1].tools[0].result, 'file body')
})

test('sumWindows ignores requests without a timestamp', () => {
  const u = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
  const now = Date.parse('2026-01-01T12:00:00Z')
  const w = sumWindows([{ at: NaN, u }, { at: now - 1000, u }, { at: now - 6 * 3600_000, u }], now, now - 8 * 3600_000)
  assert.equal(w.fiveHours.output, 2)
  assert.equal(w.today.output, 4)
})

test('filesOfSkill keeps a root skill out of other items and git files', () => {
  const files = ['SKILL.md', 'README.md', 'scripts/a.py', '.github/ci.yml', 'skills/pdf/SKILL.md', 'agents/rev.md']
  const items = detectItems(files, 'me/repo')
  const root = items.find(i => i.path === '')!
  assert.deepEqual(filesOfSkill(files, root, items), ['SKILL.md', 'README.md', 'scripts/a.py'])
  assert.deepEqual(filesOfSkill(files, items.find(i => i.name === 'pdf')!, items), ['skills/pdf/SKILL.md'])
})

test('mergeDefaults lets later settings win but never starts in bypass', () => {
  assert.deepEqual(mergeDefaults([{ model: 'opus' }, { permissions: { defaultMode: 'default' } }]), { model: 'opus', permissionMode: 'manual' })
  assert.equal(mergeDefaults([{ permissions: { defaultMode: 'acceptEdits' } }]).permissionMode, 'acceptEdits')
  assert.equal(mergeDefaults([{ permissions: { defaultMode: 'bypassPermissions' } }]).permissionMode, 'manual')
})

test('requestUsage counts each request once', () => {
  const line = { type: 'assistant', requestId: 'r1', timestamp: '2026-01-01T00:00:00Z', message: { id: 'm', usage: { input_tokens: 5, output_tokens: 7 } } }
  const u = requestUsage([line, line, { ...line, requestId: 'r2' }])
  assert.equal(u.length, 2)
  assert.equal(u[0].u.output, 7)
})
