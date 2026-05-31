# Change Log — AI Command Center

A running log of changes made to the AI Command Center, newest first.

---

## 2026-05-31 — Open-source prep, configurability, auth & UX (automated session)

Focus: quality, security, and making the project ready to open-source. All
changes are backward-compatible — the app still runs with zero config on the
original machine.

### Security (the important one)

- **Fixed a source/secret exposure.** The server previously did
  `express.static(__dir)`, which served the *entire* project directory. That
  meant `GET /config.json` (which can hold the `ACC_SECRET`), `/server.js`,
  `/package.json`, etc. were all downloadable. Replaced with an explicit route
  that serves **only `index.html`**. Verified `/config.json`, `/server.js`, and
  `/.env` now return 401/blocked instead of their contents.
- **Hardened the `/memory/:agent/:file` route** against path traversal. A string
  check (`includes('..')`) wasn't enough because of how Express decodes route
  params. Now resolves the final path and confirms it stays inside the agent's
  memory directory (same `path.resolve` containment the `/file` and `/files`
  routes use). Verified encoded `..%2f` attempts return 403.
- **Added optional bearer-token auth (`ACC_SECRET`).** This was the README's
  long-standing TODO before exposing the server publicly. When set, every API
  route (except `/status` and the UI page) requires the token via
  `Authorization: Bearer <token>` or `?token=`. When unset, behaviour is
  unchanged (open, localhost-only). `/status` now reports `authRequired`.

### Configurability (for open-sourcing)

- `server.js` is now driven by env vars / an optional `config.json`, falling back
  to the original hardcoded defaults:
  - `ACC_PORT` / `port` (default 3333)
  - `ACC_MEMORY_ROOT` / `memoryRoot`
  - `ACC_SECRET` / `secret`
  - `ACC_CLAUDE_EXE` / `claudeExe` (overrides claude.exe auto-detection — needed
    on non-Windows / non-default installs)
  - `agents` map (merged over the built-in agent→directory list)
- Added `config.example.json` documenting all of the above.

### Open-source scaffolding (new files)

- `LICENSE` — MIT.
- `.gitignore` — excludes `node_modules`, `.env`, `config.json`, logs, scratch.
- `.env.example` — template for the Discord bot token.
- `config.example.json` — template for local server config.
- `CONTRIBUTING.md` — project layout, dev setup, guidelines, note on legacy files.

### UI / UX (`index.html`)

- **Agent filter box** on the home grid; press `/` to focus it, `Esc` to clear.
- **🚩 flag indicator** on agent cards when an agent left "Flags for Lachy" notes
  (wires up the previously-unused `parseFlags`).
- **Context-aware Copy button** (⧉) in the agent header — copies the current
  tab's content (memory / file / run output) with a toast confirmation.
- **Toast notifications** for copy success/failure.
- **Token flow** — if the server requires auth, the UI prompts once for the token
  and stores it in `localStorage`, attaching it to all requests (including the
  `/run` stream).
- **`--continue` preference persists** across visits.
- **Keyboard shortcuts**: `/` focus search · `Esc` back/clear · `Enter` run ·
  `Shift+Enter` newline.
- Friendlier offline message on the home grid.

### Housekeeping

- Fixed `.claude/launch.json`, which pointed at a non-existent `npm run dev`
  (leftover from the abandoned Vite prototype). Now launches `node server.js`
  on port 3333.
- Rewrote `README.md`: features list, configuration table, auth/tunnel guidance,
  full endpoint table with auth column, Discord bot section, project layout, and
  license/contributing links.

### Verification

- Server boots in default (open) mode and with `ACC_SECRET` set — tested
  `/status`, `/agents`, auth 401/200 paths, `config.json` precedence, traversal
  containment, and the secret/source non-exposure.
- `index.html` script extracted and passed `node --check` (no syntax errors).
- All temporary test servers and scratch files cleaned up.

### Notes / follow-ups (not done this session)

- `src/`, `vite.config.js`, `main.jsx`, `App.jsx`, `index.css`, and
  `webhook-server.js` are dead remnants of an earlier React/Vite prototype (the
  app is now a single static `index.html`). Left in place and documented in
  `CONTRIBUTING.md`; a future cleanup could remove them.
- The repo is not yet a git repository. Scaffolding is in place to `git init`
  whenever you're ready to publish.
