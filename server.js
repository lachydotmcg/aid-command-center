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
function asBool(value, def = false) {
  if (value == null || value === '') return def
  if (typeof value === 'boolean') return value
  return /^(1|true|yes|on)$/i.test(String(value).trim())
}
function asList(value) {
  if (!value) return []
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean)
  return String(value).split(/[;\n]/).map(s => s.trim()).filter(Boolean)
}
function existingDirs(dirs) {
  const seen = new Set()
  return dirs.filter(d => {
    const full = path.resolve(d)
    if (seen.has(full)) return false
    seen.add(full)
    return fs.existsSync(full)
  })
}
function codexSandbox(value) {
  const allowed = new Set(['read-only', 'workspace-write', 'danger-full-access'])
  const v = String(value || '').trim()
  return allowed.has(v) ? v : 'workspace-write'
}
function cmdQuote(value) {
  const s = String(value)
  return /[\s&()^|<>"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

const CODE_EDITOR_SYSTEM_PROMPT = 'You are a precise code editor. When given file contents and a task, return only the complete modified file. Do not explain. Do not add markdown fences unless the file itself is markdown.'
const FILE_PATTERN = /\b([\w./-]+\.(?:html|css|js|mjs|ts|tsx|jsx|json|py|md|sh|txt|env\.example|config\.[a-z]+))\b/g
const AUTO_INJECT_EXTS = new Set(['.html', '.css', '.js', '.mjs', '.json', '.md', '.ts', '.tsx', '.py'])
const AUTO_INJECT_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build'])
const AUTO_INJECT_MAX_FILE_BYTES = 6 * 1024
const AUTO_INJECT_MAX_CHARS = 24000

function mentionedFiles(prompt) {
  return [...new Set([...String(prompt || '').matchAll(FILE_PATTERN)].map(m => m[1]))]
}

function projectFilePath(cwd, rel) {
  if (!cwd) return null
  const base = path.resolve(cwd)
  const full = path.resolve(cwd, rel)
  const baseCmp = process.platform === 'win32' ? base.toLowerCase() : base
  const fullCmp = process.platform === 'win32' ? full.toLowerCase() : full
  return (fullCmp === baseCmp || fullCmp.startsWith(baseCmp + path.sep)) ? full : null
}

function directoryListing(cwd) {
  try {
    return fs.readdirSync(cwd, { withFileTypes: true })
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

function autoInjectPriority(rel) {
  const name = path.basename(rel).toLowerCase()
  const ext = path.extname(name)
  if (name === 'index.html') return 0
  if (ext === '.html') return 1
  if (ext === '.js' || ext === '.mjs' || ext === '.ts' || ext === '.tsx') return 2
  if (ext === '.css') return 3
  if (ext === '.json') return 4
  if (ext === '.md') return 5
  return 6
}

function collectAutoInjectFiles(cwd) {
  const base = path.resolve(cwd)
  const candidates = []

  function walk(dir) {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (AUTO_INJECT_SKIP_DIRS.has(entry.name.toLowerCase())) continue
        walk(full)
        continue
      }
      if (!entry.isFile()) continue

      const ext = path.extname(entry.name).toLowerCase()
      if (!AUTO_INJECT_EXTS.has(ext)) continue
      try {
        const stat = fs.statSync(full)
        if (stat.size >= AUTO_INJECT_MAX_FILE_BYTES) continue
        candidates.push({
          full,
          rel: path.relative(base, full).replace(/\\/g, '/'),
        })
      } catch {}
    }
  }

  walk(base)

  candidates.sort((a, b) =>
    autoInjectPriority(a.rel) - autoInjectPriority(b.rel) ||
    a.rel.localeCompare(b.rel))

  const files = []
  let totalChars = 0
  let omitted = 0
  for (const candidate of candidates) {
    let content = ''
    try { content = fs.readFileSync(candidate.full, 'utf8') } catch { omitted++; continue }
    if (totalChars + content.length > AUTO_INJECT_MAX_CHARS) { omitted++; continue }
    totalChars += content.length
    files.push({ rel: candidate.rel, content })
  }

  return { files, omitted }
}

function autoProjectContext(cwd, agent = 'unknown') {
  const directory = path.resolve(cwd)
  const listing = directoryListing(directory)
  const { files, omitted } = collectAutoInjectFiles(directory)
  const fileList = listing.length ? listing.join('\n') : '(directory listing unavailable)'
  const fileContents = files.length
    ? files.map(f => `=== FILE: ${f.rel} ===\n${f.content}\n=== END: ${f.rel} ===`).join('\n\n')
    : '(no eligible files under 6KB found)'
  const omittedNote = omitted
    ? `\n\n... [${omitted} eligible file${omitted === 1 ? '' : 's'} omitted due to ${AUTO_INJECT_MAX_CHARS} char cap]`
    : ''

  return `=== PROJECT CONTEXT (auto-injected): ${agent || 'unknown'} ===\nDirectory: ${directory}\n${fileList}\n\n${fileContents}${omittedNote}\n=== END PROJECT CONTEXT ===`
}

function injectFiles(prompt, cwd, referencePrompt = prompt, agent = 'unknown') {
  if (!cwd) return prompt
  const mentioned = mentionedFiles(referencePrompt)

  const injected = []
  for (const rel of mentioned) {
    const full = projectFilePath(cwd, rel)
    if (!full) continue
    try {
      const content = fs.readFileSync(full, 'utf8')
      const capped = content.length > 8000 ? content.slice(0, 8000) + '\n... [truncated]' : content
      injected.push(`=== FILE: ${rel} ===\n${capped}\n=== END: ${rel} ===`)
    } catch {}
  }

  const editInstructions = `To edit an existing file use EDIT blocks (safe — only replaces the matched section):
=== EDIT: path/to/file ===
<<<< SEARCH
exact existing lines to find
====
replacement lines
>>>> REPLACE
To create a new file (or fully replace a small one <80 lines) use:
=== WRITE: path/to/file ===
full file content here`

  if (mentioned.length) {
    if (!injected.length) return prompt
    return `${injected.join('\n\n')}\n\n---\n\nTASK:\n${prompt}\n\n${editInstructions}`
  }

  return `${autoProjectContext(cwd, agent)}\n\n---\n\nTASK:\n${prompt}\n\n${editInstructions}`
}

function stripOuterFence(output) {
  const text = String(output || '').trim()
  const match = text.match(/^```(?:[\w.-]+)?\n([\s\S]*?)\n```$/)
  return match ? match[1].trim() : text
}

function looksLikeFileContent(output) {
  const text = stripOuterFence(output)
  if (!text) return false
  if (/^(sure|here(?:'s| is)|below is|the modified|i (?:can|will|have)\b|of course)\b/i.test(text)) return false
  return /[{};<>]/.test(text) ||
    /^(import|export|const|let|var|function|class|def |from |#!|#{1,6}\s|[A-Z][A-Z0-9_]*=|<!doctype|<html|{\s*["[])/i.test(text)
}

const REST_PROVIDERS = new Set(['ollama', 'deepseek', 'groq'])
const MAX_WRITE_LINES = 150 // Full WRITE blocks for REST providers capped at this size

// Safe diff-based edits: find exact SEARCH text, replace with REPLACE text.
// No line-count limit — targeted edits can't truncate a file.
function applyFileEdits(output, cwd, provider = 'claude') {
  if (!cwd) return false
  const editPattern = /=== EDIT: ([\w./.\\-]+) ===\s*\n<<<< SEARCH\n([\s\S]*?)\n====\n([\s\S]*?)\n>>>> REPLACE/g
  let matched = false
  for (const m of output.matchAll(editPattern)) {
    const relPath = m[1].trim()
    const search  = m[2]
    const replace = m[3]
    const filePath = projectFilePath(cwd, relPath)
    if (!filePath) { console.warn(`[file-edit] rejected path: ${relPath}`); continue }
    let original
    try { original = fs.readFileSync(filePath, 'utf8') } catch {
      console.warn(`[file-edit] file not found: ${filePath}`); continue
    }
    if (!original.includes(search)) {
      console.warn(`[file-edit] SEARCH block not found in ${relPath} — edit skipped (safe)`)
      continue
    }
    const updated = original.replace(search, replace)
    fs.writeFileSync(filePath, updated, 'utf8')
    console.log(`[file-edit] patched ${relPath} (provider=${provider})`)
    matched = true
  }
  return matched
}

function applyFileWrites(output, cwd, prompt = '', provider = 'claude') {
  if (!cwd) return false
  const isRestProvider = REST_PROVIDERS.has(provider)
  // Apply safe EDIT blocks first (no size limit — search/replace can't truncate)
  const editMatched = applyFileEdits(output, cwd, provider)
  const writePattern = /=== WRITE: ([\w./.\\-]+) ===\n([\s\S]*?)(?==== WRITE:|=== EDIT:|$)/g
  let matched = editMatched
  for (const m of output.matchAll(writePattern)) {
    const content = stripOuterFence(m[2])
    const lineCount = content.split('\n').length
    if (isRestProvider && lineCount > MAX_WRITE_LINES) {
      console.warn(`[file-inject] blocked WRITE to ${m[1]}: ${lineCount} lines exceeds REST limit of ${MAX_WRITE_LINES}. Use EDIT blocks for large files.`)
      continue
    }
    const filePath = projectFilePath(cwd, m[1])
    if (!filePath) continue
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content, 'utf8')
    console.log(`[file-inject] wrote ${m[1]} (${lineCount} lines, provider=${provider})`)
    matched = true
  }
  // Auto-inference write-back disabled: too risky — REST providers return partial files
  // and overwrite everything. Only explicit === WRITE: === or === EDIT: === markers honoured.
  return matched
}

const PORT        = Number(pick('ACC_PORT', 'port', 3333))
const MEMORY_ROOT = pick('ACC_MEMORY_ROOT', 'memoryRoot',
  'C:\\Users\\nirke\\OneDrive\\Documents\\Obsidian\\Lachy\\agent-memory')
const OBSIDIAN_ROOT = path.dirname(MEMORY_ROOT)
const BUSINESS_DIR = path.join(OBSIDIAN_ROOT, 'business')
const GOALS_FILE = path.join(BUSINESS_DIR, 'goals.md')
const JARVIS_MEMORY_DIR = path.join(MEMORY_ROOT, 'jarvis')
const AGENT_CLI_PATH = path.join(__dir, 'agent-cli.mjs')
const ACC_SECRET  = pick('ACC_SECRET', 'secret', null) || null
const ACC_TOKEN   = pick('ACC_TOKEN', 'token', ACC_SECRET) || null
const AUTH_TOKENS = new Set([ACC_SECRET, ACC_TOKEN].map(v => String(v || '').trim()).filter(Boolean))
// Default parent directory for agents scaffolded via POST /new-agent.
const NEW_AGENT_BASE = pick('ACC_NEW_AGENT_BASE', 'newAgentBase',
  'C:\\Users\\nirke\\OneDrive\\Documents\\Lachys Web Dev')
// Website form webhook: optional shared key (?key=) to stop random internet POSTs
// from triggering agent runs, and which provider triages each lead.
const FORM_KEY = pick('ACC_FORM_KEY', 'formKey', null) || null
const LEAD_PROVIDER    = pick('ACC_LEAD_PROVIDER', 'leadProvider', 'claude') // claude can also write money-log.md
// Manager provider: set ACC_MANAGER_PROVIDER=ollama to run manager ticks locally (free, always on).
// Falls back to 'claude' if unset. Set to 'deepseek' for cheap API manager ticks.
const MANAGER_PROVIDER = pick('ACC_MANAGER_PROVIDER', 'managerProvider', 'claude')

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

// Gemini CLI — free API access via the gemini CLI tool. Not typically in the
// global npm bin on this machine, so we fall back to npx @google/gemini-cli.
// Override with ACC_GEMINI_EXE or config.json "geminiExe".
function findGemini() {
  const override = process.env.ACC_GEMINI_EXE ?? fileCfg.geminiExe
  if (override) { console.log(`  gemini  →  ${override} (override)`); return override }
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'gemini.cmd'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'gemini'),
  ]
  for (const c of candidates) { if (fs.existsSync(c)) { console.log(`  gemini  →  ${c}`); return c } }
  console.log('  gemini  →  npx @google/gemini-cli (not globally installed)')
  return null // signals to use npx at runtime
}
const GEMINI_EXE   = findGemini()
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.ACC_GEMINI_API_KEY ?? fileCfg.geminiApiKey ?? null
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? process.env.ACC_GEMINI_MODEL ?? fileCfg.geminiModel ?? 'gemini-2.0-flash'

// Ollama — local model runner. Free, private, uses the local GPU (3060).
const OLLAMA_BASE_URL   = process.env.ACC_OLLAMA_BASE_URL  ?? fileCfg.ollamaBaseUrl  ?? 'http://localhost:11434'
const OLLAMA_MODEL      = process.env.ACC_OLLAMA_MODEL     ?? fileCfg.ollamaModel    ?? 'qwen3:8b'
const OLLAMA_KEEP_ALIVE = process.env.ACC_OLLAMA_KEEP_ALIVE ?? fileCfg.ollamaKeepAlive ?? '5m'
const OLLAMA_TIMEOUT_MS = Number(process.env.ACC_OLLAMA_TIMEOUT_MS ?? fileCfg.ollamaTimeoutMs ?? 120000)

// DeepSeek — OpenAI-compatible REST API. Cheap paid coding model by default.
const DEEPSEEK_API_KEY    = process.env.ACC_DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? fileCfg.deepseekApiKey ?? null
const DEEPSEEK_BASE_URL   = process.env.ACC_DEEPSEEK_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? fileCfg.deepseekBaseUrl ?? 'https://api.deepseek.com'
const DEEPSEEK_MODEL      = process.env.ACC_DEEPSEEK_MODEL ?? process.env.DEEPSEEK_MODEL ?? fileCfg.deepseekModel ?? 'deepseek-chat'
const DEEPSEEK_TIMEOUT_MS = Number(process.env.ACC_DEEPSEEK_TIMEOUT_MS ?? fileCfg.deepseekTimeoutMs ?? 60000)

// Groq — OpenAI-compatible REST API. Free-tier, low-latency worker provider.
const GROQ_API_KEY    = process.env.ACC_GROQ_API_KEY ?? process.env.GROQ_API_KEY ?? fileCfg.groqApiKey ?? null
const GROQ_BASE_URL   = process.env.ACC_GROQ_BASE_URL ?? process.env.GROQ_BASE_URL ?? fileCfg.groqBaseUrl ?? 'https://api.groq.com/openai/v1'
const GROQ_MODEL      = process.env.ACC_GROQ_MODEL ?? process.env.GROQ_MODEL ?? fileCfg.groqModel ?? 'llama-3.3-70b-versatile'
const GROQ_TIMEOUT_MS = Number(process.env.ACC_GROQ_TIMEOUT_MS ?? fileCfg.groqTimeoutMs ?? 30000)

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

function readBriefingFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8').trimEnd()
    return content || '(empty file)'
  } catch (e) {
    return `(Unable to read ${filePath}: ${e.message})`
  }
}

function lastLines(content, count) {
  return String(content || '').split(/\r?\n/).slice(-count).join('\n').trimEnd() || '(empty file)'
}

function agentCwd(name) {
  return AGENT_DIRS[name] || path.join(MEMORY_ROOT, name)
}

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json())
app.use((_, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next() })

