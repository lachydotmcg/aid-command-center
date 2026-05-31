// AI Command Center — server.js
// Local dashboard for managing Claude Code agents from any browser.
//
// Zero-config by default: sensible defaults are baked in so it "just works" on
// the original machine. For sharing / open-source use, every path and secret is
// overridable via environment variables or an optional config.json (see
// config.example.json). Set ACC_SECRET to require a bearer token before exposing
// the server publicly (e.g. via a Cloudflare Tunnel).
import express from 'express'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import os from 'os'

const __dir = path.dirname(fileURLToPath(import.meta.url))

// ── Config ────────────────────────────────────────────────────────────────────
// Precedence: environment variable → config.json → built-in default.
function loadConfigFile() {
  const p = path.join(__dir, 'config.json')
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return {} }
}
const fileCfg = loadConfigFile()
const pick = (env, key, def) => process.env[env] ?? fileCfg[key] ?? def

const PORT        = Number(pick('ACC_PORT', 'port', 3333))
const MEMORY_ROOT = pick('ACC_MEMORY_ROOT', 'memoryRoot',
  'C:\\Users\\nirke\\OneDrive\\Documents\\Obsidian\\Lachy\\agent-memory')
const ACC_SECRET  = pick('ACC_SECRET', 'secret', null) || null
// Default parent directory for agents scaffolded via POST /new-agent.
const NEW_AGENT_BASE = pick('ACC_NEW_AGENT_BASE', 'newAgentBase',
  'C:\\Users\\nirke\\OneDrive\\Documents\\Lachys Web Dev')

// claude.exe is bundled with the Claude desktop app — not on system PATH.
// Find the latest installed version dynamically (Windows default), or honour an
// explicit override for other setups.
function findClaude() {
  const override = process.env.ACC_CLAUDE_EXE ?? fileCfg.claudeExe
  if (override) { console.log(`  claude  →  ${override} (override)`); return override }
  const base = 'C:\\Users\\nirke\\AppData\\Roaming\\Claude\\claude-code'
  try {
    const versions = fs.readdirSync(base).sort().reverse()
    for (const v of versions) {
      const exe = path.join(base, v, 'claude.exe')
      if (fs.existsSync(exe)) { console.log(`  claude  →  ${exe}`); return exe }
    }
  } catch {}
  console.warn('  ⚠ claude.exe not found — falling back to PATH')
  return 'claude'
}
const CLAUDE_EXE = findClaude()

// Codex CLI (OpenAI) — used as a second provider so Jarvis can spread work across
// both Claude and Codex usage windows. Installed via npm (global) on Windows.
function findCodex() {
  const override = process.env.ACC_CODEX_EXE ?? fileCfg.codexExe
  if (override) { console.log(`  codex   →  ${override} (override)`); return override }
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'codex.cmd'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'codex'),
  ]
  for (const c of candidates) { if (fs.existsSync(c)) { console.log(`  codex   →  ${c}`); return c } }
  console.warn('  ⚠ codex not found — falling back to PATH (codex)')
  return 'codex'
}
const CODEX_EXE = findCodex()

// Agent name → project directory (where `claude --print` runs).
// Defaults match the original setup; override or extend via config.json "agents".
const DEFAULT_AGENT_DIRS = {
  'jarvis':               'C:\\Users\\nirke\\OneDrive\\Documents\\jarvis',
  'kanadojo':             'C:\\Users\\nirke\\kana-dojo',
  'aid-helpdesk':         'C:\\Users\\nirke\\ad-helpdesk',
  'eshis-curriculum':     'C:\\Users\\nirke\\OneDrive\\Documents\\eshis-curriculum',
  'club-window-services': 'C:\\Users\\nirke\\OneDrive\\Documents\\Lachys Web Dev\\Club Window Services',
  'making-moves-express': 'C:\\Users\\nirke\\OneDrive\\Documents\\Lachys Web Dev\\Making Moves Express (Ticket #005)',
  'fun-raising':          'C:\\Users\\nirke\\OneDrive\\Documents\\Lachys Web Dev\\Fun Raising (Ticket #001)',
  'lachys-gardening':     'C:\\Users\\nirke\\OneDrive\\Documents\\Lachys Web Dev\\Lachies Gardening Maintenance (Ticket #004)',
  'ggl-maintenance':      'C:\\Users\\nirke\\OneDrive\\Documents\\Lachys Web Dev\\GGL Maintenance (Ticket #007)',
  'llewellyn-property':   'C:\\Users\\nirke\\OneDrive\\Documents\\Lachys Web Dev\\Llewellyn Property Maintenance (Ticket #009)',
  'vp-elite':             'C:\\Users\\nirke\\OneDrive\\Documents\\Lachys Web Dev\\VP Elite Headlight Restoration (Ticket #010)',
  'sandwich-house':       'C:\\Users\\nirke\\OneDrive\\Documents\\Lachys Web Dev\\Sandwich House (Ticket #011)',
  'hoagies':              'C:\\Users\\nirke\\OneDrive\\Documents\\Lachys Web Dev\\Hoagies',
  'sbl-rankings':         'C:\\Users\\nirke\\OneDrive\\Documents\\Lachys Web Dev\\SBLRankings',
  'lachys-web-dev':       "C:\\Users\\nirke\\OneDrive\\Documents\\Lachys Web Dev\\Lachy's Web Dev (Ticket #000)",
  'command-center':       __dir,
}
const AGENT_DIRS = { ...DEFAULT_AGENT_DIRS, ...(fileCfg.agents || {}), 'command-center': __dir }

const app = express()

function latestLog(agent) {
  const dir = path.join(MEMORY_ROOT, agent)
  try {
    const files = fs.readdirSync(dir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort().reverse()
    if (!files.length) return null
    return { file: files[0], content: fs.readFileSync(path.join(dir, files[0]), 'utf8') }
  } catch { return null }
}

function agentCwd(name) {
  return AGENT_DIRS[name] || path.join(MEMORY_ROOT, name)
}

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json())
app.use((_, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next() })

