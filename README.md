# AI Command Center

My personal setup for running a fleet of AI agents from my phone, through Discord.

Jarvis lives in the background, manages my web dev clients, handles incoming leads, and works through my to-do list while I get on with my day. When I need something specific, I just message the right channel.

---

## What I actually use it for

**Morning briefing**
Jarvis runs on a schedule and kicks off the day: checks what agents flagged overnight, pulls a Gemini AI news summary, and posts it to Discord before I'm out of bed.

**Client website management**
Every client has their own agent and Discord channel. When I need a page updated, copy rewritten, or a form fixed, I drop a message in their channel. The agent works on the live project directory and reports back when it's done.

**Lead intake from Netlify forms**
Contact forms on my client sites POST to a webhook. Each submission lands in a `#leads` channel and Jarvis automatically triages it: adds it to the pipeline in my money log, drafts a reply email, and suggests a follow-up time. I just hit send.

**Business planning and revenue tracking**
Jarvis maintains a `goals.md` and `money-log.md` in my Obsidian vault. Every manager tick it checks progress against the month's revenue target, drafts outreach for warm leads, and flags anything that needs me specifically.

**Provider rotation so I never run out**
The system runs Claude, Codex, Gemini, and Groq. When Claude's usage window gets tight, tasks automatically spill to the next available provider. Scheduled jobs have fallback chains built in so they always run something even if the primary is capped.

**Stripe and Netlify webhooks**
Payment events and form submissions both route through the same server. Stripe webhooks update the money log when a client pays. Netlify form webhooks go straight to Jarvis for triage.

**Side project agents**
Separate agents handle the Etsy store, app projects, and anything else running in parallel. Jarvis coordinates them and keeps the Discord channels clean.

---

## How it works

```
Discord (phone or desktop)
    |
    v
Discord Bot  (!run, !manage, !swarm, !schedule ...)
    |
    v
Express server  (localhost:3333)
    |
    +-- Jarvis (orchestrator)
    |       |
    |       +-- delegates to specialist agents
    |       +-- reads usage, picks provider (Claude / Codex / Gemini / Groq)
    |       +-- posts updates to Discord channels
    |
    +-- Per-agent runners (Claude Code, Codex, Gemini CLI, Groq)
    |
    +-- Webhooks  (Netlify forms, Stripe)
    |
    +-- Scheduler  (daily briefing, recurring tasks, provider-aware fallbacks)
```

Each agent has its own project directory, a `CLAUDE.md` with its role, and a daily memory log in Obsidian. Jarvis reads all outstanding flags each tick and fans work out to the right specialists.

---

## Agent roster

| Agent | What it does |
|---|---|
| **jarvis** | Orchestrator. Morning briefings, manager ticks, lead triage, monthly revenue reports. |
| **lachys-web-dev** | My web dev business overall: client intake, billing, business strategy. |
| **club-window-services** | Client site. |
| **making-moves-express** | Client site. |
| **fun-raising** | Client site. |
| **lachys-gardening** | Client site. |
| **ggl-maintenance** | Client site. |
| **llewellyn-property** | Client site. |
| **vp-elite** | Client site. |
| **sandwich-house** | Client site. |
| **hoagies** | Client site. |
| **kanadojo** | Japanese learning app (Next.js). |
| **aid-helpdesk** | Active Directory helpdesk SaaS. |
| **eshis-curriculum** | School curriculum app. |
| **sbl-rankings** | Rankings site. |
| **etsy-agent** | Etsy store listings and product pipeline. |
| **command-center** | This project. Agents can improve it and commit changes themselves. |

New agents: `!new-agent <name>` scaffolds the folder, CLAUDE.md, and memory directory.

---

## Discord commands

### Running agents

| Command | What it does |
|---|---|
| `!run [agent] <prompt>` | Send a prompt to an agent. Picks up the last session automatically. Supports `-opus`, `-sonnet`, `-haiku`, `-codex`, `-gemini`, `--effort high`. |
| `!run [agent]` + attach `.txt` | For long prompts, attach a text file and the bot reads it. |
| `!swarm agent1,agent2 <prompt>` | Same prompt to multiple agents in parallel. |
| `!jarvislog [agent]` | Tell an agent to write its session memory log. |
| `!log [agent]` | Show an agent's latest memory log. |
| `!history [agent]` | Last 8 conversation messages for an agent. |

### Orchestration

| Command | What it does |
|---|---|
| `!manage [minutes]` | Start Jarvis as a background manager. Ticks every N minutes (default 60). |
| `!manage stop` | Stop the manager loop. |
| `!manage hours mon-fri 9-17` | Restrict ticks to active hours only. |
| `!manage codex` | Route all worker tasks to Codex to save Claude quota. |
| `!schedule every 30 hoagies <prompt>` | Recurring scheduled runs. |
| `!todos` | Scan every agent's memory for outstanding flags and blockers. |