// Optional bearer-token auth. When neither ACC_SECRET nor ACC_TOKEN is set the
// server is wide open (intended for localhost-only use). When either is set,
// API routes require one of the configured tokens via:
//   Authorization: Bearer <token>   or   X-ACC-Token: <token>   or   ?token=<token>
function authOk(req) {
  if (!AUTH_TOKENS.size) return true
  const header = req.get('authorization') || ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null
  const tokens = [bearer, req.get('x-acc-token'), req.query.token]
    .map(v => String(v || '').trim())
    .filter(Boolean)
  return tokens.some(token => AUTH_TOKENS.has(token))
}
const requireAuth = (req, res, next) =>
  authOk(req) ? next() : res.status(401).json({ error: 'Unauthorized - token required' })

// Serve ONLY the UI page (not the whole directory) so source, package.json, and
// config.json - which may hold secrets - are never downloadable. The page stays
// open so the UI can load and prompt for a token; API routes below require auth.
app.get(['/', '/index.html'], (_, res) => res.sendFile(path.join(__dir, 'index.html')))
app.get('/status', requireAuth, (_, res) =>
  res.json({ ok: true, time: new Date().toISOString(), authRequired: AUTH_TOKENS.size > 0 }))

// POST /webhook/form — public endpoint for website form submissions (e.g. Netlify
// form notifications). External sites can use ACC_FORM_KEY; internal callers can
// use the normal ACC token. Drops a message into the Discord #leads channel via
// the ops queue. Handles Netlify's { payload: { data, form_name, site_url } }
// shape and plain JSON.
app.post('/webhook/form', (req, res) => {
  try {
    // If a key is configured, accept it for website posts. Otherwise fall back
    // to ACC auth when configured. Without either, local zero-config remains open
    // but triage stays off unless explicitly enabled.
    if (FORM_KEY && req.query.key !== FORM_KEY && !authOk(req)) return res.status(401).json({ error: 'bad or missing key/token' })
    if (!FORM_KEY && !authOk(req)) return res.status(401).json({ error: 'Unauthorized - token required' })
    const p = req.body?.payload || req.body || {}
    const data = p.data || p
    const formName = p.form_name || data._form || data._formName || 'form'
    const site = p.site_url || data._site || req.query.site || ''
    const skip = new Set(['_form', '_formName', '_site', 'form-name', 'bot-field', 'g-recaptcha-response'])
    const fields = Object.entries(data).filter(([k, v]) => !skip.has(k) && typeof v !== 'object' && String(v).trim())
    const lines = fields.map(([k, v]) => `**${k}:** ${String(v).slice(0, 300)}`)

    // 1) Notify #leads (always).
    const list = loadOps()
    list.push({ id: `o${++opSeq}`, op: 'say', channel: 'leads', text: `📥 **New form submission** — ${formName}${site ? ` (${site})` : ''}\n${lines.join('\n') || '(no fields)'}`.slice(0, 1900), ensure: true, createdAt: Date.now() })
    saveOps(list)

    // 2) Auto-triage via Jarvis — safe to spawn only when keyed, or explicitly enabled.
    const triageOn = FORM_KEY ? true : (pick('ACC_LEAD_TRIAGE', 'leadTriage', '0') === '1')
    if (triageOn) {
      const prompt = `A new website lead just arrived via the "${formName}" form${site ? ` on ${site}` : ''}:\n\n${lines.join('\n')}\n\nTriage this lead: (1) add a row to the pipeline table in business/money-log.md, (2) draft a short, friendly reply email Lachy can send, (3) give a one-line recommended next step (and a good time to follow up). Be concise.`
      const prov = normalizeProvider(LEAD_PROVIDER)
      const run = newRun({ agent: 'jarvis', prompt: `[lead] ${formName}`, source: 'lead', provider: prov, model: prov === 'claude' ? 'haiku' : null })
      dispatchRun({ run, cwd: agentCwd('jarvis'), prompt, fullPrompt: prompt, continueSession: false, model: run.model, delegate: false }) // fire-and-forget
    }
    res.json({ ok: true, triaged: triageOn })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

// Everything below requires auth (no-op when no ACC token is configured).
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
const CORE_OVERRIDES = new Set(['liftoff', 'muja-products', 'etsy-agent', 'marketing-agent'])
function agentGroup(dir, name) {
  if (!dir) return 'core'
  if (name && CORE_OVERRIDES.has(name)) return 'core'
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
    group: (name in AGENT_DIRS) ? agentGroup(AGENT_DIRS[name], name) : 'core',
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

// Business files (goals + money log) live next to the memory root.
app.get('/business/:file', (req, res) => {
  const allowed = { goals: 'goals.md', money: 'money-log.md' }
  const name = allowed[req.params.file]
  if (!name) return res.status(404).json({ error: 'unknown file' })
  try { res.json({ file: name, content: fs.readFileSync(path.join(BUSINESS_DIR, name), 'utf8') }) }
  catch { res.json({ file: name, content: '' }) }
})
// Append a captured note to goals.md (so Lachy/Jarvis can quick-add a goal).
app.post('/business/goals/append', (req, res) => {
  const note = (req.body?.note || '').toString().trim()
  if (!note) return res.status(400).json({ error: 'note required' })
  try {
    fs.mkdirSync(BUSINESS_DIR, { recursive: true })
    const p = path.join(BUSINESS_DIR, 'goals.md')
    const stamp = new Date().toISOString().slice(0, 10)
    fs.appendFileSync(p, `\n- [ ] (${stamp}) ${note}`)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
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
    `  node "${cli}" run <agent> "<prompt>" [--model haiku|sonnet|opus] [--codex] [--gemini] [--ollama] [--deepseek] [--groq]   # one sub-agent, returns its output`,
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

const VALID_PROVIDERS = new Set(['claude', 'codex', 'gemini', 'ollama', 'deepseek', 'groq'])
const PROVIDER_LIST = [...VALID_PROVIDERS].join(', ')

function normalizeProvider(p) {
  const raw = String(p ?? '').trim()
  if (!raw) return 'claude'
  const provider = raw.toLowerCase()
  if (VALID_PROVIDERS.has(provider)) return provider
  const err = new Error(`unknown provider "${raw}". Valid providers: ${PROVIDER_LIST}`)
  err.status = 400
  throw err
}

function providerError(res, err) {
  return res.status(err.status || 400).json({ error: err.message })
}

// ── Run registry ────────────────────────────────────────────────────────────
// Every spawn (dashboard, agent-to-agent dispatch, swarm) is tracked here so the
// dashboard/Discord can show a live count, cost, and parent/child relationships.
let runSeq = 0
const runs = new Map() // id -> run
const btwQueue = [] // { message, queuedAt }
// Gaming mode: when true, Ollama is skipped (GPU reserved for games) and tasks fall back to non-local providers.
let gamingMode = false
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
    status: 'running', startedAt: Date.now(), endedAt: null, finishedAt: null,
    cost: 0, usage: null, durationMs: null, numTurns: null, exitCode: null,
    codexTokens: 0, providerTokens: 0, output: '', pid: null, needsAction: '', _proc: null,
  }
  runs.set(id, run)
  if (runs.size > MAX_RUNS) {
    const finished = [...runs.values()].filter(r => r.endedAt).sort((a, b) => a.endedAt - b.endedAt)
    while (runs.size > MAX_RUNS && finished.length) runs.delete(finished.shift().id)
  }
  return run
}
function finishRun(run, patch) {
  if (run.status === 'cancelled' && patch.status !== 'cancelled') {
    if (run.exitCode == null && patch.exitCode != null) run.exitCode = patch.exitCode
    if (run.durationMs == null && patch.durationMs != null) run.durationMs = patch.durationMs
    if (!run.output && patch.output) run.output = patch.output
    run.endedAt = run.endedAt || run.finishedAt || Date.now()
    run.finishedAt = run.finishedAt || run.endedAt
    run._proc = null
    return
  }
  Object.assign(run, patch)
  run.endedAt = Date.now()
  run.finishedAt = run.endedAt
  run._proc = null
}
function isActive(r) { return r.status === 'running' || r.status === 'waiting' }
function publicRun(r) {
  const { _proc, _cwd, ...rest } = r
  return rest
}
function cancelRun(run) {
  if (run._proc) {
    try { run._proc.kill('SIGTERM') } catch {}
  }
  const now = Date.now()
  run.status = 'cancelled'
  run.finishedAt = now
  run.endedAt = now
  run.durationMs = run.durationMs ?? (now - run.startedAt)
  run.exitCode = run.exitCode ?? -1
  run._proc = null
  return { ok: true, id: run.id, agent: run.agent }
}
function stopRunProcess(run) {
  const proc = run?._proc
  const pid = run?.pid || proc?.pid
  if (!proc && !pid) return

  if (process.platform === 'win32' && pid) {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => { try { proc?.kill() } catch {} })
      return
    } catch {}
  }

  try { proc?.kill() } catch {}
}
function compactStderr(stderr, code) {
  const text = String(stderr || '').trim()
  if (!text || code === 0) return ''
  const lines = text.split(/\r?\n/).filter(line =>
    !/^[-]{3,}$/.test(line.trim()) &&
    !/^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id):/i.test(line.trim()) &&
    !/^OpenAI Codex v/i.test(line.trim()) &&
    !/^(user|codex|exec|tokens used)$/i.test(line.trim())
  )
  const compact = (lines.join('\n').trim() || text).slice(-1600)
  return compact.length < text.length ? `[stderr tail]\n${compact}` : compact
}

function childRunEnv(run, extra = {}) {
  const env = { ...process.env, ACC_PARENT: run.id, ACC_URL: `http://localhost:${PORT}`, ...extra }
  if (ACC_TOKEN) env.ACC_TOKEN = ACC_TOKEN
  return env
}

// Spawns claude, parses the stream-json output, updates the run, and streams text
// deltas via onText. Resolves with the full result once the process closes.
function runClaude({ run, args, cwd, onText }) {
  return new Promise(resolve => {
    // Pass the run id + server URL down so any agent that delegates via
    // agent-cli.mjs tags its sub-runs with this run as their parent.
    const env = childRunEnv(run)
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
// own project directory. Use ACC_CODEX_SANDBOX=danger-full-access to match the
// Claude runner's broad local authority for trusted automation.
const CODEX_SANDBOX = codexSandbox(pick('ACC_CODEX_SANDBOX', 'codexSandbox', 'workspace-write'))
const CODEX_DANGER = CODEX_SANDBOX === 'danger-full-access'
const CODEX_DISK_FULL_READ = asBool(
  pick('ACC_CODEX_DISK_FULL_READ', 'codexDiskFullRead', true),
  true,
)
const CODEX_ADD_DIRS = existingDirs([
  MEMORY_ROOT,
  path.join(os.homedir(), '.codex', 'memories'),
  ...asList(pick('ACC_CODEX_ADD_DIRS', 'codexAddDirs', [])),
])
console.log(`  codex sandbox -> ${CODEX_SANDBOX}${!CODEX_DANGER && CODEX_DISK_FULL_READ ? ' + disk-full-read' : ''}`)
if (!CODEX_DANGER && CODEX_ADD_DIRS.length) console.log(`  codex add-dir -> ${CODEX_ADD_DIRS.join('; ')}`)

// Runs a prompt through the OpenAI Codex CLI (codex exec). Prompt is fed via
// stdin (avoids all shell-quoting issues); the final message is captured via -o.
// Codex bills against the ChatGPT/Codex plan, not Claude — so cost is tracked as
// token count (codexTokens), not USD.
function runCodex({ run, prompt, model, cwd, onText }) {
  return new Promise(resolve => {
    const outFile = path.join(os.tmpdir(), `codex-${run.id}-${Date.now()}.txt`)
    const args = ['exec', '--skip-git-repo-check', '--sandbox', CODEX_SANDBOX]
    if (!CODEX_DANGER) {
      if (CODEX_DISK_FULL_READ) args.push('-c', "sandbox_permissions=['disk-full-read-access']")
      for (const dir of CODEX_ADD_DIRS) args.push('--add-dir', dir)
    }
    args.push('-C', cwd, '-o', outFile)
    if (model && /^[\w.:-]+$/.test(model)) args.push('-m', model)
    args.push('-') // read prompt from stdin
    const cmd = [CODEX_EXE, ...args].map(cmdQuote).join(' ')
    const env = childRunEnv(run)
    // shell:true because codex is a .cmd on Windows. Prompt goes via stdin and
    // optional model names are pattern-checked before being placed on the command line.
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
      if (!out && code !== 0) out = (stderr || stdout).trim()
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

// Runs a prompt through the Gemini CLI in headless mode. Prompt is fed via stdin;
// -p " " triggers non-interactive mode without adding meaningful content to the prompt.
// Falls back to npx @google/gemini-cli if gemini is not globally installed.
// Cost is always 0 (free tier) — tracked by run count, not USD.
function runGemini({ run, prompt, model, cwd, onText }) {
  return new Promise(resolve => {
    const geminiModel = model || GEMINI_MODEL
    const exeBase = GEMINI_EXE ? cmdQuote(GEMINI_EXE) : 'npx @google/gemini-cli'
    // -p " " enables headless (non-interactive) mode; the actual prompt arrives via stdin.
    const cmd = `${exeBase} -p " " --yolo --skip-trust -o text${geminiModel ? ` -m ${cmdQuote(geminiModel)}` : ''}`
    const env = childRunEnv(run, { GEMINI_CLI_TRUST_WORKSPACE: 'true', ...(GEMINI_API_KEY ? { GEMINI_API_KEY } : {}) })
    const proc = spawn(cmd, { cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'], env })
    run.pid = proc.pid; run._proc = proc
    console.log(`[run ${run.id}] gemini PID ${proc.pid} agent=${run.agent} src=${run.source}${geminiModel ? ` model=${geminiModel}` : ''}`)
    proc.stdin.write(prompt); proc.stdin.end()

    let stdout = '', stderr = ''
    proc.stdout.on('data', d => { stdout += d.toString() })
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('close', code => {
      const out = stdout.trim() || (code !== 0 ? stderr.trim() : '')
      onText?.(out)
      finishRun(run, { status: code === 0 ? 'done' : 'error', exitCode: code, cost: 0, output: out.slice(0, 6000) })
      console.log(`[run ${run.id}] gemini close code=${code}`)
      resolve({ text: out, cost: 0, code, stderr })
    })
    proc.on('error', err => {
      const hint = 'Install Gemini CLI: npm i -g @google/gemini-cli'
      finishRun(run, { status: 'error', exitCode: -1 })
      resolve({ text: '', cost: 0, code: -1, stderr: `${hint}\n${err.message}` })
    })
  })
}

// Ollama — calls the local REST API. think:false disables extended reasoning mode
// (qwen3 thinking mode is slow; fine for chats but wasteful for quick agent tasks).
async function runOllama({ run, prompt, sourcePrompt = prompt, model, onText }) {
  if (gamingMode) {
    const msg = '⚠️ Gaming mode is ON — Ollama skipped to free the GPU. Falling back is the caller\'s responsibility.'
    finishRun(run, { status: 'error', exitCode: -1, output: msg })
    return { text: '', cost: 0, code: -1, stderr: msg }
  }
  const m = model || OLLAMA_MODEL
  const enrichedPrompt = injectFiles(prompt, run._cwd || null, sourcePrompt, run.agent)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS)
  console.log(`[run ${run.id}] ollama model=${m} agent=${run.agent}`)
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: m,
        messages: [
          { role: 'system', content: CODE_EDITOR_SYSTEM_PROMPT },
          { role: 'user', content: enrichedPrompt },
        ],
        stream: false,
        think: false,
        keep_alive: OLLAMA_KEEP_ALIVE
      }),
      signal: controller.signal
    })
    if (!res.ok) {
      const err = `Ollama HTTP ${res.status}: ${await res.text()}`
      finishRun(run, { status: 'error', exitCode: res.status, output: err })
      return { text: '', cost: 0, code: res.status, stderr: err }
    }
    const json = await res.json()
    const text = json.message?.content || json.response || ''
    applyFileWrites(text, run._cwd, sourcePrompt, 'ollama')
    onText?.(text)
    finishRun(run, { status: 'done', exitCode: 0, cost: 0, output: text.slice(0, 6000) })
    console.log(`[run ${run.id}] ollama done tokens=${json.eval_count ?? '?'}`)
    return { text, cost: 0, code: 0, stderr: '' }
  } catch (err) {
    const msg = err.name === 'AbortError' ? `Ollama timed out after ${OLLAMA_TIMEOUT_MS}ms` : err.message
    finishRun(run, { status: 'error', exitCode: -1, output: msg })
    return { text: '', cost: 0, code: -1, stderr: msg }
  } finally {
    clearTimeout(timeout)
  }
}

async function runOpenAICompatibleChat({ run, prompt, sourcePrompt = prompt, model, onText, providerName, apiKey, apiKeyHint, baseUrl, timeoutMs, paid }) {
  if (!apiKey) {
    const msg = `${providerName} API key missing. Set ${apiKeyHint}.`
    finishRun(run, { status: 'error', exitCode: -1, output: msg, providerTokens: 0 })
    return { text: msg, cost: 0, code: -1, stderr: msg }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`
  console.log(`[run ${run.id}] ${providerName.toLowerCase()} model=${model} agent=${run.agent}`)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: CODE_EDITOR_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        stream: false,
      }),
      signal: controller.signal,
    })
    const raw = await res.text()
    let json = {}
    try { json = raw ? JSON.parse(raw) : {} } catch {}
    if (!res.ok) {
      const err = `${providerName} HTTP ${res.status}: ${json?.error?.message || raw || res.statusText}`
      finishRun(run, { status: 'error', exitCode: res.status, output: err, durationMs: Date.now() - started })
      return { text: err, cost: 0, code: res.status, stderr: err }
    }

    const text = json.choices?.[0]?.message?.content
    if (typeof text !== 'string') {
      const err = `${providerName} response missing choices[0].message.content`
      finishRun(run, { status: 'error', exitCode: -1, output: err, durationMs: Date.now() - started })
      return { text: err, cost: 0, code: -1, stderr: err }
    }

    const usage = json.usage || null
    const promptTokens = Number(usage?.prompt_tokens || 0)
    const completionTokens = Number(usage?.completion_tokens || 0)
    const providerTokens = promptTokens + completionTokens || Number(usage?.total_tokens || 0)
    applyFileWrites(text, run._cwd, sourcePrompt, run.provider || 'claude')
    onText?.(text)
    finishRun(run, {
      status: 'done', exitCode: 0, cost: 0, usage, providerTokens,
      durationMs: Date.now() - started, output: text.slice(0, 6000),
    })
    console.log(`[run ${run.id}] ${providerName.toLowerCase()} done tokens=${providerTokens} prompt=${promptTokens || '?'} completion=${completionTokens || '?'} cost=${paid ? 'paid' : 'free'}`)
    return { text, cost: 0, code: 0, stderr: '', usage, providerTokens }
  } catch (err) {
    const msg = err.name === 'AbortError' ? `${providerName} timed out after ${timeoutMs}ms` : err.message
    finishRun(run, { status: 'error', exitCode: -1, output: msg, durationMs: Date.now() - started })
    return { text: msg, cost: 0, code: -1, stderr: msg }
  } finally {
    clearTimeout(timeout)
  }
}

function runDeepSeek({ run, prompt, sourcePrompt = prompt, model, onText }) {
  const enrichedPrompt = injectFiles(prompt, run._cwd || null, sourcePrompt, run.agent)
  return runOpenAICompatibleChat({
    run, prompt: enrichedPrompt, sourcePrompt, model: model || DEEPSEEK_MODEL, onText,
    providerName: 'DeepSeek',
    apiKey: DEEPSEEK_API_KEY,
    apiKeyHint: 'ACC_DEEPSEEK_API_KEY, DEEPSEEK_API_KEY, or config.json deepseekApiKey',
    baseUrl: DEEPSEEK_BASE_URL,
    timeoutMs: DEEPSEEK_TIMEOUT_MS,
    paid: true,
  })
}

function runGroq({ run, prompt, sourcePrompt = prompt, model, onText }) {
  const enrichedPrompt = injectFiles(prompt, run._cwd || null, sourcePrompt, run.agent)
  return runOpenAICompatibleChat({
    run, prompt: enrichedPrompt, sourcePrompt, model: model || GROQ_MODEL, onText,
    providerName: 'Groq',
    apiKey: GROQ_API_KEY,
    apiKeyHint: 'ACC_GROQ_API_KEY, GROQ_API_KEY, or config.json groqApiKey',
    baseUrl: GROQ_BASE_URL,
    timeoutMs: GROQ_TIMEOUT_MS,
    paid: false,
  })
}

function nonClaudeProviderModel(model, fallback = null) {
  const m = String(model || '').trim()
  if (!m || VALID_MODELS.includes(m) || /^claude-/i.test(m)) return fallback
  return m
}

// Single entry point: picks Claude, Codex, Gemini, Ollama, DeepSeek, or Groq based on run.provider.
function dispatchRun({ run, cwd, prompt, fullPrompt, continueSession, model, effort, delegate, onText }) {
  if (run.provider === 'codex') {
    // Codex (ChatGPT account) rejects Claude model names (opus/sonnet/haiku);
    // only forward a genuine Codex model, else let Codex use its default.
    const codexModel = nonClaudeProviderModel(model)
    run.model = codexModel
    return runCodex({ run, prompt: fullPrompt ?? prompt, model: codexModel, cwd, onText })
  }
  if (run.provider === 'gemini') {
    // Gemini rejects Claude model names; only forward a model that looks like a Gemini model.
    const geminiModel = nonClaudeProviderModel(model)
    run.model = geminiModel || GEMINI_MODEL
    return runGemini({ run, prompt: fullPrompt ?? prompt, model: run.model, cwd, onText })
  }
  if (run.provider === 'ollama') {
    const ollamaModel = nonClaudeProviderModel(model, OLLAMA_MODEL)
    run.model = ollamaModel
    run._cwd = cwd
    return runOllama({ run, prompt: fullPrompt ?? prompt, sourcePrompt: prompt, model: ollamaModel, onText })
  }
  if (run.provider === 'deepseek') {
    const deepseekModel = nonClaudeProviderModel(model, DEEPSEEK_MODEL)
    run.model = deepseekModel
    run._cwd = cwd
    return runDeepSeek({ run, prompt: fullPrompt ?? prompt, sourcePrompt: prompt, model: deepseekModel, onText })
  }
  if (run.provider === 'groq') {
    const groqModel = nonClaudeProviderModel(model, GROQ_MODEL)
    run.model = groqModel
    run._cwd = cwd
    return runGroq({ run, prompt: fullPrompt ?? prompt, sourcePrompt: prompt, model: groqModel, onText })
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
  let runProvider
  try { runProvider = normalizeProvider(provider) } catch (err) { return providerError(res, err) }

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
  const heartbeat = setInterval(() => sse({ heartbeat: Date.now() }), 25000)
  heartbeat.unref?.()

  const run = newRun({ agent, prompt, model, effort, source: 'dashboard', provider: runProvider })
  sse({ runId: run.id, provider: run.provider })

  res.on('close', () => {
    clearInterval(heartbeat)
    if (isActive(run)) { stopRunProcess(run); finishRun(run, { status: 'error', exitCode: -1 }) }
  })

  // Allow subtasking on top-level runs by default (opt out with delegate:false).
  const r = await dispatchRun({ run, cwd, prompt, fullPrompt, continueSession, model, effort, delegate: delegate !== false, onText: t => sse({ text: t }) })
  clearInterval(heartbeat)
  const err = compactStderr(r.stderr, r.code)
  if (err) sse({ error: err })
  sse({ done: true, code: run.exitCode ?? r.code, cost: r.cost, codexTokens: run.codexTokens, providerTokens: run.providerTokens, durationMs: run.durationMs, numTurns: run.numTurns, usage: run.usage })
  res.end()
})

// POST /run/latest/stop - cancel the most recent active run.
app.post('/run/latest/stop', (req, res) => {
  const run = [...runs.values()].reverse().find(r => r.status === 'running')
  if (!run) return res.status(404).json({ error: 'no active runs' })
  res.json(cancelRun(run))
})

// POST /run/:id/stop - cancel a specific active run.
app.post('/run/:id/stop', (req, res) => {
  const run = runs.get(req.params.id)
  if (!run) return res.status(404).json({ error: 'run not found' })
  if (!isActive(run)) return res.status(400).json({ error: 'run already finished', status: run.status })
  res.json(cancelRun(run))
})

// POST /btw - queue a message to inject into the next manager tick or follow-up run.
app.post('/btw', (req, res) => {
  const message = req.body?.message
  if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'message required' })
  btwQueue.push({ message: message.trim(), queuedAt: Date.now() })
  res.json({ ok: true, queued: btwQueue.length })
})

// GET /btw - inspect queued messages without clearing them.
app.get('/btw', (_, res) => {
  res.json({ messages: btwQueue.map(e => e.message) })
})

// DELETE /btw - clear queued BTW messages.
app.delete('/btw', (_, res) => {
  const cleared = btwQueue.length
  btwQueue.length = 0
  res.json({ ok: true, cleared })
})

// POST /dispatch - synchronous single agent run (used for agent-to-agent calls).
// Returns JSON when the run finishes. Usually fresh; BTW follow-ups may continue.
app.post('/dispatch', async (req, res) => {
  const { agent, prompt, model, effort, parent, provider, continueSession = false } = req.body
  if (!agent || !prompt?.trim()) return res.status(400).json({ error: 'agent and prompt required' })
  if (!(agent in AGENT_DIRS) && !fs.existsSync(agentCwd(agent)))
    return res.status(404).json({ error: `unknown agent: ${agent}` })
  let runProvider
  try { runProvider = normalizeProvider(provider) } catch (err) { return providerError(res, err) }

  const cwd = agentCwd(agent)
  const run = newRun({ agent, prompt, model, effort, parent: parent || null, source: 'agent', provider: runProvider })
  const r = await dispatchRun({ run, cwd, prompt, fullPrompt: prompt, continueSession, model, effort, delegate: false })
  res.json({ runId: run.id, agent, provider: run.provider, output: r.text, cost: r.cost, codexTokens: run.codexTokens, providerTokens: run.providerTokens, exitCode: run.exitCode ?? r.code, durationMs: run.durationMs })
})

// POST /swarm — run many agents in parallel. tasks: [{agent,prompt,model,effort,provider}]
app.post('/swarm', async (req, res) => {
  const { tasks, parent } = req.body
  if (!Array.isArray(tasks) || !tasks.length) return res.status(400).json({ error: 'tasks array required' })
  if (tasks.length > 12) return res.status(400).json({ error: 'too many tasks (max 12)' })
  let normalizedTasks
  try {
    normalizedTasks = tasks.map(t => ({ ...t, provider: normalizeProvider(t?.provider) }))
  } catch (err) { return providerError(res, err) }

  const results = await Promise.all(normalizedTasks.map(async t => {
    if (!t?.agent || !t?.prompt?.trim()) return { agent: t?.agent || '(none)', output: '', cost: 0, exitCode: -1, error: 'agent and prompt required' }
    const cwd = agentCwd(t.agent)
    const run = newRun({ agent: t.agent, prompt: t.prompt, model: t.model, effort: t.effort, parent: parent || 'swarm', source: 'swarm', provider: t.provider })
    const r = await dispatchRun({ run, cwd, prompt: t.prompt, fullPrompt: t.prompt, continueSession: false, model: t.model, effort: t.effort, delegate: false })
    return { runId: run.id, agent: t.agent, provider: run.provider, output: r.text, cost: r.cost, providerTokens: run.providerTokens, exitCode: r.code }
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

function providerTokensToday(provider) {
  const today = new Date().toDateString()
  return [...runs.values()].filter(r => r.provider === provider && new Date(r.startedAt).toDateString() === today)
    .reduce((s, r) => s + (r.providerTokens || 0), 0)
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
  if (u && u.status === 'rejected') return 'blocked'
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
    deepseekTokensToday: providerTokensToday('deepseek'),
    groqTokensToday: providerTokensToday('groq'),
    gamingMode,
  })
})

// POST /gaming — toggle gaming mode (disables Ollama so the GPU is fully free).
app.post('/gaming', (req, res) => {
  const on = req.body?.on
  gamingMode = typeof on === 'boolean' ? on : !gamingMode
  console.log(`[gaming] mode ${gamingMode ? 'ON' : 'OFF'}`)
  res.json({ gamingMode })
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
async function buildManagerBriefing(state = claudeState()) {
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
  const deepseekTok = providerTokensToday('deepseek')
  const groqTok = providerTokensToday('groq')
  // state: 'ok' | 'warning' | 'blocked'
  const jlog = latestLog('jarvis')
  const goalsContent = readBriefingFile(GOALS_FILE)
  const jarvisMemoryPath = jlog ? path.join(JARVIS_MEMORY_DIR, jlog.file) : path.join(JARVIS_MEMORY_DIR, 'YYYY-MM-DD.md')
  const jarvisMemoryContent = jlog ? lastLines(jlog.content, 150) : `(No Jarvis memory log found in ${JARVIS_MEMORY_DIR})`
  const jarvisMemoryTemplate = path.join(JARVIS_MEMORY_DIR, 'YYYY-MM-DD.md')

  let b = `[Jarvis manager tick — ${new Date().toLocaleString()}]\n\n`
  b += `You are running autonomously as Lachy's manager (he's "out and about" — act, don't ask). You have standing authority to delegate via agent-cli.mjs across SIX providers: Claude (\`--model\`), Codex (\`--codex\`), Gemini (\`--gemini\`), Ollama (\`--ollama\`), DeepSeek (\`--deepseek\`), and Groq (\`--groq\`).\n\n`
  b += `TOOLS:\n`
  b += `  - agent-cli full path: ${AGENT_CLI_PATH}\n`
  b += `  - Delegate one agent: node '${AGENT_CLI_PATH}' run <agent> '<prompt>' [--codex] [--gemini] [--groq] [--deepseek] [--ollama]\n`
  b += `  - For Claude delegation, omit provider flags or add \`--model haiku|sonnet|opus\` when needed.\n`
  b += `  - Post to #jarvis: node '${AGENT_CLI_PATH}' discord say jarvis '<message>'\n`
  b += `  - Obsidian root: ${OBSIDIAN_ROOT}\n`
  b += `  - Business goals file: ${GOALS_FILE}\n`
  b += `  - Agent memory root: ${MEMORY_ROOT}\n`
  b += `  - Jarvis memory directory: ${JARVIS_MEMORY_DIR}\n`
  b += `  - Jarvis memory log read/write path: ${jarvisMemoryTemplate}\n\n`
  b += `PROVIDER HIERARCHY (follow this unless overridden below):\n`
  b += `  🧠 Claude   — File access, real project knowledge, complex reasoning. Use for anything requiring reading actual files, real audits, substantive code changes, high-value decisions. Your own thinking always stays here.\n`
  b += `  🟢 Codex    — File access, runs in the project directory. Use for code tasks, file edits, audits, status checks, and anything needing real file context.\n`
  b += `  ♊ Gemini   — File access via CLI. Use for large-context analysis, second opinions on provided text or accessible project content, and documentation. Free until Jun 18 2026.\n`
  b += `  🦙 Ollama   — TEXT GENERATION ONLY. NO file access. NO project directory access. Will hallucinate if asked to review real projects. ONLY use for writing/drafting tasks where ALL needed context is explicitly included in the prompt.${gamingMode ? ' ⛔ GAMING MODE ON — Ollama is DISABLED (GPU reserved). Skip it entirely.' : ''}\n`
  b += `  ⚡ Groq     — TEXT GENERATION ONLY. NO file access. NO project directory access. Will hallucinate if asked to review real projects. ONLY use for writing/drafting tasks where ALL needed context is explicitly included in the prompt.\n`
  b += `  💙 DeepSeek — TEXT GENERATION ONLY. NO file access. NO project directory access. Will hallucinate if asked to review real projects. ONLY use for writing/drafting tasks where ALL needed context is explicitly included in the prompt.\n`
  b += `  Hard rule: Ollama/Groq/DeepSeek are REST API text generators. NEVER use them for audits, reviews, status checks, codebase inspection, real file/project questions, or anything requiring knowledge of real files.\n`
  b += `  When in doubt about whether a task needs file access, use Codex or Claude — never assume Groq/DeepSeek/Ollama can find the information themselves.\n\n`

  // Per-window Claude usage
  b += `CLAUDE USAGE:\n`
  const wins = Object.values(usageWindows)
  if (wins.length) {
    for (const w of wins) b += `  - ${w.rateLimitType}: ${w.utilization != null ? Math.round(w.utilization * 100) + '%' : w.status}${w.resetsAt ? ` (resets ${new Date(w.resetsAt * 1000).toLocaleTimeString()})` : ''}\n`
  } else b += `  - (no data yet)\n`
  b += `CODEX USAGE: ~${codexTok.toLocaleString()} tokens used today (separate ChatGPT/Codex plan). GROQ: ~${groqTok.toLocaleString()} tokens today (free tier; watch rate limits). DEEPSEEK: ~${deepseekTok.toLocaleString()} paid tokens today. GEMINI: free tier — use \`--gemini\` freely (free window closes Jun 18 2026).\n\n`

  b += `BUDGET POLICY — use non-Claude providers deliberately where they fit; use Codex/Gemini for file-aware work and Ollama/Groq/DeepSeek only for fully-contexted text generation. Use Claude capacity for tasks that need it (target ~${targetPct}% utilisation), keeping ~${100 - targetPct}% in reserve. NOTE: Claude only reports an exact % near the cap, so use this signal:\n`
  if (state === 'blocked') {
    b += `  Manager running on Codex fallback — Claude quota exhausted.\n`
    b += `  ⛔ Claude is RATE-LIMITED right now. Route file-aware worker tasks to Codex or Gemini; use Ollama/Groq/DeepSeek only for writing/drafting when the prompt contains all needed context.\n`
  } else if (state === 'warning') {
    b += `  ⚠️ Claude is NEAR the cap${utilPct != null ? ` (~${utilPct}%)` : ''}. Follow the provider hierarchy with extra discipline: Codex/Gemini for work needing files or CLI context; Ollama/Groq/DeepSeek only for fully-contexted text generation; reserve remaining Claude for orchestration and genuinely necessary complex work.\n`
  } else {
    b += `  ✅ Claude is GREEN (below the warning threshold — plenty of headroom). Follow the provider hierarchy strictly regardless: Codex/Gemini for file-aware work, Ollama/Groq/DeepSeek only for fully-contexted text generation, Claude only for complex multi-step work that genuinely needs it. Do not use Claude just because it is available. Delegate multiple to-dos in parallel this tick to make real progress with the right provider for each task.\n`
  }
  b += `  Prefer haiku for cheap sub-tasks. Reserve opus/sonnet for high-value work.\n`

  // Timing: his DAYTIME is Americas off-peak (cheap on the weekly limit) → go
  // hard. His NIGHT is Americas prime (burns the weekly limit) → keep light.
  const day = isDaytime()
  b += `\nTIME: ${new Date().toLocaleString()} — ${day ? `Lachy's DAYTIME (Americas off-peak — cheap on the weekly limit). GOOD time for heavy/bulk work: go hard now.` : `Lachy's NIGHT (Americas PRIME — burns the weekly limit fast). Keep this tick LIGHT; defer heavy/bulk delegation and \`schedule\` it for daytime (after ${DAY_START}:00).`}\n`

  // Month-start: trigger the big monthly planning + money report on the 1st.
  if (new Date().getDate() === 1) {
    b += `\n📅 IT'S THE 1ST — MONTH START. Do the big planning pass: roll \`${GOALS_FILE}\` forward (new revenue target + goals), review every project, set this month's venture experiments, and post a money + goals update to the #money channel via \`node '${AGENT_CLI_PATH}' discord say money '<message>'\`. This is a heavy tick — plan thoroughly.\n`
  }

  b += `\nOUTSTANDING (${todos.length}):\n` + (todos.length
    ? todos.map(t => `- ${t.blocked ? '[BLOCKED] ' : ''}${t.agent}: ${(t.flags || []).slice(0, 2).join(' · ') || 'blocked'}`).join('\n')
    : '- none')
  b += `\n\nAlso advance Lachy's standing goals (web-dev client growth, Etsy, profitability, his projects) per the injected goals file and your CLAUDE.md — not just blockers. Pick concrete actions, delegate them, and report crisply.`
  b += `\n\nPROACTIVE RESEARCH MANDATE: When there are no blocking tasks, do NOT sit idle. Pick ONE and execute it this tick: research a new income stream and write a brief to ${BUSINESS_DIR}; find 3 new web dev leads on Mornington Peninsula Facebook groups and draft outreach messages; research an AID Helpdesk competitor and write a comparison brief; investigate a new Etsy niche for demand vs competition; research an AI tool or API that could become a product; draft a cold email sequence for a business type Lachy has not targeted yet; look for automation opportunities in the current workflow. Save output to Obsidian under ${OBSIDIAN_ROOT}. Never end a tick with nothing done.`
  b += `\n\n--- Injected file: ${GOALS_FILE} (full content) ---\n${goalsContent}`
  b += `\n\n--- Injected file: ${jarvisMemoryPath} (last 150 lines) ---\n${jarvisMemoryContent}`
  b += `\n\nAt the END of your response, remind Lachy in BOLD to run \`!jarvislog\` so this session can hand over.`
  if (btwQueue.length) {
    const entries = btwQueue.slice()
    b += `\n\nBTW QUEUE (Lachy injected while you were running — act on these this tick):\n`
    b += entries.map((e, i) => `${i + 1}. ${e.message}`).join('\n')
    btwQueue.length = 0
  }
  return b
}

async function runScheduledTask(t) {
  try {
    if (t.type === 'manager') {
      const managerState = claudeState()
      // A manager schedule may override the env default for the manager runner.
      // 'ollama' or 'deepseek' = local/cheap always-on manager.
      // Falls back to codex if the selected manager provider is Claude and Claude is blocked.
      const preferredMgr = normalizeProvider(t.provider || MANAGER_PROVIDER || 'claude')
      const managerProvider = (managerState === 'blocked' && preferredMgr === 'claude') ? 'codex' : preferredMgr
      const managerModel = managerProvider === 'claude' ? (t.model || 'sonnet') : nonClaudeProviderModel(t.model)
      let briefing = await buildManagerBriefing(managerState)
      if (t.prompt) briefing += `\n\nSPECIAL DIRECTIVE THIS TICK:\n${t.prompt}`
      // Coherent Jarvis: resume its one thread if it exists, else fresh (the
      // briefing already carries memory). Same logic as !run jarvis, so manager
      // ticks and ad-hoc chats are the SAME Jarvis.
      const cont = hasHistory('jarvis')
      const run = newRun({ agent: 'jarvis', prompt: '[manager tick]', model: managerModel, effort: t.effort, source: 'manager', provider: managerProvider })
      await dispatchRun({ run, cwd: agentCwd('jarvis'), prompt: briefing, fullPrompt: briefing, continueSession: cont, model: managerModel, effort: t.effort, delegate: true })
    } else {
      const run = newRun({ agent: t.agent, prompt: t.prompt, model: t.model, effort: t.effort, source: 'schedule', provider: normalizeProvider(t.provider) })
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
  const scheduleProvider = type === 'manager' ? (provider ?? MANAGER_PROVIDER) : provider
  let runProvider
  try { runProvider = normalizeProvider(scheduleProvider) } catch (err) { return providerError(res, err) }
  const list = loadSchedule()
  const now = Date.now()
  const task = {
    id: `s${++schedSeq}`, type, agent: agent || (type === 'manager' ? 'jarvis' : agent),
    prompt: prompt || null, model: model || null, effort: effort || null,
    provider: runProvider,
    everyMin: everyMin ? Number(everyMin) : null, runAt: runAt ? Number(runAt) : null,
    nextRun: runAt ? Number(runAt) : now + (Number(everyMin) || 0) * 60000,
    activeHours: Array.isArray(activeHours) ? activeHours : null,
    preferCodex: !!(req.body || {}).preferCodex,
    preferOllama: !!(req.body || {}).preferOllama,
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

// ── Netlify form webhook ───────────────────────────────────────────────────
// Receives Netlify form submission notifications and posts them to Discord.
// Set NETLIFY_DISCORD_WEBHOOK to a Discord webhook URL (channel → integrations).
// Optionally set NETLIFY_WEBHOOK_SECRET to a secret token that Netlify sends
// via a custom header (X-Webhook-Secret) so you can verify the request origin.
const NETLIFY_WEBHOOK_SECRET  = process.env.NETLIFY_WEBHOOK_SECRET || null
const NETLIFY_DISCORD_WEBHOOK = process.env.NETLIFY_DISCORD_WEBHOOK || null

app.post('/netlify-webhook', express.json(), async (req, res) => {
  // Optional secret verification — compare a shared token sent in the header.
  if (NETLIFY_WEBHOOK_SECRET) {
    const incoming = req.get('x-webhook-secret') || req.get('x-netlify-webhook-secret') || ''
    if (incoming !== NETLIFY_WEBHOOK_SECRET) {
      console.warn('[netlify-webhook] rejected: bad secret')
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  const payload = req.body || {}
  const formName = payload.form_name || payload.form_id || 'unknown form'
  const siteUrl  = payload.site_url  || payload.site_name || ''

  // Build a readable field list from human_fields (pretty names), falling back
  // to data (raw field names), then to ordered_human_fields if present.
  const fields =
    payload.human_fields ||
    (Array.isArray(payload.ordered_human_fields)
      ? Object.fromEntries(payload.ordered_human_fields.map(f => [f.name, f.value]))
      : null) ||
    payload.data ||
    {}

  // Remove internal Netlify fields that aren't useful in the notification.
  const SKIP = new Set(['ip', 'user_agent', 'referrer'])
  const fieldLines = Object.entries(fields)
    .filter(([k]) => !SKIP.has(k.toLowerCase()))
    .map(([k, v]) => `**${k}:** ${String(v ?? '').slice(0, 500)}`)

  const submitterIp = payload.data?.ip || '—'
  const timestamp   = payload.created_at ? new Date(payload.created_at).toLocaleString() : new Date().toLocaleString()

  const message = [
    `📬 **New form submission — ${formName}**`,
    siteUrl ? `🌐 ${siteUrl}` : '',
    `🕐 ${timestamp}  ·  IP: \`${submitterIp}\``,
    '',
    ...fieldLines,
  ].filter(l => l !== undefined).join('\n').slice(0, 1900)

  console.log(`[netlify-webhook] form="${formName}" fields=${fieldLines.length}`)

  if (NETLIFY_DISCORD_WEBHOOK) {
    try {
      const r = await fetch(NETLIFY_DISCORD_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: message }),
      })
      if (!r.ok) console.warn(`[netlify-webhook] Discord post failed: ${r.status}`)
    } catch (e) {
      console.warn('[netlify-webhook] Discord post error:', e.message)
    }
  } else {
    console.warn('[netlify-webhook] NETLIFY_DISCORD_WEBHOOK not set — message not posted')
  }

  res.json({ ok: true })
})

app.listen(PORT, () => {
  console.log(`\n  AI Command Center`)
  console.log(`  Local  →  http://localhost:${PORT}`)
  console.log(`  Tunnel →  cloudflared tunnel --url http://localhost:${PORT}`)
  console.log(`  Auth   →  ${AUTH_TOKENS.size ? 'ON (ACC_SECRET/ACC_TOKEN set)' : 'OFF — localhost only, do not expose'}\n`)
})