// Optional bearer-token auth. When ACC_SECRET is unset the server is wide open
// (intended for localhost-only use). When set, every API route except the
// static page and /status requires the token via either:
//   Authorization: Bearer <secret>   or   ?token=<secret>
function authOk(req) {
  if (!ACC_SECRET) return true
  const header = req.get('authorization') || ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null
  const token = bearer || req.query.token
  return token === ACC_SECRET
}
const requireAuth = (req, res, next) =>
  authOk(req) ? next() : res.status(401).json({ error: 'Unauthorized — token required' })

// Serve ONLY the UI page (not the whole directory) so source, package.json, and
// config.json — which may hold the ACC_SECRET — are never downloadable. The page
// and health check stay open so the UI can load and prompt for a token.
app.get(['/', '/index.html'], (_, res) => res.sendFile(path.join(__dir, 'index.html')))
app.get('/status', (_, res) =>
  res.json({ ok: true, time: new Date().toISOString(), authRequired: !!ACC_SECRET }))

// Everything below requires auth (no-op when ACC_SECRET is unset).
app.use(requireAuth)

// ── Routes ──────────────────────────────────────────────────────────────────
app.get('/agents', (_, res) => {
  const known = Object.keys(AGENT_DIRS)
  try {
    const memorized = fs.readdirSync(MEMORY_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
    // known agents first (ordered), then any extra memory-only agents
    const all = [...new Set([...known, ...memorized])]
    res.json(all)
  } catch { res.json(known) }
})

// Persist a newly-scaffolded agent into config.json so it survives restarts.
// config.json's "agents" map is merged over the built-in defaults at boot.
function persistAgent(slug, dir) {
  const p = path.join(__dir, 'config.json')
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')) } catch {}
  cfg.agents = { ...(cfg.agents || {}), [slug]: dir }
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2))
}

function agentTemplate(slug, type) {
  const pretty = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  const isWeb = type !== 'general'
  return `# ${pretty} — Agent

You are the **${pretty}** agent${isWeb ? ', responsible for this web dev client project' : ''}.

## Role
${isWeb
  ? `- Build and maintain ${pretty}'s static website for Lachy's web dev business.\n- Deploy on Netlify. Keep it fast, accessible, and on-brand.\n- Use the \`ui-ux-pro-max\` skill for design-quality work.`
  : `- Handle tasks for the ${pretty} project as directed by Lachy.`}

## Memory
At the end of a session, write a log to:
\`C:\\Users\\nirke\\OneDrive\\Documents\\Obsidian\\Lachy\\agent-memory\\${slug}\\YYYY-MM-DD.md\`

Template:
\`\`\`
# ${pretty} — YYYY-MM-DD

## What I did
- ...

## Files changed
- ...

## Errors / blockers
- ...

## Flags for Lachy 🚩
- ...

## Status
Complete / In Progress / Blocked
\`\`\`

## Context
- Owner: Lachy (bytehavencreations@gmail.com). Windows + OneDrive, Netlify deploys.
`
}

