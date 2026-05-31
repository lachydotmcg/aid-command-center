# Contributing

Thanks for your interest in AI Command Center! It's a deliberately small,
dependency-light project — a single Express server (`server.js`) and a single
self-contained HTML page (`index.html`), plus an optional Discord bot.

## Getting started

```bash
git clone <your-fork>
cd ai-command-center
npm install
cp config.example.json config.json   # optional — edit paths to your setup
node server.js
```

Open http://localhost:3333.

## Project layout

| File | Purpose |
|------|---------|
| `server.js` | Express server: serves the UI, lists agents, reads logs/files, runs `claude --print` |
| `index.html` | The entire front-end — no build step, vanilla JS, retro-CRT theme |
| `discord-bot.js` | Optional Discord bridge to the same `/run` endpoint |
| `config.example.json` | Template for local overrides (paths, port, auth secret) |

> `src/`, `vite.config.js`, and `webhook-server.js` are leftovers from an earlier
> React/Vite prototype and are no longer used by the running app. They may be
> removed in a future cleanup.

## Guidelines

- **No build step for the UI.** `index.html` is intentionally standalone so it
  can be served as a static file. Keep new front-end code in vanilla JS/CSS.
- **Keep dependencies minimal.** The server runs on Express alone; the bot adds
  discord.js. Please discuss before adding more.
- **Match the aesthetic.** The CRT/terminal look (green phosphor, `Press Start 2P`)
  is part of the product. New UI should fit it.
- **Security:** anything that exposes the server publicly should respect
  `ACC_SECRET`. Never commit `.env` or `config.json`.

## Submitting changes

1. Branch from `main`.
2. Make your change; verify the server boots (`node server.js`) and the page
   loads at http://localhost:3333.
3. Open a PR describing the change and how you tested it.