### Discord and server

| Command | What it does |
|---|---|
| `!agents` | List all agents with status. |
| `!runs` | Live run registry: who is active, recent results, cost today. |
| `!usage` | Claude and Codex usage, rate-limit status, today's spend. |
| `!sync` | Create Discord categories and channels for all agents. |
| `!board` | Live-updating status board in `#status-board`. |
| `!mirror` | Stream agent output into each agent's own channel. |
| `!leads` | Create `#leads` and show the Netlify webhook URL. |
| `!goals` / `!goal add <text>` | Read or update business goals. |
| `!money` | Create `#money` for Jarvis's monthly revenue updates. |
| `!archive <agent>` | Move a channel to Archive. `undo` to restore. |
| `!gif <name>` | Post a reaction GIF (thinking, coding, done, money...). |
| `!status` | Check the server is reachable. |

---

## Providers

| Provider | Used for |
|---|---|
| Claude (Opus / Sonnet / Haiku) | Main provider. Jarvis orchestration, complex builds. Haiku for cheap sub-tasks. |
| OpenAI Codex | Overflow when Claude usage is high. Good for code tasks. |
| Gemini CLI | Free lane (1,000 req/day). Morning news, summaries, second opinions. |
| Groq | Free, fast. Planning and text-only tasks. |
| DeepSeek | Cheap API for simple edits when other providers are capped. |

Jarvis automatically tracks which providers have headroom and routes accordingly. The target is around 75% on Claude before spilling to free providers, keeping reserve for the things that actually need it.

---

## Setup

**Prerequisites:** Node.js 18+, Claude Code installed, a Discord bot token.

```bash
git clone https://github.com/lachydotmcg/ai-command-center
cd ai-command-center
npm install
cp .env.example .env
cp config.example.json config.json
```

Edit `.env` with your tokens. Edit `config.json` to point at your local directories.

**Start everything:** double-click `start.bat` on Windows. Launches the server, Discord bot, ngrok tunnel, and opens the dashboard.

**Always-on:** double-click `tray.cmd` to put the ACC in your system tray. Right-click the icon for Start / Restart / Stop. Run `install-startup.ps1` once to launch it automatically at Windows login.

**Invite the bot:** generate an OAuth2 invite URL for your bot with these permissions: Read Messages, Send Messages, Manage Channels, Read Message History.

**First run in Discord:**
```
!sync        creates all the categories and channels
!board       live status board
!mirror      streams agent output into their channels
!manage 60   Jarvis starts managing every 60 minutes
```

---

## Webhooks

**Netlify forms**
Run `!leads` in Discord to get your webhook URL. Paste it into Netlify at Site Settings > Forms > Form Notifications > Outgoing webhook. Every submission posts to `#leads` and Jarvis triages it.

**Phone access and external webhooks**
The server runs locally. For phone access, ngrok runs automatically with `start.bat` using a static domain configured in `~/.config/ngrok/ngrok.yml`.

**Security**
Set `ACC_SECRET` in `.env` before exposing the server. All API routes require the bearer token once it is set. The dashboard and Discord bot handle auth automatically. Set `ACC_FORM_KEY` separately for the public form webhook endpoint.

---

## Configuration

| Setting | Env var | Default |
|---|---|---|
| Server port | `ACC_PORT` | `3333` |
| Auth token | `ACC_SECRET` | none (open) |
| Memory logs root | `ACC_MEMORY_ROOT` | `Obsidian/Lachy/agent-memory` |
| Daily Claude budget | `ACC_DAILY_BUDGET` | `$5` |
| Claude usage target | `ACC_USAGE_TARGET` | `0.75` |
| Codex sandbox | `ACC_CODEX_SANDBOX` | `workspace-write` |
| Gemini model | `ACC_GEMINI_MODEL` | `gemini-2.5-flash` |
| Groq model | `ACC_GROQ_MODEL` | `llama-3.3-70b-versatile` |
| Form webhook key | `ACC_FORM_KEY` | none |
| Manager day start | `ACC_DAY_START` | `8` |
| Manager day end | `ACC_DAY_END` | `22` |

---

## Project layout

| File | What it is |
|---|---|
| `server.js` | Express server: agent runner, scheduler, webhooks, provider routing |
| `discord-bot.js` | Discord bot: all commands, status board, run mirroring, GIFs |
| `agent-cli.mjs` | CLI for agents to delegate work to each other |
| `index.html` | Browser dashboard |
| `tray.ps1` | Windows tray controller |
| `start.bat` | Launches everything together |
| `install-startup.ps1` | Adds tray to Windows startup (no admin needed) |
| `config.example.json` | Template for local path config |
| `.env.example` | Template for secrets |

---

MIT