// POST /new-agent — scaffold a new agent: project dir + CLAUDE.md + memory folder,
// then register it (in-memory + config.json) so it appears immediately.
app.post('/new-agent', (req, res) => {
  const { name, dir, type } = req.body || {}
  const slug = (name || '').trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  if (!slug) return res.status(400).json({ error: 'valid name required' })
  if (slug in AGENT_DIRS) return res.status(409).json({ error: `agent "${slug}" already exists` })

  const projectDir = dir || path.join(NEW_AGENT_BASE, slug)
  try {
    fs.mkdirSync(projectDir, { recursive: true })
    const cmdPath = path.join(projectDir, 'CLAUDE.md')
    let claudeMdCreated = false
    if (!fs.existsSync(cmdPath)) { fs.writeFileSync(cmdPath, agentTemplate(slug, type)); claudeMdCreated = true }
    fs.mkdirSync(path.join(MEMORY_ROOT, slug), { recursive: true })
    AGENT_DIRS[slug] = projectDir
    persistAgent(slug, projectDir)
    console.log(`[new-agent] created "${slug}" → ${projectDir}`)
    res.json({ ok: true, agent: slug, dir: projectDir, claudeMdCreated })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Classify an agent as a web-dev client (lives under NEW_AGENT_BASE) or 'core'.
function agentGroup(dir) {
  if (!dir) return 'core'
  const base = path.resolve(NEW_AGENT_BASE).toLowerCase()
  return path.resolve(dir).toLowerCase().startsWith(base) ? 'web' : 'core'
}

// GET /agents/meta — richer agent list with directory + group, for grouping the
// Discord channels into categories. (/agents stays a plain string array.)
app.get('/agents/meta', (_, res) => {
  const known = Object.keys(AGENT_DIRS)
  let extra = []
  try {
    extra = fs.readdirSync(MEMORY_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name).filter(n => !(n in AGENT_DIRS))
  } catch {}
  const all = [...known, ...extra]
  res.json(all.map(name => ({
    name,
    dir: agentCwd(name),
    group: (name in AGENT_DIRS) ? agentGroup(AGENT_DIRS[name]) : 'core',
  })))
})

// Pull the "Flags for Lachy" bullets out of a memory log.
function parseLogFlags(content) {
  if (!content) return []
  const m = content.match(/##\s*Flags for Lachy[^\n]*\n+([\s\S]*?)(?=\n##|\n---|$)/i)
  if (!m) return []
  return m[1].split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(l => l && l !== '-')
}

// GET /todos — scan every agent's latest log for blockers + "Flags for Lachy".
app.get('/todos', (_, res) => {
  const out = []
  for (const a of Object.keys(AGENT_DIRS)) {
    const log = latestLog(a)
    if (!log) continue
    const status = (log.content.match(/##\s*Status\s*\n+([^\n#]+)/i)?.[1] || '').trim().toLowerCase()
    const flags = parseLogFlags(log.content)
    if (flags.length || status.includes('blocked')) {
      out.push({ agent: a, blocked: status.includes('blocked'), file: log.file, flags })
    }
  }
  res.json(out)
})

app.get('/logs/:agent', (req, res) => {
  const log = latestLog(req.params.agent)
  if (!log) return res.status(404).json({ error: 'No logs found' })
  res.json(log)
})

app.get('/logs/:agent/all', (req, res) => {
  const dir = path.join(MEMORY_ROOT, req.params.agent)
  try {
    const files = fs.readdirSync(dir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort().reverse()
    res.json(files)
  } catch { res.status(404).json({ error: 'Agent not found' }) }
})

// ── Model / effort whitelist ──────────────────────────────────────────────────
// Valid choices guard against injecting arbitrary flags through the body.
const VALID_MODELS  = ['opus', 'sonnet', 'haiku']
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

function modelEffortArgs(model, effort) {
  const out = []
  if (model && (VALID_MODELS.includes(model) || /^claude-[\w.-]+$/.test(model))) out.push('--model', model)
  if (effort && VALID_EFFORTS.includes(effort)) out.push('--effort', effort)
  return out
}

// System-prompt note that teaches a top-level agent it can fan independent
// sub-tasks out to other agents (and finish faster). Injected ONLY on top-level
// runs — children spawned via /dispatch and /swarm don't get it, which caps
// delegation at one level and prevents runaway recursion / cost blow-ups.
function delegationPrompt() {
  const agents = Object.keys(AGENT_DIRS).filter(a => a !== 'command-center').join(', ')
  const cli = path.join(__dir, 'agent-cli.mjs').replace(/\\/g, '/')
  return [
    'TEAMWORK: You can delegate independent sub-tasks to other specialist agents to get more done in parallel. Run this from the Bash tool:',
    `  node "${cli}" run <agent> "<prompt>" [--model haiku|sonnet|opus]   # one sub-agent, returns its output`,
    `  node "${cli}" swarm '[{"agent":"<a>","prompt":"..."},{"agent":"<b>","prompt":"..."}]'   # many in parallel`,
    `Available agents: ${agents}.`,
    'Each sub-agent runs in its own project directory. Only delegate genuinely independent work — do small things yourself. Prefer haiku for cheap sub-tasks. When you delegate, first tell the user how many sub-agents you are launching and what each is doing, then summarise their results when they return.',
  ].join('\n')
}

// Build the full claude argv. We always use stream-json so we can extract cost,
// token usage, and the final result while still streaming text deltas live.
function buildArgs({ continueSession, model, effort, prompt, fullPrompt, delegate }) {
  const base = [
    '--print', '--dangerously-skip-permissions',
    '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    ...modelEffortArgs(model, effort),
  ]
  if (delegate) base.push('--append-system-prompt', delegationPrompt())
  return continueSession ? ['--continue', ...base, prompt] : [...base, fullPrompt]
}

// ── Run registry ────────────────────────────────────────────────────────────
// Every spawn (dashboard, agent-to-agent dispatch, swarm) is tracked here so the
// dashboard/Discord can show a live count, cost, and parent/child relationships.
let runSeq = 0
const runs = new Map() // id -> run
const MAX_RUNS = 250
// Latest rate-limit snapshot, captured free from every run's stream. Lets Jarvis
// and the dashboard see how close we are to the usage cap / whether we're out.
let lastUsage = null
const usageWindows = {} // rateLimitType -> latest info (e.g. five_hour, weekly)

function newRun({ agent, prompt, model, effort, parent = null, source = 'dashboard', provider = 'claude' }) {
  const id = `r${++runSeq}`
  const run = {
    id, agent: agent || '(unknown)', provider, model: model || null, effort: effort || null,
    prompt: (prompt || '').slice(0, 200), parent, source,
    status: 'running', startedAt: Date.now(), endedAt: null,
    cost: 0, usage: null, durationMs: null, numTurns: null, exitCode: null,
    codexTokens: 0, output: '', pid: null, needsAction: '', _proc: null,
  }
  runs.set(id, run)
  if (runs.size > MAX_RUNS) {
    const finished = [...runs.values()].filter(r => r.endedAt).sort((a, b) => a.endedAt - b.endedAt)
    while (runs.size > MAX_RUNS && finished.length) runs.delete(finished.shift().id)
  }
  return run
}
function finishRun(run, patch) { Object.assign(run, patch); run.endedAt = Date.now(); run._proc = null }
function isActive(r) { return r.status === 'running' || r.status === 'waiting' }
function publicRun(r) {
  const { _proc, ...rest } = r
  return rest
}

// Spawns claude, parses the stream-json output, updates the run, and streams text
// deltas via onText. Resolves with the full result once the process closes.
function runClaude({ run, args, cwd, onText }) {
  return new Promise(resolve => {
    // Pass the run id + server URL down so any agent that delegates via
    // agent-cli.mjs tags its sub-runs with this run as their parent.
    const env = { ...process.env, ACC_PARENT: run.id, ACC_URL: `http://localhost:${PORT}` }
    const proc = spawn(CLAUDE_EXE, args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env })
    run.pid = proc.pid; run._proc = proc
    proc.stdin.end()
    console.log(`[run ${run.id}] PID ${proc.pid} agent=${run.agent} src=${run.source}${run.model ? ` model=${run.model}` : ''}${run.effort ? ` effort=${run.effort}` : ''}`)

    let buf = '', text = '', stderr = '', result = null
    proc.stdout.on('data', d => {
      buf += d.toString()
      const lines = buf.split('\n'); buf = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        let obj; try { obj = JSON.parse(line) } catch { continue }
        if (obj.type === 'stream_event' &&
            obj.event?.type === 'content_block_delta' &&
            obj.event.delta?.type === 'text_delta') {
          const t = obj.event.delta.text
          text += t; onText?.(t)
        } else if (obj.type === 'result') {
          result = obj
        } else if (obj.type === 'rate_limit_event' && obj.rate_limit_info) {
          const info = { ...obj.rate_limit_info, at: Date.now() }
          lastUsage = info
          // Track each window type (five_hour, weekly, …) separately.
          if (info.rateLimitType) usageWindows[info.rateLimitType] = info
        } else if (obj.type === 'system' && obj.subtype === 'post_turn_summary') {
          run.needsAction = obj.needs_action || ''
        }
      }
    })
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('close', code => {
      const cost = result?.total_cost_usd ?? 0
      const finalText = (text.trim() || result?.result || '').slice(0, 6000) // for Discord mirroring
      finishRun(run, {
        status: code === 0 ? 'done' : 'error', exitCode: code, cost,
        usage: result?.usage || null, durationMs: result?.duration_ms ?? null,
        numTurns: result?.num_turns ?? null, output: finalText,
      })
      console.log(`[run ${run.id}] close code=${code} cost=$${cost.toFixed?.(4) ?? cost}`)
      resolve({ text: text.trim() || result?.result || '', cost, code, stderr, result })
    })
    proc.on('error', err => {
      finishRun(run, { status: 'error', exitCode: -1 })
      resolve({ text: '', cost: 0, code: -1, stderr: err.message, result: null })
    })
  })
}

// Sandbox policy for Codex runs. workspace-write lets an agent edit files in its
// own project directory (exec already runs with approvals set to "never").
// Override with ACC_CODEX_SANDBOX if a project needs broader access.
const CODEX_SANDBOX = pick('ACC_CODEX_SANDBOX', 'codexSandbox', 'workspace-write')

// Runs a prompt through the OpenAI Codex CLI (codex exec). Prompt is fed via
// stdin (avoids all shell-quoting issues); the final message is captured via -o.
// Codex bills against the ChatGPT/Codex plan, not Claude — so cost is tracked as
// token count (codexTokens), not USD.
function runCodex({ run, prompt, model, cwd, onText }) {
  return new Promise(resolve => {
    const outFile = path.join(os.tmpdir(), `codex-${run.id}-${Date.now()}.txt`)
    const flags = ['exec', '--skip-git-repo-check', '--sandbox', CODEX_SANDBOX,
      '-C', `"${cwd}"`, '-o', `"${outFile}"`]
    if (model) flags.push('-m', model)
    flags.push('-') // read prompt from stdin
    const cmd = `"${CODEX_EXE}" ${flags.join(' ')}`
    const env = { ...process.env, ACC_PARENT: run.id, ACC_URL: `http://localhost:${PORT}` }
    // shell:true because codex is a .cmd on Windows; no user input on the command
    // line (prompt goes via stdin), so this is quoting-safe.
    const proc = spawn(cmd, { cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'], env })
    run.pid = proc.pid; run._proc = proc
    console.log(`[run ${run.id}] codex PID ${proc.pid} agent=${run.agent} src=${run.source}${model ? ` model=${model}` : ''}`)
    proc.stdin.write(prompt); proc.stdin.end()

    let stdout = '', stderr = ''
    proc.stdout.on('data', d => { stdout += d.toString() })
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('close', code => {
      let out = ''
      try { out = fs.readFileSync(outFile, 'utf8').trim() } catch {}
      try { fs.unlinkSync(outFile) } catch {}
      if (!out) out = stdout.trim() // fallback if -o didn't write
      const tokMatch = (stdout + '\n' + stderr).match(/tokens used[\s:]*([\d,]+)/i)
      const tokens = tokMatch ? parseInt(tokMatch[1].replace(/,/g, ''), 10) : 0
      onText?.(out) // codex has no live deltas — surface the whole result once
      finishRun(run, { status: code === 0 ? 'done' : 'error', exitCode: code, cost: 0, codexTokens: tokens, output: out.slice(0, 6000) })
      console.log(`[run ${run.id}] codex close code=${code} tokens=${tokens}`)
      resolve({ text: out, cost: 0, code, stderr })
    })
    proc.on('error', err => {
      finishRun(run, { status: 'error', exitCode: -1 })
      resolve({ text: '', cost: 0, code: -1, stderr: err.message })
    })
  })
}

// Single entry point: picks Claude or Codex based on run.provider.
function dispatchRun({ run, cwd, prompt, fullPrompt, continueSession, model, effort, delegate, onText }) {
  if (run.provider === 'codex') {
    return runCodex({ run, prompt: fullPrompt ?? prompt, model, cwd, onText })
  }
  const args = buildArgs({ continueSession, model, effort, prompt, fullPrompt, delegate })
  return runClaude({ run, args, cwd, onText })
}

// Does this agent already have a Claude Code conversation thread? (Used to decide
// --continue vs. a fresh memory-injected session, keeping one coherent identity.)
function hasHistory(agent) {
  try {
    const projDir = path.join(CLAUDE_PROJECTS, encodeClaudePath(agentCwd(agent)))
    return fs.readdirSync(projDir).some(f => f.endsWith('.jsonl'))
  } catch { return false }
}

// POST /run — streams a single agent run to the dashboard as SSE.
app.post('/run', async (req, res) => {
  const { agent, prompt, continueSession, model, effort, delegate, provider } = req.body
  if (!prompt?.trim()) return res.status(400).json({ error: 'prompt required' })

  const cwd = agentCwd(agent)
  // Fresh sessions get the latest memory log injected for prior-session context.
  let fullPrompt = prompt
  if (!continueSession) {
    const log = latestLog(agent)
    if (log) fullPrompt = `[Session memory — ${log.file}]\n${log.content}\n\n---\n\n${prompt}`
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  const sse = o => { try { res.write(`data: ${JSON.stringify(o)}\n\n`) } catch {} }

  const run = newRun({ agent, prompt, model, effort, source: 'dashboard', provider: provider === 'codex' ? 'codex' : 'claude' })
  sse({ runId: run.id, provider: run.provider })

  res.on('close', () => {
    if (isActive(run)) { try { run._proc?.kill() } catch {} ; finishRun(run, { status: 'error', exitCode: -1 }) }
  })

  // Allow subtasking on top-level runs by default (opt out with delegate:false).
  const r = await dispatchRun({ run, cwd, prompt, fullPrompt, continueSession, model, effort, delegate: delegate !== false, onText: t => sse({ text: t }) })
  if (r.stderr) sse({ error: r.stderr })
  sse({ done: true, code: r.code, cost: r.cost, codexTokens: run.codexTokens, durationMs: run.durationMs, numTurns: run.numTurns, usage: run.usage })
  res.end()
})

// POST /dispatch — synchronous single agent run (used for agent-to-agent calls).
// Returns JSON when the run finishes. Always a fresh session (one-shot task).
app.post('/dispatch', async (req, res) => {
  const { agent, prompt, model, effort, parent, provider } = req.body
  if (!agent || !prompt?.trim()) return res.status(400).json({ error: 'agent and prompt required' })
  if (!(agent in AGENT_DIRS) && !fs.existsSync(agentCwd(agent)))
    return res.status(404).json({ error: `unknown agent: ${agent}` })

  const cwd = agentCwd(agent)
  const run = newRun({ agent, prompt, model, effort, parent: parent || null, source: 'agent', provider: provider === 'codex' ? 'codex' : 'claude' })
  const r = await dispatchRun({ run, cwd, prompt, fullPrompt: prompt, continueSession: false, model, effort, delegate: false })
  res.json({ runId: run.id, agent, provider: run.provider, output: r.text, cost: r.cost, codexTokens: run.codexTokens, exitCode: r.code, durationMs: run.durationMs })
})

// POST /swarm — run many agents in parallel. tasks: [{agent,prompt,model,effort,provider}]
app.post('/swarm', async (req, res) => {
  const { tasks, parent } = req.body
  if (!Array.isArray(tasks) || !tasks.length) return res.status(400).json({ error: 'tasks array required' })
  if (tasks.length > 12) return res.status(400).json({ error: 'too many tasks (max 12)' })

  const results = await Promise.all(tasks.map(async t => {
    if (!t?.agent || !t?.prompt?.trim()) return { agent: t?.agent || '(none)', output: '', cost: 0, exitCode: -1, error: 'agent and prompt required' }
    const cwd = agentCwd(t.agent)
    const run = newRun({ agent: t.agent, prompt: t.prompt, model: t.model, effort: t.effort, parent: parent || 'swarm', source: 'swarm', provider: t.provider === 'codex' ? 'codex' : 'claude' })
    const r = await dispatchRun({ run, cwd, prompt: t.prompt, fullPrompt: t.prompt, continueSession: false, model: t.model, effort: t.effort, delegate: false })
    return { runId: run.id, agent: t.agent, provider: run.provider, output: r.text, cost: r.cost, exitCode: r.code }
  }))
  res.json({ count: results.length, totalCost: results.reduce((s, r) => s + (r.cost || 0), 0), tasks: results })
})

// GET /runs — live view: active runs, recent finished runs, and aggregate counts.
app.get('/runs', (_, res) => {
  const all = [...runs.values()].sort((a, b) => b.startedAt - a.startedAt)
  const active = all.filter(isActive)
  const recent = all.filter(r => !isActive(r)).slice(0, 25)
  const today = new Date().toDateString()
  const costToday = all.filter(r => new Date(r.startedAt).toDateString() === today)
    .reduce((s, r) => s + (r.cost || 0), 0)
  res.json({
    active: active.map(publicRun),
    recent: recent.map(publicRun),
    counts: { active: active.length, total: all.length, costToday },
  })
})

// GET /runs/:id — single run detail.
app.get('/runs/:id', (req, res) => {
  const r = runs.get(req.params.id)
  if (!r) return res.status(404).json({ error: 'not found' })
  res.json(publicRun(r))
})

function costToday() {
  const today = new Date().toDateString()
  return [...runs.values()].filter(r => new Date(r.startedAt).toDateString() === today)
    .reduce((s, r) => s + (r.cost || 0), 0)
}

function codexTokensToday() {
  const today = new Date().toDateString()
  return [...runs.values()].filter(r => r.provider === 'codex' && new Date(r.startedAt).toDateString() === today)
    .reduce((s, r) => s + (r.codexTokens || 0), 0)
}

// Target ceiling: Jarvis should push Claude usage up to this fraction of each
// window before spilling work to Codex, but keep the rest in reserve.
const USAGE_TARGET = Number(pick('ACC_USAGE_TARGET', 'usageTarget', 0.75))

// Highest utilization across all Claude windows (five_hour, weekly, …) as 0–1.
// Often null below the warning threshold — the API only reports a number near the cap.
function claudeUtilization() {
  const us = Object.values(usageWindows).map(w => typeof w.utilization === 'number' ? w.utilization : null).filter(x => x !== null)
  return us.length ? Math.max(...us) : null
}
// Actionable traffic light. The stream only surfaces a utilization number near
// the cap, so we key off status: 'ok' (work freely) | 'warning' (near cap →
// reserve + spill to Codex) | 'blocked' (rejected/out of credits → Codex only).
function claudeState() {
  const u = lastUsage
  if (u && (u.status === 'rejected' || u.overageDisabledReason === 'out_of_credits')) return 'blocked'
  const util = claudeUtilization()
  const warning = Object.values(usageWindows).some(w => String(w.status || '').includes('warning'))
  if (warning || (util !== null && util >= USAGE_TARGET)) return 'warning'
  return 'ok'
}

// GET /usage — per-window rate-limit snapshot + today's spend, for Jarvis +
// dashboard/Discord. `claudeHeadroom` is how much of the target is still free.
app.get('/usage', (_, res) => {
  const u = lastUsage
  const util = claudeUtilization()
  res.json({
    rateLimit: u,
    windows: usageWindows,
    claudeUtilization: util,
    claudeState: claudeState(),
    target: USAGE_TARGET,
    claudeHeadroom: util === null ? null : Math.max(0, USAGE_TARGET - util),
    blocked: claudeState() === 'blocked',
    resetsAt: u?.resetsAt || null,
    costToday: costToday(),
    codexTokensToday: codexTokensToday(),
  })
})

// ── Scheduler ─────────────────────────────────────────────────────────────────
// A tiny persistent scheduler so work happens in the background on a cadence.
// Task: { id, type:'agent'|'manager', agent, prompt, model, effort,
//         everyMin?(recurring) | runAt?(one-off ms), nextRun, enabled, createdAt }
const SCHEDULE_FILE = path.join(__dir, 'schedule.json')
const DAILY_BUDGET = Number(pick('ACC_DAILY_BUDGET', 'dailyBudget', 5)) // soft cap, USD
// Lachy's daytime window (local time) = the GOOD time for heavy work, because it
// is the Americas' off-peak (Anthropic load is lower, so it eats less of the
// weekly limit). His NIGHT is Americas prime → expensive, so defer heavy work.
// Default daytime 8:00–22:00 local.
const DAY_START = Number(pick('ACC_DAY_START', 'dayStart', 8))
const DAY_END   = Number(pick('ACC_DAY_END', 'dayEnd', 22))
function isDaytime() { const h = new Date().getHours(); return h >= DAY_START && h < DAY_END }
function isWithinActiveHours(activeHours) {
  if (!activeHours || !activeHours.length) return true
  const now = new Date(), day = now.getDay(), hour = now.getHours()
  return activeHours.some(e => Array.isArray(e.days) && e.days.includes(day) && hour >= e.start && hour < e.end)
}
let schedSeq = 0
function loadSchedule() { try { return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')) } catch { return [] } }
function saveSchedule(list) { try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(list, null, 2)) } catch {} }
// keep schedSeq ahead of any persisted ids
for (const t of loadSchedule()) { const n = parseInt(String(t.id).replace(/\D/g, ''), 10); if (n > schedSeq) schedSeq = n }

// Briefing handed to Jarvis on each manager tick: current state + guardrails.
async function buildManagerBriefing() {
  const todos = []
  for (const a of Object.keys(AGENT_DIRS)) {
    const log = latestLog(a); if (!log) continue
    const status = (log.content.match(/##\s*Status\s*\n+([^\n#]+)/i)?.[1] || '').trim().toLowerCase()
    const flags = parseLogFlags(log.content)
    if (flags.length || status.includes('blocked')) todos.push({ agent: a, blocked: status.includes('blocked'), flags })
  }
  const util = claudeUtilization()
  const utilPct = util === null ? null : Math.round(util * 100)
  const targetPct = Math.round(USAGE_TARGET * 100)
  const codexTok = codexTokensToday()
  const state = claudeState() // 'ok' | 'warning' | 'blocked'
  const jlog = latestLog('jarvis')

  let b = `[Jarvis manager tick — ${new Date().toLocaleString()}]\n\n`
  b += `You are running autonomously as Lachy's manager (he's "out and about" — act, don't ask). You have standing authority to delegate via agent-cli.mjs across BOTH providers: Claude Code (\`--model\`) and Codex (\`--codex\`).\n\n`

  // Per-window Claude usage
  b += `CLAUDE USAGE:\n`
  const wins = Object.values(usageWindows)
  if (wins.length) {
    for (const w of wins) b += `  - ${w.rateLimitType}: ${w.utilization != null ? Math.round(w.utilization * 100) + '%' : w.status}${w.resetsAt ? ` (resets ${new Date(w.resetsAt * 1000).toLocaleTimeString()})` : ''}\n`
  } else b += `  - (no data yet)\n`
  b += `CODEX USAGE: ~${codexTok.toLocaleString()} tokens used today (separate ChatGPT/Codex plan).\n\n`

  b += `BUDGET POLICY — work BOTH providers hard (Lachy wants ~${targetPct}% utilisation), keep ~${100 - targetPct}% in reserve. NOTE: Claude only reports an exact % near the cap, so use this signal:\n`
  if (state === 'blocked') {
    b += `  ⛔ Claude is RATE-LIMITED right now. Route all work to Codex (\`--codex\`). Keep Claude only for your own cheap thinking so you stay alive.\n`
  } else if (state === 'warning') {
    b += `  ⚠️ Claude is NEAR the cap${utilPct != null ? ` (~${utilPct}%)` : ''}. Spill new delegation to Codex (\`--codex\`); reserve remaining Claude for orchestration + your own ticks.\n`
  } else {
    b += `  ✅ Claude is GREEN (below the warning threshold — plenty of headroom). Use it: delegate MULTIPLE to-dos in parallel this tick to make real progress. Prefer Claude for substantive work (you're the smartest); send overflow/bulk to Codex (\`--codex\`) to spread load. Always keep enough Claude headroom to run your own manager ticks.\n`
  }
  b += `  Prefer haiku for cheap sub-tasks. Reserve opus/sonnet for high-value work.\n`

  // Timing: his DAYTIME is Americas off-peak (cheap on the weekly limit) → go
  // hard. His NIGHT is Americas prime (burns the weekly limit) → keep light.
  const day = isDaytime()
  b += `\nTIME: ${new Date().toLocaleString()} — ${day ? `Lachy's DAYTIME (Americas off-peak — cheap on the weekly limit). GOOD time for heavy/bulk work: go hard now.` : `Lachy's NIGHT (Americas PRIME — burns the weekly limit fast). Keep this tick LIGHT; defer heavy/bulk delegation and \`schedule\` it for daytime (after ${DAY_START}:00).`}\n`

  // Month-start: trigger the big monthly planning + money report on the 1st.
  if (new Date().getDate() === 1) {
    b += `\n📅 IT'S THE 1ST — MONTH START. Do the big planning pass: roll \`business\\goals.md\` forward (new revenue target + goals), review every project, set this month's venture experiments, and post a money + goals update to the #money channel via \`node agent-cli.mjs discord say money "..."\`. This is a heavy tick — plan thoroughly.\n`
  }

  b += `\nOUTSTANDING (${todos.length}):\n` + (todos.length
    ? todos.map(t => `- ${t.blocked ? '[BLOCKED] ' : ''}${t.agent}: ${(t.flags || []).slice(0, 2).join(' · ') || 'blocked'}`).join('\n')
    : '- none')
  b += `\n\nAlso advance Lachy's standing goals (web-dev client growth, Etsy, profitability, his projects) per your CLAUDE.md — not just blockers. Pick concrete actions, delegate them, and report crisply.`
  if (jlog) b += `\n\n--- Your last memory log (${jlog.file}) ---\n${jlog.content.slice(0, 1500)}`
  b += `\n\nAt the END of your response, remind Lachy in BOLD to run \`!jarvislog\` so this session can hand over.`
  return b
}

async function runScheduledTask(t) {
  try {
    if (t.type === 'manager') {
      let briefing = await buildManagerBriefing()
      if (t.prompt) briefing += `\n\nSPECIAL DIRECTIVE THIS TICK:\n${t.prompt}`
      // Coherent Jarvis: resume its one thread if it exists, else fresh (the
      // briefing already carries memory). Same logic as !run jarvis, so manager
      // ticks and ad-hoc chats are the SAME Jarvis.
      const cont = hasHistory('jarvis')
      const run = newRun({ agent: 'jarvis', prompt: '[manager tick]', model: t.model || 'sonnet', effort: t.effort, source: 'manager' })
      await dispatchRun({ run, cwd: agentCwd('jarvis'), prompt: briefing, fullPrompt: briefing, continueSession: cont, model: t.model || 'sonnet', effort: t.effort, delegate: true })
    } else {
      const run = newRun({ agent: t.agent, prompt: t.prompt, model: t.model, effort: t.effort, source: 'schedule', provider: t.provider === 'codex' ? 'codex' : 'claude' })
      await dispatchRun({ run, cwd: agentCwd(t.agent), prompt: t.prompt, fullPrompt: t.prompt, continueSession: false, model: t.model, effort: t.effort, delegate: true })
    }
  } catch (e) { console.warn(`[sched ${t.id}] failed:`, e.message) }
}

async function schedulerTick() {
  const list = loadSchedule()
  const now = Date.now()
  let changed = false
  for (const t of list) {
    if (!t.enabled || t.nextRun > now) continue
    if (t.type === 'manager' && !isWithinActiveHours(t.activeHours)) {
      console.log(`[sched ${t.id}] skipping manager tick (outside active hours)`)
      if (t.everyMin) t.nextRun = now + t.everyMin * 60000
      else t.enabled = false
      changed = true
      continue
    }
    console.log(`[sched ${t.id}] firing ${t.type} ${t.agent || ''}`)
    runScheduledTask(t) // fire-and-forget so the tick stays responsive
    if (t.everyMin) t.nextRun = now + t.everyMin * 60000
    else t.enabled = false // one-off
    changed = true
  }
  if (changed) saveSchedule(list)
}
setInterval(schedulerTick, 60000)

// POST /schedule — create a task. body: { type, agent, prompt, model, effort, everyMin, runAt, activeHours }
// activeHours (manager tasks only): [{days:[0-6], start:<hour>, end:<hour>}] — local time; omit for always-active.
app.post('/schedule', (req, res) => {
  const { type = 'agent', agent, prompt, model, effort, everyMin, runAt, provider, activeHours } = req.body || {}
  if (type === 'agent' && (!agent || !prompt?.trim())) return res.status(400).json({ error: 'agent + prompt required' })
  if (!everyMin && !runAt) return res.status(400).json({ error: 'everyMin or runAt required' })
  const list = loadSchedule()
  const now = Date.now()
  const task = {
    id: `s${++schedSeq}`, type, agent: agent || (type === 'manager' ? 'jarvis' : agent),
    prompt: prompt || null, model: model || null, effort: effort || null,
    provider: provider === 'codex' ? 'codex' : 'claude',
    everyMin: everyMin ? Number(everyMin) : null, runAt: runAt ? Number(runAt) : null,
    nextRun: runAt ? Number(runAt) : now + (Number(everyMin) || 0) * 60000,
    activeHours: Array.isArray(activeHours) ? activeHours : null,
    enabled: true, createdAt: now,
  }
  list.push(task); saveSchedule(list)
  res.json({ ok: true, task })
})

// GET /schedule — list tasks.
app.get('/schedule', (_, res) => res.json(loadSchedule()))

// ── Discord ops queue ─────────────────────────────────────────────────────────
// Lets Jarvis reorganise Discord itself (archive/move channels, post messages).
// Jarvis pushes ops via agent-cli; the bot polls /discord-ops and executes them.
const DISCORD_OPS_FILE = path.join(__dir, 'discord-ops.json')
let opSeq = 0
function loadOps() { try { return JSON.parse(fs.readFileSync(DISCORD_OPS_FILE, 'utf8')) } catch { return [] } }
function saveOps(l) { try { fs.writeFileSync(DISCORD_OPS_FILE, JSON.stringify(l, null, 2)) } catch {} }
for (const o of loadOps()) { const n = parseInt(String(o.id).replace(/\D/g, ''), 10); if (n > opSeq) opSeq = n }

// POST /discord-op — queue an op. { op:'archive'|'unarchive'|'say'|'move', agent?, channel?, text?, category? }
app.post('/discord-op', (req, res) => {
  const { op, agent, channel, text, category } = req.body || {}
  if (!op) return res.status(400).json({ error: 'op required' })
  const list = loadOps()
  const entry = { id: `o${++opSeq}`, op, agent: agent || null, channel: channel || null, text: text || null, category: category || null, createdAt: Date.now() }
  list.push(entry); saveOps(list)
  res.json({ ok: true, op: entry })
})
app.get('/discord-ops', (_, res) => res.json(loadOps()))
app.post('/discord-ops/ack', (req, res) => {
  const ids = new Set(req.body?.ids || [])
  const list = loadOps().filter(o => !ids.has(o.id))
  saveOps(list); res.json({ ok: true, remaining: list.length })
})

// DELETE /schedule/:id — remove a task.
app.delete('/schedule/:id', (req, res) => {
  const list = loadSchedule()
  const next = list.filter(t => t.id !== req.params.id)
  saveSchedule(next)
  res.json({ ok: true, removed: list.length - next.length })
})

// GET /files/:agent?dir=subpath — list project directory
app.get('/files/:agent', (req, res) => {
  const base = path.resolve(agentCwd(req.params.agent))
  const target = path.resolve(req.query.dir ? path.join(base, req.query.dir) : base)
  if (!target.startsWith(base)) return res.status(403).json({ error: 'Forbidden' })
  try {
    const items = fs.readdirSync(target, { withFileTypes: true })
      .filter(e => e.name !== 'node_modules' && !e.name.startsWith('.git'))
      .map(e => {
        const isDir = e.isDirectory()
        return { name: e.name, dir: isDir, size: isDir ? null : fs.statSync(path.join(target, e.name)).size }
      })
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name))
    res.json({ path: req.query.dir || '', items })
  } catch { res.status(404).json({ error: 'Not found' }) }
})

// GET /file/:agent?p=filepath — read a project file
app.get('/file/:agent', (req, res) => {
  const base = path.resolve(agentCwd(req.params.agent))
  if (!req.query.p) return res.status(400).json({ error: 'Missing p' })
  const full = path.resolve(path.join(base, req.query.p))
  if (!full.startsWith(base)) return res.status(403).json({ error: 'Forbidden' })
  try {
    const stat = fs.statSync(full)
    if (stat.size > 300_000) return res.json({ content: '(file too large — >300KB)', truncated: true })
    const content = fs.readFileSync(full, 'utf8')
    res.json({ content, size: stat.size })
  } catch { res.status(404).json({ error: 'Not found' }) }
})

// GET /memory/:agent/:file — read a specific memory log by filename.
// Resolve the final path and confirm it stays inside the agent's memory dir;
// this contains traversal attempts (e.g. encoded ../) regardless of how the
// route param is decoded.
app.get('/memory/:agent/:file', (req, res) => {
  const base = path.resolve(path.join(MEMORY_ROOT, req.params.agent))
  const full = path.resolve(path.join(base, req.params.file))
  if (full !== base && !full.startsWith(base + path.sep))
    return res.status(403).json({ error: 'Forbidden' })
  try {
    res.json({ content: fs.readFileSync(full, 'utf8') })
  } catch { res.status(404).json({ error: 'Not found' }) }
})

// GET /history/:agent — load the most recent Claude Code conversation for this agent.
// Claude stores sessions as .jsonl files in ~/.claude/projects/[encoded-path]/
// The path encoding: replace : with - and \ or / with -, spaces with -
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects')
function encodeClaudePath(cwd) {
  return path.resolve(cwd).replace(/:/g, '-').replace(/[\\/]/g, '-').replace(/\s+/g, '-')
}

app.get('/history/:agent', (req, res) => {
  try {
    const projDir = path.join(CLAUDE_PROJECTS, encodeClaudePath(agentCwd(req.params.agent)))
    const files = fs.readdirSync(projDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(projDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    if (!files.length) return res.json({ messages: [] })
    const raw = fs.readFileSync(path.join(projDir, files[0].name), 'utf8')
    const messages = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line)
        if (obj.type !== 'user' && obj.type !== 'assistant') continue
        const content = obj.message?.content
        if (!content) continue
        let text = typeof content === 'string' ? content
          : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text).join('\n')
          : ''
        // Strip memory injection prefix added by /run
        text = text.replace(/^\[Session memory — [^\]]+\]\n[\s\S]*?\n---\n\n/, '')
        // Skip automated/scheduled task wrapper messages
        if (text.startsWith('<scheduled-task') || text.startsWith('<queue-operation')) continue
        if (text.trim()) messages.push({ role: obj.type, text: text.trim() })
      } catch {}
    }
    res.json({ messages })
  } catch { res.json({ messages: [] }) }
})

app.listen(PORT, () => {
  console.log(`\n  AI Command Center`)
  console.log(`  Local  →  http://localhost:${PORT}`)
  console.log(`  Tunnel →  cloudflared tunnel --url http://localhost:${PORT}`)
  console.log(`  Auth   →  ${ACC_SECRET ? 'ON (ACC_SECRET set)' : 'OFF — localhost only, do not expose'}\n`)
})
