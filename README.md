# AI Command Center

A local dashboard for managing your [Claude Code](https://claude.com/claude-code)
agents from any browser — phone or desktop. See each agent's status at a glance,
read its memory logs, browse its project files, and fire off prompts that run
`claude --print` on your machine and stream the output back live.

Retro-CRT terminal aesthetic, zero build step, one small Express server.

```
┌─ AI COMMAND CENTER ──────────────────────────────────┐
│  AGENTS: 17   DONE: 9   RUNNING: 2   BLOCKED: 1        │
│  🦀 jarvis   🦀 aid-helpdesk   🦀 club-window-services │
│  [ MEMORY ] [ FILES ] [ RUN ]                          │
└────────────────────────────────────────────────────────┘
```

## Features

- **Agent grid** — every agent as a status-coloured card (complete / running /
  blocked / no-data), pulsing LED, and a 🚩 flag indicator when an agent has left
  notes for you.
- **Filter** — type to search agents, or press `/` to jump to the box.
- **Memory tab** — browse an agent's daily memory logs and `CLAUDE.md`.
- **Files tab** — navigate and read the agent's project directory (sandboxed).
- **Run tab** — send a prompt to the agent; output streams in live with an
  elapsed timer. Optional `--continue` to resume the last session (remembered
  between visits).
- **Copy button** — one click copies whatever's in the current tab.
- **Keyboard shortcuts** — `/` focus search · `Esc` back / clear search ·
  `Enter` run · `Shift+Enter` newline.
- **Optional Discord bot** — `!agents`, `!log`, `!run` from a Discord channel.

## Run locally

```bash
npm install
node server.js
```

Then open **http://localhost:3333**. On Windows you can also double-click
`start.bat` (which launches the server, the Discord bot if a `.env` exists, and
your browser).

## Configuration

Everything works out of the box with sensible defaults. To adapt it to your own
machine, override via **environment variables** or an optional **`config.json`**
(copy `config.example.json`). Precedence: env var → `config.json` → built-in default.

| Setting | Env var | `config.json` | Default |
|---------|---------|---------------|---------|
| Server port | `ACC_PORT` | `port` | `3333` |
| Memory logs root | `ACC_MEMORY_ROOT` | `memoryRoot` | `…/Obsidian/Lachy/agent-memory` |
| Auth token | `ACC_SECRET` | `secret` | _(none — open)_ |
| `claude` executable | `ACC_CLAUDE_EXE` | `claudeExe` | auto-detected |
| Agent → directory map | — | `agents` | built-in list |

Agents are discovered two ways: explicit entries in the `agents` map (which set
the working directory `claude` runs in), plus any subfolder found under the
memory root. An agent only needs to write logs to:

```
<memoryRoot>/<agent-name>/YYYY-MM-DD.md
```

## Exposing to your phone (Cloudflare Tunnel)

Cloudflare Tunnel punches a public HTTPS URL through your firewall — no port
forwarding, no static IP.

**1. Install cloudflared (one time)**

```
winget install cloudflare.cloudflared
```

**2. ⚠ Turn on auth first — `/run` executes `claude` on your PC**

Set a secret before exposing the server to the internet:

```powershell
$env:ACC_SECRET = "some-long-random-string"
node server.js
```

(or put `"secret": "…"` in `config.json`). When a secret is set, every API call
requires it; the UI prompts for the token once and remembers it. With no secret,
the server is intended for localhost only.

**3. Start the tunnel**

```
cloudflared tunnel --url http://localhost:3333
```

Cloudflare prints a `https://random-words.trycloudflare.com` URL. Bookmark it on
your phone (it changes each run unless you set up a named tunnel).

## API endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/status` | open | Heartbeat `{ ok, time, authRequired }` |
| GET | `/agents` | ✓ | List all agent names |
| GET | `/logs/:agent` | ✓ | Most recent log `{ file, content }` |
| GET | `/logs/:agent/all` | ✓ | All log filenames (newest first) |
| GET | `/files/:agent?dir=` | ✓ | List a project directory (sandboxed) |
| GET | `/file/:agent?p=` | ✓ | Read a project file (sandboxed, ≤300 KB) |
| GET | `/memory/:agent/:file` | ✓ | Read a specific memory log |
| POST | `/run` | ✓ | Run `claude --print` and stream output (SSE) |

"✓" routes require the `ACC_SECRET` token (via `Authorization: Bearer <token>` or
`?token=`) **only when a secret is configured**. Otherwise they're open.

### POST /run body

```json
{ "agent": "aid-helpdesk", "prompt": "what's the status?", "continueSession": false }
```

## Discord bot (optional)

```bash
cp .env.example .env      # add your DISCORD_TOKEN
npm run bot
```

Commands: `!agents`, `!log <agent>`, `!run <agent> <prompt>`, `!status`, `!help`.

## Project layout

| File | Purpose |
|------|---------|
| `server.js` | Express server (UI + agent API + `claude` runner) |
| `index.html` | The entire front-end — vanilla JS, no build step |
| `discord-bot.js` | Optional Discord bridge |
| `config.example.json` / `.env.example` | Templates for local setup |

> `src/`, `vite.config.js`, and `webhook-server.js` are from an earlier
> React/Vite prototype and are no longer used. See `CONTRIBUTING.md`.

## Contributing & license

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).
