# AI Command Center

> Talk to Jarvis in Discord. Jarvis orchestrates a swarm of specialist Claude agents — building client websites, running your projects, and managing your business — while you get on with your day.

A local Node.js server + Discord bot that turns a private Discord server into a command console for a fleet of AI agents. Each agent runs [Claude Code](https://claude.com/claude-code) inside its own project directory. You give orders through Discord; the agents work in the background and report back in their own channels. A browser dashboard gives you a live overview.

---

## How it works

```
You (Discord)
    │
    ▼
Discord Bot (!run, !manage, !swarm, !jarvislog …)
    │
    ▼
AI Command Center — Express server (localhost:3333)
    │
    ├─▶  Jarvis (manager agent)
    │        └─▶ delegates to specialist agents via !swarm / dispatch
    │
    ├─▶  sandwich-house (client website)
    ├─▶  hoagies        (client website)
    ├─▶  aid-helpdesk   (IT project)
    └─▶  … 15+ more agents
```

Every agent has its own project directory, a `CLAUDE.md` with its role and standing instructions, and a daily memory log. Jarvis reads all outstanding flags and blockers, decides what needs doing, and fans work out to the right specialists — in parallel, across two AI providers (Claude + Codex).

---

## Agent roster

| Agent | Role |
|-------|------|
| **jarvis** | Orchestrator. Reviews daily to-dos, delegates to specialist agents, manages Claude/Codex usage budgets, posts monthly revenue/goals reports. |
| **lachys-web-dev** | Lachy's web dev business — main client intake, billing, and business strategy. |
| **club-window-services** | Client website — Club Window Services. |
| **making-moves-express** | Client website — Making Moves Express. |
| **fun-raising** | Client website — Fun Raising. |
| **lachys-gardening** | Client website — Lachy's Gardening Maintenance. |
| **ggl-maintenance** | Client website — GGL Maintenance. |
| **llewellyn-property** | Client website — Llewellyn Property Maintenance. |
| **vp-elite** | Client website — VP Elite Headlight Restoration. |
| **sandwich-house** | Client website — Sandwich House. |
| **hoagies** | Client website — Hoagies. |
| **kanadojo** | Kana Dojo — Japanese learning app. |
| **aid-helpdesk** | Active Directory helpdesk tool. |
| **eshis-curriculum** | Eshi's curriculum project. |
| **sbl-rankings** | SBL Rankings site. |
| **command-center** | This project — the server manages itself. |

New agents can be added at any time with `!new-agent <name>` — it scaffolds the project folder, `CLAUDE.md`, and memory directory automatically.

---

## Discord commands

The bot is the primary interface. Run these from any channel, or from an agent's dedicated channel (where `[agent]` can be omitted).

### Day-to-day

| Command | What it does |
|---------|--------------|
| `!run [agent] <prompt>` | Send a prompt to an agent. Continues the last session by default; injects today's memory log on first run. Supports `-opus`, `-sonnet`, `-haiku`, `-codex`, `--effort high`. |
| `!jarvislog [agent]` | Tell an agent to write its session memory log — the key handover step before closing a session. |
| `!log [agent]` | Show an agent's latest memory log. |
| `!history [agent]` | Show the last 8 conversation messages for an agent. |
| `!todos` | Scan every agent's memory for outstanding flags (`🚩 Flags for Lachy`) and blocked statuses. |
| `!agents` | List all agents with their latest status emoji. |
| `!runs` | Live registry — who's working right now, recent finished runs, cost today. |
| `!usage` | Claude and Codex usage/rate-limit status + today's spend. |

### Orchestration

| Command | What it does |
|---------|--------------|
| `!swarm agent1,agent2,agent3 <prompt>` | Fan the same prompt out to several agents in parallel. Results post to each agent's channel. |
| `!manage [minutes]` | Turn on Jarvis as a background manager. Every N minutes (default 60) Jarvis reviews all to-dos, delegates work to specialists, and posts what it did. |
| `!manage stop` | Turn the manager loop off. |
| `!manage hours mon-fri 9-17` | Restrict manager ticks to active hours (e.g. `mon-wed 7-17, thu 7-13`). |
| `!manage codex` | Switch manager loop to prefer Codex for all worker tasks (saves Claude quota). |
| `!schedule every 30 hoagies <prompt>` | Schedule recurring agent runs. `!schedule list` · `!schedule cancel <id>`. |

### Server management

| Command | What it does |
|---------|--------------|
| `!sync` | Create/update Discord categories (🤖 Core · 🌐 Web Dev) and channels for all agents. |
| `!board` | Post a pinned, auto-refreshing status board in `#status-board`. |
| `!activity` | Start posting to `#activity-feed` whenever an agent logs a new memory update. |
| `!mirror` | Mirror delegated run output into each agent's own channel. |
| `!new-agent <name> [dir]` | Scaffold a new agent (project dir + `CLAUDE.md` + memory folder). |
| `!archive <agent>` | Move an agent's channel to the 🗄 Archive category (`undo` to restore). |
| `!model [agent] opus high` | Set a per-agent default model/effort for subsequent `!run` calls. |
| `!gif <name\|list>` | Post a reaction GIF (thinking, coding, done, error, money…). |
| `!status` | Check the server is reachable. |
| `!help` | Full command list. |

### A typical day

1. Morning: `!todos` to see what agents flagged overnight.
2. `!run jarvis review the outstanding flags and delegate fixes` — Jarvis fans work out.
3. Check `#activity-feed` as agents post their completed logs.
4. Evening: `!jarvislog` so today's session is saved for tomorrow.

With `!manage` running, most of this happens automatically.

---

## Web dashboard

Open **http://localhost:3333** for a browser UI — a grid of agent cards with status LEDs, memory log viewer, project file browser, and a live-streaming Run tab. Useful for long outputs that don't fit in Discord, or for running agents from your phone via a [Cloudflare Tunnel](#exposing-to-your-phone-cloudflare-tunnel).

---

## Getting started

**Prerequisites:** Node.js 18+, [Claude Code](https://claude.com/claude-code) installed, a Discord bot token.

```bash
git clone https://github.com/lachydotmcg/ai-command-center
cd ai-command-center
npm install
```

**1. Configure your environment**

```bash
cp .env.example .env
```

Edit `.env` and add your `DISCORD_TOKEN`. Copy `config.example.json` → `config.json` and set the paths for your machine (memory root, agent directories).

**2. Start the server**

```bash
npm start          # server only
npm run bot        # Discord bot only
```

On Windows, double-click **`start.bat`** — launches the server, bot, and browser together.

**3. Invite the bot to your Discord server**

Required permissions: Read Messages, Send Messages, Manage Channels, Read Message History.

**4. Set up channels**

Run `!sync` in Discord — the bot creates a `🤖 Core Agents` category and a `🌐 Web Dev Clients` category with a channel per agent. Then `!board` and `!activity` to get live feeds.

**5. Start the manager**

```
!manage 60
!mirror
```

Jarvis will review to-dos and delegate work every 60 minutes. All output mirrors into agent channels.

---

## Configuration

Override any setting via **environment variables** or an optional **`config.json`** (copy `config.example.json`). Precedence: env var → `config.json` → built-in default.

| Setting | Env var | `config.json` key | Default |
|---------|---------|-------------------|---------|
| Server port | `ACC_PORT` | `port` | `3333` |
| Memory logs root | `ACC_MEMORY_ROOT` | `memoryRoot` | `…/Obsidian/Lachy/agent-memory` |
| Auth token | `ACC_SECRET` | `secret` | _(none — open)_ |
| `claude` executable | `ACC_CLAUDE_EXE` | `claudeExe` | auto-detected |
| `codex` executable | `ACC_CODEX_EXE` | `codexExe` | auto-detected |
| Codex sandbox | `ACC_CODEX_SANDBOX` | `codexSandbox` | `workspace-write` |
| Codex full-disk read | `ACC_CODEX_DISK_FULL_READ` | `codexDiskFullRead` | `true` |
| Manager day start hour | `ACC_DAY_START` | `dayStart` | `8` |
| Manager day end hour | `ACC_DAY_END` | `dayEnd` | `22` |
| Daily Claude budget (soft) | `ACC_DAILY_BUDGET` | `dailyBudget` | `$5` |
| Claude usage target | `ACC_USAGE_TARGET` | `usageTarget` | `0.75` (75%) |
| New agent base dir | `ACC_NEW_AGENT_BASE` | `newAgentBase` | `…/Lachys Web Dev` |
| Agent → directory map | — | `agents` | built-in list |
| Netlify webhook secret | `NETLIFY_WEBHOOK_SECRET` | — | _(none — unverified)_ |
| Discord webhook URL (forms) | `NETLIFY_DISCORD_WEBHOOK` | — | _(none)_ |

Agents are discovered two ways: explicit entries in the `agents` map plus any subfolder under the memory root. An agent's memory log path:

```
<memoryRoot>/<agent-name>/YYYY-MM-DD.md
```

---

## Exposing to your phone (Cloudflare Tunnel)

```bash
# 1. Install (one time)
winget install cloudflare.cloudflared

# 2. Set a secret — the server runs claude on your PC
$env:ACC_SECRET = "some-long-random-string"
node server.js

# 3. Start the tunnel
cloudflared tunnel --url http://localhost:3333
```

Cloudflare prints a `https://random-words.trycloudflare.com` URL. Bookmark it on your phone.

---

## API endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/status` | open | Heartbeat `{ ok, time, authRequired }` |
| GET | `/agents` | ✓ | Agent names |
| GET | `/agents/meta` | ✓ | Agents with directory + group |
| GET | `/logs/:agent` | ✓ | Latest memory log |
| GET | `/logs/:agent/all` | ✓ | All log filenames |
| GET | `/files/:agent?dir=` | ✓ | Browse project directory |
| GET | `/file/:agent?p=` | ✓ | Read a project file |
| GET | `/memory/:agent/:file` | ✓ | Read a specific memory log |
| GET | `/history/:agent` | ✓ | Last Claude Code conversation |
| GET | `/runs` | ✓ | Live run registry |
| GET | `/runs/:id` | ✓ | Single run detail |
| GET | `/usage` | ✓ | Claude/Codex usage snapshot |
| GET | `/todos` | ✓ | Outstanding flags + blockers |
| POST | `/run` | ✓ | Run an agent (SSE stream) |
| POST | `/dispatch` | ✓ | One-shot agent run (JSON) |
| POST | `/swarm` | ✓ | Parallel multi-agent run |
| POST | `/new-agent` | ✓ | Scaffold a new agent |
| POST | `/schedule` | ✓ | Create a scheduled task |
| GET | `/schedule` | ✓ | List scheduled tasks |
| DELETE | `/schedule/:id` | ✓ | Cancel a scheduled task |
| POST | `/discord-op` | ✓ | Queue a Discord channel op |
| GET | `/discord-ops` | ✓ | List pending Discord ops |
| POST | `/netlify-webhook` | open | Netlify form → Discord notification |

"✓" routes require the `ACC_SECRET` bearer token **only when a secret is configured**.

---

## Project layout

| File | Purpose |
|------|---------|
| `server.js` | Express server — agent API, runner, scheduler, Discord ops queue |
| `index.html` | Browser dashboard — vanilla JS, no build step |
| `discord-bot.js` | Discord bot — commands, status board, activity feed, run mirror |
| `agent-cli.mjs` | CLI used by agents to delegate sub-tasks to each other |
| `config.example.json` | Template for local path/agent configuration |
| `.env.example` | Template for secrets and tokens |

---

## License

MIT
