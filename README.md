# Claude Hub

A local web manager for Claude Code: a chat with session history, agents, skills, commands, CLAUDE.md memory, settings, MCP servers and plugins, plus community search and one-click install into user, project or local scope.

## Run

```bash
npm install
npm run build
npm start            # prints http://127.0.0.1:4178/?token=...
```

Open the printed URL. The project path defaults to the folder you ran it from.

Development (hot reload):

```bash
npm run server       # API on :4178, prints a dev URL with the token
npm run dev          # Vite UI on :5173, proxies /api
```

Optional: set `GITHUB_TOKEN` to raise GitHub API limits for community search. `GITHUB_TOKEN` and `PORT` can also go in a `.env` file in the folder you start from. No Anthropic API key is needed: chat runs your installed `claude` CLI with its own login.

## What it does

| Tab | Scopes | How |
| --- | --- | --- |
| Chat | project folder | Runs `claude -p --output-format stream-json`, `--resume` for old sessions. Same transcripts as `claude --resume` (`~/.claude/projects`). `/new`, `/cd <folder>`, `/model`, `/mode`, `/help`; other `/commands` go to the CLI. Permission mode picker; prompts that would need a person are denied in manual mode |
| Usage box | all sessions | Current session tokens and cost from the CLI, 5-hour and today token totals from local transcripts, plan limit % when the CLI reports it |
| Agents / Skills / Commands | user, project | Edits `~/.claude/{agents,skills,commands}` or `<project>/.claude/...` |
| Memory | user, project, local | `~/.claude/CLAUDE.md`, `CLAUDE.md`, `CLAUDE.local.md` |
| Settings | user, project, local | `settings.json` / `settings.local.json` (validated JSON) |
| MCP | user, project, local | Reads config; writes through `claude mcp add-json` / `remove` |
| Plugins | user, project, local | `claude plugin` install, enable, disable, update, uninstall, marketplaces |
| Community | user, project | Searches GitHub repos, detects `SKILL.md`, `agents/*.md`, `commands/*.md`, installs them; adds repos with `.claude-plugin/marketplace.json` as marketplaces |

## Security

- Listens on `127.0.0.1` only and rejects requests whose `Host` is not loopback (DNS rebinding).
- Every API call needs the random per-run token from the printed URL, so other websites cannot call it.
- `~/.claude.json` (holds your account data) is never written directly; MCP changes go through the `claude` CLI.
- Names and paths are validated; downloads cannot escape the target folder.
- Plugins that need a marketplace-declared command are not auto-accepted; confirm those in the terminal.
- Community content is untrusted. Preview before installing.

## Test

```bash
npm test
npm run typecheck
```
