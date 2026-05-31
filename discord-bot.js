// AI Command Center — Discord Bot
// Start with: node --env-file=.env discord-bot.js
// Requires DISCORD_TOKEN in .env
//
// Bot permissions needed (set in OAuth2 URL generator):
//   Read Messages, Send Messages, Manage Channels, Read Message History

import { Client, GatewayIntentBits, ChannelType } from 'discord.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const TOKEN      = process.env.DISCORD_TOKEN
const SERVER_URL = 'http://localhost:3333'
const PREFIX     = '!'
const __dir      = path.dirname(fileURLToPath(import.meta.url))

// Discord category names (emoji included). Agents are split by group.
const CATEGORIES = {
  core: '🤖 Core Agents',
  web:  '🌐 Web Dev Clients',
  cc:   '📋 Command Center',
}
const LEGACY_CATEGORY = 'ai-agents' // pre-split category, still recognised for inferAgent
// Categories whose text channels map 1:1 to agents (used by inferAgent).
const AGENT_CATEGORY_NAMES = new Set([CATEGORIES.core.toLowerCase(), CATEGORIES.web.toLowerCase(), LEGACY_CATEGORY])
const STATUS_CHANNEL   = 'status-board'   // dedicated pinned board (under Command Center)
const ACTIVITY_CHANNEL = 'activity-feed'  // memory-update feed (under Command Center)

const BOARD_FILE    = path.join(__dir, 'board.json')    // pinned status board location
const ACTIVITY_FILE = path.join(__dir, 'activity.json') // activity feed state + seen sigs
const MIRROR_FILE   = path.join(__dir, 'mirror.json')   // run-mirror state (guild + seen run ids)
const BOARD_INTERVAL    = 30000   // status board refresh (ms)
const ACTIVITY_INTERVAL = 180000  // memory poll for activity feed (ms = 3 min)
const MIRROR_INTERVAL   = 12000   // run-registry poll for mirroring delegated runs (ms)

if (!TOKEN) {
  console.error('❌  DISCORD_TOKEN not set. Create a .env file with DISCORD_TOKEN=your_token')
  process.exit(1)
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
})

// ── GIFs ─────────────────────────────────────────────────────────────────────
// Add more by pasting a tenor.com/view/... URL into the right slot.
const GIFS = {
  thinking: 'https://tenor.com/view/monkey-thinking-monkey-thinking-think-money-gif-9734025314392564509',
  coding:   'https://tenor.com/view/kitten-keybo-lap-gif-19489640',
  done:     'https://tenor.com/view/anime-rimuru-tempest-リムル-テンペスト-gif-1758115167141810081',
  error:    'https://tenor.com/view/jesus-ballin-mars-bars-gif-19910027',
  reading:  'https://tenor.com/view/jack-black-opening-book-opening-box-jack-black-gif-2965523361044713223',
  waiting:  'https://tenor.com/view/the-deep-boys-chewing-gif-14784112',
  emdash:   'https://tenor.com/view/reggie-star-english-yap-em-dash-gif-15553832020253429612',
  neutral:  'https://tenor.com/view/bowser-fart-gif-11437563165283047467',
  silly:    'https://tenor.com/view/kirk-speed-kirk-trying-not-to-laugh-speed-trying-not-to-laugh-charlie-kirk-gif-8859915067900253017',
  money:    'https://tenor.com/view/daniel-larson-money-10-dollars-excited-im-rich-gif-9240755225353990096',
  happy:    'https://tenor.com/view/anime-rimuru-tempest-リムル-テンペスト-gif-11181097571604475490',
}
const GIF_USES = {
  thinking: 'agent thinking',
  coding: 'agent working',
  done: 'done',
  error: 'error',
  reading: 'reading/reference work',
  waiting: 'waiting for Lachy',
  emdash: 'em dash referenced',
  neutral: 'neutral',
  silly: 'Lachy made a mistake or is being silly',
  money: 'money',
  happy: 'happy',
}
const GIF_ALIASES = {
  cash: 'money',
  complete: 'done',
  completed: 'done',
  dash: 'emdash',
  em: 'emdash',
  emdash: 'emdash',
  emdashes: 'emdash',
  finished: 'done',
  lachy: 'silly',
  mistake: 'silly',
  mistakes: 'silly',
  ok: 'done',
  rich: 'money',
}
function gif(key) { return GIFS[key] ? `\n${GIFS[key]}` : '' }
function normalizeGifKey(raw) {
  const key = String(raw || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  if (GIFS[key]) return key
  if (GIF_ALIASES[key]) return GIF_ALIASES[key]
  if (key.includes('emdash') || key.includes('dash')) return 'emdash'
  if (key.includes('mistake') || key.includes('silly') || key.includes('lachy')) return 'silly'
  if (key.includes('money') || key.includes('cash') || key.includes('rich')) return 'money'
  if (key.includes('happy')) return 'happy'
  if (key.includes('done') || key.includes('complete') || key.includes('finish')) return 'done'
}
function gifList() {
  return Object.keys(GIFS).map(k => `\`${k}\` - ${GIF_USES[k] || k}`).join('\n')
}

// ── Model / effort ──────────────────────────────────────────────────────────
const VALID_MODELS  = ['opus', 'sonnet', 'haiku']
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
// Per-agent default model/effort, set with !model. Resets when the bot restarts.
const agentDefaults = new Map() // agent -> { model, effort }

// Pulls leading model/effort flags out of a prompt, e.g.
//   "-opus --effort high fix the nav"  →  { model:'opus', effort:'high', rest:'fix the nav' }
// Also honours per-agent !model defaults (inline flags win).
function parseRunFlags(words, agent) {
  const def = agentDefaults.get(agent) || {}
  let model = def.model, effort = def.effort, provider = def.provider
  // Only consume LEADING dashed flags. Stop at the first normal word so flag-like
  // words inside the prompt (e.g. "Codex", "--codex", "haiku") are left untouched.
  let i = 0
  for (; i < words.length; i++) {
    const w = words[i], lw = w.toLowerCase()
    const dashed = /^--?/.test(w)
    if (!dashed) break
    const bare = lw.replace(/^--?/, '')
    if (bare === 'codex') { provider = 'codex'; continue }
    if (bare === 'claude') { provider = 'claude'; continue }
    if (VALID_MODELS.includes(bare)) { model = bare; continue }
    if ((lw === '--model' || lw === '-m') && words[i + 1]) { model = words[++i].toLowerCase(); continue }
    if ((lw === '--effort' || lw === '-e') && words[i + 1]) { effort = words[++i].toLowerCase(); continue }
    if (lw === '--provider' && words[i + 1]) { provider = words[++i].toLowerCase(); continue }
    break // unknown dashed token — treat as start of prompt
  }
  // A Claude model alias is meaningless to Codex — drop it so we don't send "haiku" to GPT.
  if (provider === 'codex' && VALID_MODELS.includes(model)) model = undefined
  return { model, effort, provider, rest: words.slice(i).join(' ') }
}

// ── Active-hours parser ───────────────────────────────────────────────────────
// Parses specs like 'mon-wed 7-17, thu 7-13' into [{days:[1,2,3],start:7,end:17},…]
const DAY_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
function parseActiveHours(spec) {
  const segments = spec.split(',').map(s => s.trim()).filter(Boolean)
  if (!segments.length) throw new Error('empty spec')
  const result = []
  for (const seg of segments) {
    const parts = seg.split(/\s+/)
    if (parts.length < 2) throw new Error(`expected "<days> <start-end>", got "${seg}"`)
    const daySpec = parts[0].toLowerCase()
    const [sStr, eStr] = parts[1].split('-')
    const start = parseInt(sStr, 10), end = parseInt(eStr, 10)
    if (isNaN(start) || isNaN(end)) throw new Error(`bad hours "${parts[1]}" — use e.g. 7-17`)
    let days = []
    if (daySpec.includes('-')) {
      const [a, b] = daySpec.split('-')
      const from = DAY_NAMES[a], to = DAY_NAMES[b]
      if (from === undefined || to === undefined) throw new Error(`unknown day in "${daySpec}"`)
      if (from <= to) { for (let d = from; d <= to; d++) days.push(d) }
      else { for (let d = from; d <= 6; d++) days.push(d); for (let d = 0; d <= to; d++) days.push(d) }
    } else {
      const d = DAY_NAMES[daySpec]
      if (d === undefined) throw new Error(`unknown day "${daySpec}"`)
      days = [d]
    }
    result.push({ days, start, end })
  }
  return result
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function api(path) {
  const res = await fetch(`${SERVER_URL}${path}`)
  return res.ok ? res.json() : null
}

// Streams the run SSE. Calls onWorking() the moment first text arrives so the
// caller can switch the Discord message from "thinking" to "coding" GIF.
async function runAgent(agent, prompt, continueSession = true, onWorking, opts = {}) {
  const res = await fetch(`${SERVER_URL}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, prompt, continueSession, model: opts.model, effort: opts.effort, provider: opts.provider }),
  })
  if (!res.ok) throw new Error(`Server returned ${res.status}`)
  const reader = res.body.getReader()
  const dec    = new TextDecoder()
  let buf = '', output = '', errorText = '', working = false, exitCode = 0, cost = 0, durationMs = null
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n'); buf = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try {
        const evt = JSON.parse(line.slice(6))
        if (evt.text) {
          output += evt.text
          if (!working) { working = true; onWorking?.() }
        }
        if (evt.error) errorText += `${errorText ? '\n' : ''}${evt.error}`
        if (evt.done) { exitCode = evt.code ?? 0; cost = evt.cost ?? 0; durationMs = evt.durationMs ?? null }
      } catch {}
    }
  }
  if (exitCode !== 0 && errorText.trim()) output += `\n\n[error]\n${errorText.trim().slice(-1200)}`
  output = limitDiscordOutput(output)
  return { output: output.trim() || '(no output)', exitCode, cost, durationMs }
}

function limitDiscordOutput(text, limit = 6000) {
  const s = String(text || '')
  if (s.length <= limit) return s
  return `${s.slice(0, limit)}\n\n[truncated for Discord: ${s.length.toLocaleString()} chars total; open the dashboard/logs for the full run]`
}

// Split long text into Discord-safe chunks
function chunks(text, size = 1900) {
  const out = []
  while (text.length) { out.push(text.slice(0, size)); text = text.slice(size) }
  return out
}

function statusEmoji(content) {
  if (!content) return '⚫'
  const m = content.match(/##\s*Status\s*\n+([^\n#]+)/i)
  if (!m) return '⚫'
  const r = m[1].trim().toLowerCase()
  if (r.includes('complete'))    return '✅'
  if (r.includes('in progress')) return '🟡'
  if (r.includes('blocked'))     return '🔴'
  return '❔'
}

function statusLabel(content) {
  if (!content) return 'No data'
  const m = content.match(/##\s*Status\s*\n+([^\n#]+)/i)
  if (!m) return 'No data'
  const r = m[1].trim().toLowerCase()
  if (r.includes('complete'))    return 'Complete'
  if (r.includes('in progress')) return 'In Progress'
  if (r.includes('blocked'))     return 'Blocked'
  return 'Unknown'
}

// ── Discord channel/category helpers ──────────────────────────────────────────
async function ensureCategory(guild, name) {
  let cat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === name)
  if (!cat) cat = await guild.channels.create({ name, type: ChannelType.GuildCategory })
  return cat
}
// Find-or-create a text channel under parentId; relocates it if it lives elsewhere.
async function ensureTextChannel(guild, name, parentId, topic) {
  let ch = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === name && c.parentId === parentId)
  if (ch) { if (topic) ch.setTopic(topic).catch(() => {}); return { ch, isNew: false } }
  const elsewhere = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === name)
  if (elsewhere) { await elsewhere.setParent(parentId).catch(() => {}); if (topic) elsewhere.setTopic(topic).catch(() => {}); return { ch: elsewhere, isNew: false } }
  ch = await guild.channels.create({ name, type: ChannelType.GuildText, parent: parentId, topic })
  return { ch, isNew: true }
}

const STATUS_ORDER = { '🔴': 0, '🟡': 1, '❔': 2, '✅': 3, '⚫': 4 }
function logLine(name, content, file) {
  const emoji = statusEmoji(content)
  return { emoji, line: `${emoji} \`${name.padEnd(20)}\` ${statusLabel(content)} · ${file?.replace('.md', '') || '—'}` }
}

// ── Status board (#5) ─────────────────────────────────────────────────────────
// One pinned message that auto-refreshes: agents grouped by category, who's
// working now, and outstanding to-dos. Location persists in board.json.
let boardTimer = null
function loadBoard() { try { return JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8')) } catch { return null } }
function saveBoard(b) { try { fs.writeFileSync(BOARD_FILE, JSON.stringify(b)) } catch {} }
function clearBoard() { try { fs.unlinkSync(BOARD_FILE) } catch {}; if (boardTimer) { clearInterval(boardTimer); boardTimer = null } }

async function buildBoardContent() {
  const [meta, runs, todos] = await Promise.all([api('/agents/meta'), api('/runs'), api('/todos')])
  const agents = (meta || []).map(m => m.name)
  const logs = await Promise.all(agents.map(a => api(`/logs/${a}`)))
  const logBy = {}; agents.forEach((a, i) => { logBy[a] = logs[i] })

  const groupBlock = (title, names) => {
    if (!names.length) return ''
    const rows = names.map(n => logLine(n, logBy[n]?.content, logBy[n]?.file))
      .sort((x, y) => (STATUS_ORDER[x.emoji] ?? 9) - (STATUS_ORDER[y.emoji] ?? 9))
    return `\n\n__${title}__\n` + rows.map(r => r.line).join('\n')
  }
  const core = (meta || []).filter(m => m.group === 'core').map(m => m.name)
  const web  = (meta || []).filter(m => m.group === 'web').map(m => m.name)

  const c = runs?.counts || { active: 0, total: 0, costToday: 0 }
  let out = `**📋 AGENT STATUS BOARD**  ·  ⚡ ${c.active} active · ${c.total} runs today · 💰 $${(c.costToday || 0).toFixed(3)}`
  out += groupBlock('🤖 Core Agents', core)
  out += groupBlock('🌐 Web Dev Clients', web)
  if (runs?.active?.length) {
    out += '\n\n__⚙️ Working now__\n' + runs.active.map(r => `🟡 ${r.agent}${r.model ? ` 🧠${r.model}` : ''} — \`${(r.prompt || '').slice(0, 46)}\``).join('\n')
  }
  if (todos?.length) {
    out += '\n\n__⚠️ Outstanding__\n' + todos.slice(0, 8).map(t => {
      const head = `${t.blocked ? '🔴' : '🚩'} **${t.agent}**`
      const items = (t.flags || []).slice(0, 2).map(f => `   • ${f.slice(0, 80)}`).join('\n')
      return items ? `${head}\n${items}` : head
    }).join('\n')
  }
  out += `\n\n_updated ${new Date().toLocaleTimeString()}_`
  return out.slice(0, 1990)
}

async function updateBoard() {
  const b = loadBoard()
  if (!b) return
  try {
    const ch = await client.channels.fetch(b.channelId)
    const msg = await ch.messages.fetch(b.messageId)
    await msg.edit(await buildBoardContent())
  } catch (e) {
    console.warn('[board] update failed, clearing:', e.message)
    clearBoard()
  }
}
function startBoardLoop() {
  if (boardTimer) clearInterval(boardTimer)
  if (loadBoard()) boardTimer = setInterval(updateBoard, BOARD_INTERVAL)
}

// ── Activity feed ─────────────────────────────────────────────────────────────
// Posts to a channel whenever an agent's latest memory log changes (new session
// logged, or a fresh dated file). Seen-signatures persist in activity.json.
let activityTimer = null
function loadActivity() { try { return JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8')) } catch { return null } }
function saveActivity(a) { try { fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(a)) } catch {} }
function stopActivity() { try { fs.unlinkSync(ACTIVITY_FILE) } catch {}; if (activityTimer) { clearInterval(activityTimer); activityTimer = null } }
function logSig(log) { return log ? `${log.file}:${(log.content || '').length}` : '' }

function buildActivityPost(agent, log) {
  let post = `${statusEmoji(log?.content)} **${agent}** logged an update · ${statusLabel(log?.content)} · \`${log?.file?.replace('.md', '') || '—'}\``
  const m = log?.content?.match(/##\s*What I did\s*\n+([\s\S]*?)(?=\n##|\n---|$)/i)
  if (m) {
    const bullets = m[1].split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean).slice(0, 3)
    if (bullets.length) post += '\n' + bullets.map(b => `> ${b}`).join('\n')
  }
  const flags = log?.content?.match(/##\s*Flags for Lachy[^\n]*\n+([\s\S]*?)(?=\n##|\n---|$)/i)
  if (flags) {
    const fb = flags[1].split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(l => l && l !== '-').slice(0, 2)
    if (fb.length) post += '\n🚩 ' + fb.join(' · ').slice(0, 200)
  }
  return post.slice(0, 1900)
}

async function pollActivity() {
  const state = loadActivity()
  if (!state) return
  let ch
  try { ch = await client.channels.fetch(state.channelId) } catch { stopActivity(); return }
  const agents = await api('/agents') || []
  const sigs = state.sigs || {}
  const firstRun = !state.seeded
  const updates = []
  for (const a of agents) {
    const log = await api(`/logs/${a}`)
    const sig = logSig(log)
    if (!sig) continue
    if (sigs[a] !== sig) {
      // Only announce real changes once seeded (avoids a flood on first setup
      // and when a brand-new agent first appears).
      if (!firstRun && sigs[a] !== undefined) updates.push({ agent: a, log })
      sigs[a] = sig
    }
  }
  state.sigs = sigs; state.seeded = true
  saveActivity(state)
  for (const u of updates) {
    await ch.send(buildActivityPost(u.agent, u.log)).catch(() => {})
    await new Promise(r => setTimeout(r, 400))
  }
}
function startActivityLoop() {
  if (activityTimer) clearInterval(activityTimer)
  if (loadActivity()) activityTimer = setInterval(pollActivity, ACTIVITY_INTERVAL)
}

// Find an agent's text channel within a managed category (slug == channel name).
function findAgentChannel(guild, agent) {
  const slug = agent.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  return guild.channels.cache.find(c =>
    c.type === ChannelType.GuildText && c.name === slug &&
    c.parent && AGENT_CATEGORY_NAMES.has(c.parent.name.toLowerCase())) || null
}

// Set an agent channel's topic to its status + active model/effort default.
async function setAgentTopic(guild, agent, log) {
  const ch = findAgentChannel(guild, agent)
  if (!ch) return
  const def = agentDefaults.get(agent) || {}
  const topic = `${statusEmoji(log?.content)} ${statusLabel(log?.content)} · 🧠 ${def.model || 'default'} · ⚡ ${def.effort || 'default'}`
  ch.setTopic(topic).catch(() => {})
}

// ── Run mirror ────────────────────────────────────────────────────────────────
// Watches the run registry and posts the OUTPUT of delegated runs (source agent
// /swarm — e.g. work Jarvis handed off) into the matching agent's channel, so a
// full record of everything the swarm did lives in Discord. State in mirror.json.
let mirrorTimer = null
function loadMirror() { try { return JSON.parse(fs.readFileSync(MIRROR_FILE, 'utf8')) } catch { return null } }
function saveMirror(m) { try { fs.writeFileSync(MIRROR_FILE, JSON.stringify(m)) } catch {} }
function stopMirror() { try { fs.unlinkSync(MIRROR_FILE) } catch {}; if (mirrorTimer) { clearInterval(mirrorTimer); mirrorTimer = null } }

async function pollMirror() {
  const state = loadMirror()
  if (!state) return
  const guild = client.guilds.cache.get(state.guildId)
  if (!guild) return
  const data = await api('/runs')
  if (!data) return
  const all = [...(data.active || []), ...(data.recent || [])]
  const idToAgent = Object.fromEntries(all.map(r => [r.id, r.agent]))
  const seen = new Set(state.seen || [])

  // Mirror finished delegated / scheduled / manager runs we haven't posted yet.
  const MIRROR_SOURCES = ['agent', 'swarm', 'schedule', 'manager']
  const fresh = (data.recent || []).filter(r => MIRROR_SOURCES.includes(r.source) && !seen.has(r.id))

  for (const r of fresh.reverse()) {
    seen.add(r.id)
    const ch = findAgentChannel(guild, r.agent)
    if (!ch) continue
    const parentName = r.parent && idToAgent[r.parent] ? idToAgent[r.parent] : (r.parent === 'swarm' || r.parent === 'discord-swarm' ? 'swarm' : null)
    const meta = [r.model && `🧠${r.model}`, r.cost > 0 && `$${r.cost.toFixed(3)}`].filter(Boolean).join(' · ')
    const label = r.source === 'manager' ? '🧭 manager tick' : r.source === 'schedule' ? '⏰ scheduled' : `🔗 delegated${parentName ? ` by ${parentName}` : ''}`
    const head = `**${r.agent}** — ${label}${meta ? ` · ${meta}` : ''}\n> ${(r.prompt || '').slice(0, 120)}`
    try {
      await ch.send(head)
      for (const part of chunks(r.output || '(no output captured)')) await ch.send(part)
    } catch {}
    await new Promise(res => setTimeout(res, 400))
  }
  state.seen = [...seen].slice(-400) // bound memory
  saveMirror(state)
}
function startMirrorLoop() {
  if (mirrorTimer) clearInterval(mirrorTimer)
  if (loadMirror()) mirrorTimer = setInterval(pollMirror, MIRROR_INTERVAL)
}

// ── Discord ops executor ──────────────────────────────────────────────────────
// Polls the server's op queue and carries out structural changes Jarvis requests
// (archive/move channels, post messages). Lets Jarvis reorganise Discord itself.
const ARCHIVE_CATEGORY = '🗄 Archive'
const OPS_INTERVAL = 8000
let opsTimer = null
function slugify(name) { return String(name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-') }
function findChannelByName(guild, name) {
  const s = slugify(name)
  return guild.channels.cache.find(c => c.type === ChannelType.GuildText && (c.name === s || c.name === name)) || null
}
async function pollOps() {
  let ops
  try { ops = await api('/discord-ops') } catch { return }
  if (!ops?.length) return
  const guild = client.guilds.cache.first()
  if (!guild) return
  const done = []
  for (const o of ops) {
    try {
      if (o.op === 'archive') {
        const ch = findAgentChannel(guild, o.agent) || findChannelByName(guild, o.agent)
        if (ch) { const cat = await ensureCategory(guild, ARCHIVE_CATEGORY); await ch.setParent(cat.id) }
      } else if (o.op === 'unarchive') {
        const ch = findChannelByName(guild, o.agent)
        if (ch) { const meta = (await api('/agents/meta') || []).find(m => m.name === o.agent); const cat = await ensureCategory(guild, meta?.group === 'web' ? CATEGORIES.web : CATEGORIES.core); await ch.setParent(cat.id) }
      } else if (o.op === 'say') {
        const ch = findChannelByName(guild, o.channel)
        if (ch) for (const part of chunks(o.text || '')) await ch.send(part)
      } else if (o.op === 'move') {
        const ch = findChannelByName(guild, o.channel)
        if (ch) { const cat = await ensureCategory(guild, o.category); await ch.setParent(cat.id) }
      }
    } catch (e) { console.warn('[ops]', o.id, e.message) }
    done.push(o.id) // ack regardless so a bad op can't loop forever
  }
  if (done.length) await fetch(`${SERVER_URL}/discord-ops/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: done }) }).catch(() => {})
}
function startOpsLoop() { if (opsTimer) clearInterval(opsTimer); opsTimer = setInterval(pollOps, OPS_INTERVAL) }

// If the message is in an agent channel (inside a managed agent category),
// return the agent name — lets you skip typing the agent in !run / !log / !history
function inferAgent(msg) {
  const ch = msg.channel
  if (!ch || ch.type !== ChannelType.GuildText) return null
  const parent = ch.parent
  if (!parent || !AGENT_CATEGORY_NAMES.has(parent.name.toLowerCase())) return null
  return ch.name // channel name == agent name
}

// ── Commands ──────────────────────────────────────────────────────────────────

const HELP = `**AI Command Center**
\`!agents\` — list all agents + status
\`!log [agent]\` — latest memory log
\`!history [agent]\` — last conversation messages
\`!run [agent] <prompt>\` — send a prompt (--continue by default)
   _flags:_ \`-opus\`/\`-sonnet\`/\`-haiku\`, \`-codex\`, \`--effort high\`
\`!model [agent] <model> [effort]\` — set default model/effort for an agent
\`!swarm <a,b,c> <prompt>\` — run one prompt across several agents in parallel
\`!runs\` — live registry: who's working now + cost today
\`!new-agent <name> [dir]\` — scaffold a new agent (dir + CLAUDE.md + memory)
\`!jarvislog [agent]\` — make an agent write its memory log (handover)
\`!todos\` — outstanding flags + blockers across all agents
\`!board\` — pinned, auto-updating status board in #status-board (\`!board stop\`)
\`!activity\` — feed in #activity-feed when agents log new memories (\`!activity stop\`)
\`!mirror\` — post delegated run output into each agent's channel (\`!mirror stop\`)
\`!money\` — create the #money channel for Jarvis's revenue updates
\`!gif <name|list>\` — post one of the agent reaction GIFs
\`!archive <agent> [undo]\` — shelve/unshelve a project's channel
\`!usage\` — usage / rate-limit status + spend today
\`!manage [min]\` — Jarvis runs as a background manager every N min (\`!manage stop\`)
\`!manage hours mon-fri 9-17\` — restrict manager ticks to active hours (e.g. \`mon-wed 7-17, thu 7-13\`)
\`!schedule …\` — \`list\` · \`every <min> <agent> <prompt>\` · \`in <min> …\` · \`cancel <id>\`
\`!sync\` — build 🤖 Core / 🌐 Web Dev categories + a channel per agent
\`!status\` — server heartbeat
\`!help\` — this message

_In an agent channel, [agent] can be omitted. Running there auto-loads that agent's memory on first use._`

client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return
  if (!msg.content.startsWith(PREFIX)) return

  const args = msg.content.slice(PREFIX.length).trim().split(/\s+/)
  const cmd  = args.shift().toLowerCase()

  // ── !help ────────────────────────────────────────────────────────────────
  if (cmd === 'help') {
    await msg.reply(HELP)
    return
  }

  // ── !gif <name|list> ─────────────────────────────────────────────────────
  if (cmd === 'gif') {
    const requested = args.join(' ').trim()
    if (!requested || requested.toLowerCase() === 'list') {
      await msg.reply(`**Agent reaction GIFs**\n${gifList()}`)
      return
    }

    const key = normalizeGifKey(requested)
    if (!key) {
      await msg.reply(`Unknown GIF: \`${requested}\`\n${gifList()}`)
      return
    }

    await msg.reply(`_${GIF_USES[key] || key}_${gif(key)}`)
    return
  }

  // ── !status ──────────────────────────────────────────────────────────────
  if (cmd === 'status') {
    try {
      const data = await api('/status')
      await msg.reply(`✅ Server online — \`${data.time}\``)
    } catch {
      await msg.reply('❌ Cannot reach server. Is it running?')
    }
    return
  }

  // ── !agents ──────────────────────────────────────────────────────────────
  if (cmd === 'agents') {
    try {
      const agents = await api('/agents')
      if (!agents?.length) { await msg.reply('No agents found.'); return }
      const lines = await Promise.all(agents.map(async (a) => {
        const log = await api(`/logs/${a}`)
        const emoji = statusEmoji(log?.content)
        const date  = log?.file?.replace('.md', '') || 'no log'
        return `${emoji} **${a}** \`${date}\``
      }))
      await msg.reply(`**Agents (${agents.length})**\n${lines.join('\n')}`)
    } catch (e) {
      await msg.reply(`❌ ${e.message}`)
    }
    return
  }

  // ── !log [agent] ─────────────────────────────────────────────────────────
  if (cmd === 'log') {
    const agent = args[0] || inferAgent(msg)
    if (!agent) { await msg.reply('Usage: `!log <agent>` (or run from an agent channel)'); return }
    try {
      const log = await api(`/logs/${agent}`)
      if (!log) { await msg.reply(`No log found for **${agent}**`); return }
      const preview = log.content.slice(0, 1800)
      await msg.reply(`**${agent}** — \`${log.file}\`\n\`\`\`md\n${preview}\n\`\`\``)
    } catch (e) {
      await msg.reply(`❌ ${e.message}`)
    }
    return
  }

  // ── !history [agent] ─────────────────────────────────────────────────────
  if (cmd === 'history') {
    const agent = args[0] || inferAgent(msg)
    if (!agent) { await msg.reply('Usage: `!history <agent>` (or run from an agent channel)'); return }
    try {
      const data = await api(`/history/${agent}`)
      if (!data?.messages?.length) {
        await msg.reply(`No conversation history for **${agent}** yet.\nUse \`!run ${agent} <prompt>\` to start one — memory log will be used as context.`)
        return
      }
      // Show last 8 messages, compact format
      const recent = data.messages.slice(-8)
      const lines  = recent.map(m => {
        const who  = m.role === 'user' ? '**▶ You**' : '**◀ Claude**'
        const text = m.text.length > 350 ? m.text.slice(0, 350) + '…' : m.text
        return `${who}\n${text}`
      })
      const header = `**${agent}** — showing ${recent.length} of ${data.messages.length} messages\n${'─'.repeat(28)}\n`
      const full   = header + lines.join('\n\n')
      const parts  = chunks(full)
      await msg.reply(parts[0])
      for (const part of parts.slice(1)) await msg.channel.send(part)
    } catch (e) {
      await msg.reply(`❌ ${e.message}`)
    }
    return
  }

  // ── !model [agent] <model> [effort] ───────────────────────────────────────
  // Sets a per-agent default model/effort for subsequent !run calls.
  //   !model sandwich-house opus high   ·   !model opus   (in an agent channel)
  if (cmd === 'model') {
    const chAgent = inferAgent(msg)
    let agent, rest
    if (chAgent && (VALID_MODELS.includes((args[0] || '').toLowerCase()) || VALID_EFFORTS.includes((args[0] || '').toLowerCase()))) {
      agent = chAgent; rest = args
    } else {
      agent = args.shift() || chAgent; rest = args
    }
    if (!agent || !rest.length) {
      await msg.reply('Usage: `!model <agent> <opus|sonnet|haiku> [low|medium|high|xhigh|max]`\nIn an agent channel: `!model opus high`. Use `!model <agent> reset` to clear.')
      return
    }
    if (rest[0].toLowerCase() === 'reset') {
      agentDefaults.delete(agent)
      await msg.reply(`↺ Cleared model/effort default for **${agent}**.`)
      return
    }
    const cur = agentDefaults.get(agent) || {}
    for (const w of rest) {
      const lw = w.toLowerCase()
      if (VALID_MODELS.includes(lw))  cur.model = lw
      if (VALID_EFFORTS.includes(lw)) cur.effort = lw
    }
    if (!cur.model && !cur.effort) {
      await msg.reply('Nothing set — valid models: `opus sonnet haiku`, efforts: `low medium high xhigh max`.')
      return
    }
    agentDefaults.set(agent, cur)
    if (msg.guild) { const log = await api(`/logs/${agent}`); setAgentTopic(msg.guild, agent, log).catch(() => {}) }
    await msg.reply(`✅ **${agent}** default → ${cur.model ? `🧠 ${cur.model}` : ''}${cur.model && cur.effort ? ' · ' : ''}${cur.effort ? `⚡ ${cur.effort}` : ''}\n_Override per-run with inline flags. Resets on bot restart. Channel topic updated._`)
    return
  }

  // ── !run [agent] <prompt> ─────────────────────────────────────────────────
  if (cmd === 'run') {
    // If in an agent channel, agent is inferred and all args are the prompt
    const channelAgent = inferAgent(msg)
    let agent, rest
    if (channelAgent) {
      agent = channelAgent
      rest  = args
    } else {
      agent = args.shift()
      rest  = args
    }

    const { model, effort, provider, rest: prompt } = parseRunFlags(rest, agent)

    if (!agent || !prompt) {
      await msg.reply('Usage: `!run <agent> [-opus|-sonnet|-haiku|-codex] [--effort high] <prompt>`\nTip: run from an agent channel to skip the agent name.')
      return
    }

    // Decide continue vs fresh: if this agent has no prior conversation thread,
    // run fresh so the server injects its memory log as context. Otherwise resume.
    let cont = true
    try { const h = await api(`/history/${agent}`); if (!h?.messages?.length) cont = false } catch { cont = false }

    const tag   = [provider === 'codex' && '🟢 codex', model && `🧠 ${model}`, effort && `⚡ ${effort}`, !cont && '🧠 memory'].filter(Boolean).join(' · ')
    const tagS  = tag ? ` (${tag})` : ''
    const short = `\`${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''}\``
    const statusMsg = await msg.reply(`🤔 **${agent}**${tagS} thinking…${gif('thinking')}\n${short}`)

    let elapsed = 0
    let hasOutput = false
    const progressInterval = setInterval(async () => {
      elapsed += 30
      const tick = hasOutput
        ? `⌨️ **${agent}**${tagS} still working… (${elapsed}s)${gif('coding')}\n${short}`
        : `⏳ **${agent}**${tagS} thinking… (${elapsed}s)${gif('thinking')}\n${short}`
      await statusMsg.edit(tick).catch(() => {})
    }, 30000)

    try {
      const { output, exitCode, cost, durationMs } = await runAgent(agent, prompt, cont, async () => {
        hasOutput = true
        // First output received — switch to coding GIF
        await statusMsg.edit(`⌨️ **${agent}**${tagS} working…${gif('coding')}\n${short}`).catch(() => {})
      }, { model, effort, provider })

      clearInterval(progressInterval)

      const ok    = exitCode === 0
      const needsOk = /please approve|approval|waiting for (your|feedback|confirmation|input)|flagged|should i proceed|do you want me to|would you like me to|permission to|before i (make|write|edit|delete|remove|create)/i.test(output)
      const icon    = needsOk ? '⏸️' : ok ? '✅' : '⚠️'
      const endGif  = needsOk ? gif('waiting') : ok ? gif('done') : gif('error')
      const suffix  = needsOk ? '\n\n_Waiting for your approval — reply here or check the dashboard._' : ''
      const meta    = [cost > 0 && `$${cost.toFixed(4)}`, durationMs && `${(durationMs / 1000).toFixed(1)}s`].filter(Boolean).join(' · ')
      const metaS   = meta ? `  \`${meta}\`` : ''
      // 1700-char chunks leave room for the header/GIF/suffix overhead (~300 chars) within Discord's 2000-char limit
      const parts   = chunks(output, 1700)
      await statusMsg.edit(`${icon} **${agent}**${tagS}${metaS} ›${endGif}\n${parts[0]}${parts.length === 1 ? suffix : ''}`)
      for (let i = 1; i < parts.length; i++) await msg.channel.send(parts[i] + (i === parts.length - 1 ? suffix : ''))
    } catch (e) {
      clearInterval(progressInterval)
      await statusMsg.edit(`❌ **${agent}** — ${e.message}${gif('error')}`)
    }
    return
  }

  // ── !runs ─────────────────────────────────────────────────────────────────
  // Live registry: how many agents are working right now + recent finished runs.
  if (cmd === 'runs') {
    try {
      const data = await api('/runs')
      if (!data) { await msg.reply('❌ Cannot reach server.'); return }
      const { active, recent, counts } = data
      const fmt = r => {
        const dot = r.status === 'running' ? '🟡' : r.status === 'waiting' ? '⏸️' : r.status === 'error' ? '🔴' : '🟢'
        const src = r.source === 'swarm' ? '🐝' : r.source === 'agent' ? '🔗' : '🖥'
        const meta = [r.model && `🧠${r.model}`, r.cost > 0 && `$${r.cost.toFixed(3)}`,
          r.status === 'running' ? `${Math.round((Date.now() - r.startedAt) / 1000)}s` : (r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '')].filter(Boolean).join(' ')
        return `${dot}${src} **${r.agent}** ${meta}\n   \`${(r.prompt || '').slice(0, 70)}\``
      }
      let out = `**⚡ ${counts.active} active** · ${counts.total} total today · 💰 $${counts.costToday.toFixed(3)}\n`
      if (active.length) out += `\n__Active__\n${active.map(fmt).join('\n')}\n`
      if (recent.length) out += `\n__Recent__\n${recent.slice(0, 6).map(fmt).join('\n')}`
      if (!active.length && !recent.length) out += '\n_No runs yet._'
      await msg.reply(out.slice(0, 1950))
    } catch (e) { await msg.reply(`❌ ${e.message}`) }
    return
  }

  // ── !swarm <agent1,agent2,...> <prompt> ────────────────────────────────────
  // Fans the SAME prompt out to several agents in parallel.
  if (cmd === 'swarm') {
    const agentList = (args.shift() || '').split(',').map(s => s.trim()).filter(Boolean)
    const prompt = args.join(' ')
    if (agentList.length < 1 || !prompt) {
      await msg.reply('Usage: `!swarm agentA,agentB,agentC <prompt>`\nRuns the same prompt across several agents in parallel.')
      return
    }
    const statusMsg = await msg.reply(`🐝 **Swarm** — dispatching to ${agentList.length} agents…${gif('thinking')}\n\`${prompt.slice(0, 60)}\``)
    try {
      const res = await fetch(`${SERVER_URL}/swarm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks: agentList.map(a => ({ agent: a, prompt })), parent: `discord-swarm` }),
      })
      if (!res.ok) throw new Error(`Server returned ${res.status}`)
      const data = await res.json()
      const fails = data.tasks.filter(t => t.exitCode !== 0).length
      await statusMsg.edit(`🐝 **Swarm done** — ${data.count} agents · 💰 $${data.totalCost.toFixed(4)}${fails ? ` · ⚠️ ${fails} failed` : ''}${fails ? gif('error') : gif('done')}`)
      for (const t of data.tasks) {
        const head = `${t.exitCode === 0 ? '✅' : '⚠️'} **${t.agent}**${t.error ? ` (${t.error})` : ''}${t.cost ? ` \`$${t.cost.toFixed(4)}\`` : ''}`
        for (const part of chunks(limitDiscordOutput(t.output || '(no output)'), 1800)) {
          await msg.channel.send(`${head}\n${part}`)
        }
      }
    } catch (e) {
      await statusMsg.edit(`❌ **Swarm** — ${e.message}${gif('error')}`)
    }
    return
  }

  // ── !new-agent <name> [dir] ────────────────────────────────────────────────
  // Scaffolds a project dir + CLAUDE.md + memory folder, then registers it.
  if (cmd === 'new-agent' || cmd === 'newagent') {
    const name = args.shift()
    const dir  = args.join(' ').trim() || undefined
    if (!name) { await msg.reply('Usage: `!new-agent <name> [project-dir]`'); return }
    try {
      const res = await fetch(`${SERVER_URL}/new-agent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, dir }),
      })
      const d = await res.json()
      if (!res.ok) { await msg.reply(`❌ ${d.error || res.status}`); return }
      await msg.reply(`🆕 Created agent **${d.agent}**\n📁 \`${d.dir}\`\n${d.claudeMdCreated ? '📝 CLAUDE.md scaffolded' : '📝 CLAUDE.md already existed'} · 🧠 memory folder ready\nRun it with \`!run ${d.agent} <prompt>\` or \`!sync\` to add a channel.`)
    } catch (e) { await msg.reply(`❌ ${e.message}`) }
    return
  }

  // ── !board [stop] ──────────────────────────────────────────────────────────
  // Posts a pinned, auto-updating status board in its OWN channel (#status-board
  // under the 📋 Command Center category).
  if (cmd === 'board') {
    if (args[0] === 'stop') { clearBoard(); await msg.reply('📋 Status board stopped.'); return }
    const guild = msg.guild
    if (!guild) { await msg.reply('❌ Must be used in a server.'); return }
    try {
      const cat = await ensureCategory(guild, CATEGORIES.cc)
      const { ch } = await ensureTextChannel(guild, STATUS_CHANNEL, cat.id, 'Live agent status — auto-updated')
      const sent = await ch.send(await buildBoardContent())
      try { await sent.pin() } catch { /* needs Manage Messages — fine without */ }
      saveBoard({ guildId: guild.id, channelId: ch.id, messageId: sent.id })
      startBoardLoop()
      await msg.reply(`📋 Status board is live in <#${ch.id}> — auto-updates every ${BOARD_INTERVAL / 1000}s. \`!board stop\` to end.`)
    } catch (e) { await msg.reply(`❌ ${e.message}`) }
    return
  }

  // ── !activity [stop] ───────────────────────────────────────────────────────
  // Posts to #activity-feed whenever an agent logs a new memory update.
  if (cmd === 'activity') {
    if (args[0] === 'stop') { stopActivity(); await msg.reply('📡 Activity feed stopped.'); return }
    const guild = msg.guild
    if (!guild) { await msg.reply('❌ Must be used in a server.'); return }
    try {
      const cat = await ensureCategory(guild, CATEGORIES.cc)
      const { ch } = await ensureTextChannel(guild, ACTIVITY_CHANNEL, cat.id, 'Posts when an agent logs a new memory update')
      saveActivity({ channelId: ch.id, sigs: {}, seeded: false })
      await pollActivity() // seed baseline silently (no spam on setup)
      startActivityLoop()
      await msg.reply(`📡 Activity feed is live in <#${ch.id}> — posts when any agent logs a new memory update (checks every ${ACTIVITY_INTERVAL / 60000} min). \`!activity stop\` to end.`)
    } catch (e) { await msg.reply(`❌ ${e.message}`) }
    return
  }

  // ── !todos ─────────────────────────────────────────────────────────────────
  // Outstanding "Flags for Lachy" + blockers, scanned across all agent memories.
  if (cmd === 'todos' || cmd === 'todo') {
    try {
      const todos = await api('/todos')
      if (!todos?.length) { await msg.reply('✅ No outstanding flags or blockers — all clear.'); return }
      let out = `**⚠️ Outstanding to-dos** — ${todos.length} agent${todos.length > 1 ? 's' : ''}\n`
      for (const t of todos) {
        out += `\n${t.blocked ? '🔴' : '🚩'} **${t.agent}** \`${t.file?.replace('.md', '') || ''}\`\n`
        out += ((t.flags || []).slice(0, 4).map(f => `• ${f}`).join('\n')) || '_(blocked — no flags listed)_'
        out += '\n'
      }
      for (const part of chunks(out)) await msg.channel.send(part)
    } catch (e) { await msg.reply(`❌ ${e.message}`) }
    return
  }

  // ── !mirror [stop] ─────────────────────────────────────────────────────────
  // Mirrors delegated (agent/swarm) run output into each agent's own channel, so
  // when Jarvis hands work off, the record shows up in that agent's channel.
  if (cmd === 'mirror') {
    if (args[0] === 'stop') { stopMirror(); await msg.reply('🔗 Run mirroring stopped.'); return }
    const guild = msg.guild
    if (!guild) { await msg.reply('❌ Must be used in a server.'); return }
    try {
      // Baseline: mark all current finished runs as already-seen so we don't dump history.
      const data = await api('/runs')
      const seen = (data?.recent || []).map(r => r.id)
      saveMirror({ guildId: guild.id, seen })
      startMirrorLoop()
      await msg.reply(`🔗 Run mirroring on — delegated runs will post into each agent's channel as they finish (checked every ${MIRROR_INTERVAL / 1000}s). \`!mirror stop\` to end.`)
    } catch (e) { await msg.reply(`❌ ${e.message}`) }
    return
  }

  // ── !jarvislog [agent] ─────────────────────────────────────────────────────
  // Tells the agent to write its session memory log (the jarvis-log routine).
  if (cmd === 'jarvislog' || cmd === 'memlog') {
    const agent = args[0] || inferAgent(msg) || 'jarvis'
    const today = new Date().toISOString().slice(0, 10)
    const memDir = `C:\\Users\\nirke\\OneDrive\\Documents\\Obsidian\\Lachy\\agent-memory\\${agent}\\${today}.md`
    const logPrompt = `Write your session memory log now for handover. Append (don't overwrite) a new entry to \`${memDir}\` using the standard template: ## What I did, ## Files changed, ## Errors / blockers, ## Flags for Lachy 🚩, ## Status. Summarise everything done in this session concisely. If the file or folder doesn't exist, create it. Confirm in one line when done.`
    const statusMsg = await msg.reply(`📝 **${agent}** writing memory log…${gif('thinking')}`)
    let logElapsed = 0
    const logProgressInterval = setInterval(async () => {
      logElapsed += 30
      await statusMsg.edit(`📝 **${agent}** writing memory log… (${logElapsed}s)${gif('coding')}`).catch(() => {})
    }, 30000)
    try {
      const { output, exitCode, cost } = await runAgent(agent, logPrompt, true, async () => {
        await statusMsg.edit(`📝 **${agent}** writing memory log…${gif('coding')}`).catch(() => {})
      })
      clearInterval(logProgressInterval)
      const icon = exitCode === 0 ? '✅' : '⚠️'
      await statusMsg.edit(`${icon} **${agent}** memory log${cost > 0 ? ` \`$${cost.toFixed(4)}\`` : ''}${gif('done')}\n\`\`\`\n${(output || '(done)').slice(0, 1500)}\n\`\`\``)
    } catch (e) { clearInterval(logProgressInterval); await statusMsg.edit(`❌ **${agent}** — ${e.message}${gif('error')}`) }
    return
  }

  // ── !usage ─────────────────────────────────────────────────────────────────
  if (cmd === 'usage') {
    try {
      const u = await api('/usage')
      if (!u) { await msg.reply('❌ Cannot reach server.'); return }
      const st = u.claudeState
      const state = st === 'blocked' ? '⛔ rate-limited / out of credits' : st === 'warning' ? '⚠️ near cap' : Object.keys(u.windows || {}).length ? '✅ green' : '❔ no data yet (run something first)'
      let out = `**📊 Usage** — Claude ${state}`
      for (const w of Object.values(u.windows || {})) {
        const pct = w.utilization != null ? `${Math.round(w.utilization * 100)}%` : w.status
        const reset = w.resetsAt ? ` · resets ${new Date(w.resetsAt * 1000).toLocaleTimeString()}` : ''
        out += `\n  • ${w.rateLimitType}: ${pct}${reset}`
      }
      out += `\n🎯 Target ceiling: ${Math.round((u.target || 0.75) * 100)}%`
      out += `\n🟢 Codex today: ~${(u.codexTokensToday || 0).toLocaleString()} tokens`
      out += `\n💰 Claude spend today: $${(u.costToday || 0).toFixed(3)}${gif('money')}`
      await msg.reply(out)
    } catch (e) { await msg.reply(`❌ ${e.message}`) }
    return
  }

  // ── !manage [everyMin|stop|hours <spec>] ───────────────────────────────────
  // Turns Jarvis into a background manager: every N minutes it reviews to-dos +
  // usage and decides what to do (delegating as needed). Default 60 min.
  // !manage hours <spec> restricts ticks to active hours (e.g. mon-fri 9-17).
  if (cmd === 'manage') {
    try {
      const existing = (await api('/schedule') || []).filter(t => t.type === 'manager')
      if (args[0] === 'stop') {
        for (const t of existing) await fetch(`${SERVER_URL}/schedule/${t.id}`, { method: 'DELETE' })
        await msg.reply('🧭 Jarvis manager loop stopped.')
        return
      }
      if (args[0] === 'codex') {
        const on = args[1] !== 'off'
        const everyMin = existing[0]?.everyMin || 60
        const activeHours = existing[0]?.activeHours || undefined
        for (const t of existing) await fetch(`${SERVER_URL}/schedule/${t.id}`, { method: 'DELETE' })
        await fetch(`${SERVER_URL}/schedule`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'manager', everyMin, activeHours, preferCodex: on }),
        })
        await msg.reply(on
          ? '🟢 **Manager now PREFERS Codex** for every worker task — Claude is reserved (only Jarvis\'s own thinking uses it). `!manage codex off` to revert.'
          : '↩️ Manager back to auto: Claude until ~90%, then Codex.')
        return
      }
      if (args[0] === 'hours') {
        const spec = args.slice(1).join(' ').trim()
        if (!spec) { await msg.reply('Usage: `!manage hours mon-fri 9-17` or `!manage hours mon-wed 7-17, thu 7-13`'); return }
        let activeHours
        try { activeHours = parseActiveHours(spec) } catch (e) { await msg.reply(`❌ Invalid hours spec: ${e.message}\nExample: \`mon-fri 9-17\` or \`mon-wed 7-17, thu 7-13\``); return }
        const everyMin = existing[0]?.everyMin || 60
        const preferCodex = existing[0]?.preferCodex || false
        for (const t of existing) await fetch(`${SERVER_URL}/schedule/${t.id}`, { method: 'DELETE' })
        const res = await fetch(`${SERVER_URL}/schedule`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'manager', everyMin, activeHours, preferCodex }),
        })
        const d = await res.json()
        const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
        const desc = activeHours.map(e => `${e.days.map(d => DAY_LABELS[d]).join('/')} ${e.start}:00–${e.end}:00`).join(', ')
        await msg.reply(`🧭 **Jarvis manager hours set** — ticks every ${everyMin} min, active: ${desc}\n\`!manage stop\` to end · \`!manage [min]\` to restart without hour restrictions`)
        return
      }
      const everyMin = parseInt(args[0], 10) || 60
      const preferCodex = existing[0]?.preferCodex || false
      for (const t of existing) await fetch(`${SERVER_URL}/schedule/${t.id}`, { method: 'DELETE' }) // replace
      const res = await fetch(`${SERVER_URL}/schedule`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'manager', everyMin, preferCodex }),
      })
      const d = await res.json()
      await msg.reply(`🧭 **Jarvis manager loop ON** — every ${everyMin} min Jarvis reviews to-dos + usage and acts (mirrored to channels)${preferCodex ? ' · 🟢 Codex-preferred' : ''}. First tick in ${everyMin} min. \`!manage stop\` to end · \`!manage hours mon-fri 9-17\` · \`!manage codex\` to save Claude.\n_Make sure \`!mirror\` is on so you see what it does._`)
    } catch (e) { await msg.reply(`❌ ${e.message}`) }
    return
  }

  // ── !schedule … ──────────────────────────────────────────────────────────────
  //   !schedule list
  //   !schedule cancel <id>
  //   !schedule every <min> <agent> <prompt>
  //   !schedule in <min> <agent> <prompt>
  if (cmd === 'schedule' || cmd === 'sched') {
    const sub = (args.shift() || 'list').toLowerCase()
    try {
      if (sub === 'list') {
        const list = await api('/schedule') || []
        if (!list.length) { await msg.reply('📭 No scheduled tasks. Add one: `!schedule every 60 hoagies <prompt>`'); return }
        const lines = list.map(t => {
          const when = t.everyMin ? `every ${t.everyMin}m` : `once @ ${new Date(t.runAt).toLocaleString()}`
          const next = t.enabled ? ` · next ${new Date(t.nextRun).toLocaleTimeString()}` : ' · done'
          return `\`${t.id}\` ${t.type === 'manager' ? '🧭 manager' : `▶ ${t.agent}`} · ${when}${next}\n   ${t.prompt ? `\`${t.prompt.slice(0, 60)}\`` : ''}`
        })
        await msg.reply(`**⏰ Scheduled tasks (${list.length})**\n${lines.join('\n')}`)
        return
      }
      if (sub === 'cancel' || sub === 'remove' || sub === 'delete') {
        const id = args[0]
        if (!id) { await msg.reply('Usage: `!schedule cancel <id>`'); return }
        const res = await fetch(`${SERVER_URL}/schedule/${id}`, { method: 'DELETE' })
        const d = await res.json()
        await msg.reply(d.removed ? `🗑 Cancelled \`${id}\`.` : `Not found: \`${id}\``)
        return
      }
      if (sub === 'every' || sub === 'in') {
        const mins = parseInt(args.shift(), 10)
        const agent = args.shift()
        const prompt = args.join(' ')
        if (!mins || !agent || !prompt) { await msg.reply('Usage: `!schedule every|in <minutes> <agent> <prompt>`'); return }
        const body = sub === 'every'
          ? { type: 'agent', agent, prompt, everyMin: mins }
          : { type: 'agent', agent, prompt, runAt: Date.now() + mins * 60000 }
        const res = await fetch(`${SERVER_URL}/schedule`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        const d = await res.json()
        if (!res.ok) { await msg.reply(`❌ ${d.error}`); return }
        await msg.reply(`⏰ Scheduled \`${d.task.id}\` — ${sub === 'every' ? `every ${mins} min` : `in ${mins} min`} → **${agent}**\n\`${prompt.slice(0, 80)}\``)
        return
      }
      await msg.reply('Usage: `!schedule list` · `!schedule every <min> <agent> <prompt>` · `!schedule in <min> <agent> <prompt>` · `!schedule cancel <id>`')
    } catch (e) { await msg.reply(`❌ ${e.message}`) }
    return
  }

  // ── !money ─────────────────────────────────────────────────────────────────
  // Creates the #money channel (under Command Center) where Jarvis posts updates.
  if (cmd === 'money') {
    const guild = msg.guild
    if (!guild) { await msg.reply('❌ Must be used in a server.'); return }
    try {
      const cat = await ensureCategory(guild, CATEGORIES.cc)
      const { ch } = await ensureTextChannel(guild, 'money', cat.id, 'Monthly revenue + business goals — posted by Jarvis')
      await msg.reply(`💰 Money channel ready: <#${ch.id}>. Jarvis posts monthly revenue + goals updates here (and on the 1st of each month).${gif('money')}`)
    } catch (e) { await msg.reply(`❌ ${e.message}`) }
    return
  }

  // ── !archive <agent> [undo] ──────────────────────────────────────────────────
  // Shelve a project's channel into the Archive category (or move it back).
  if (cmd === 'archive') {
    const guild = msg.guild
    if (!guild) { await msg.reply('❌ Must be used in a server.'); return }
    const agent = args[0]
    if (!agent) { await msg.reply('Usage: `!archive <agent> [undo]`'); return }
    try {
      const op = args[1] === 'undo' ? 'unarchive' : 'archive'
      const ch = findAgentChannel(guild, agent) || findChannelByName(guild, agent)
      if (!ch) { await msg.reply(`No channel found for **${agent}**.`); return }
      if (op === 'archive') { const cat = await ensureCategory(guild, ARCHIVE_CATEGORY); await ch.setParent(cat.id); await msg.reply(`🗄 Archived **${agent}**.`) }
      else { const meta = (await api('/agents/meta') || []).find(m => m.name === agent); const cat = await ensureCategory(guild, meta?.group === 'web' ? CATEGORIES.web : CATEGORIES.core); await ch.setParent(cat.id); await msg.reply(`📤 Unarchived **${agent}**.`) }
    } catch (e) { await msg.reply(`❌ ${e.message}`) }
    return
  }

  // ── !sync ─────────────────────────────────────────────────────────────────
  // Builds two categories — 🤖 Core Agents and 🌐 Web Dev Clients — and one
  // channel per agent in the right group, each seeded with a status snapshot.
  if (cmd === 'sync') {
    const guild = msg.guild
    if (!guild) { await msg.reply('❌ Must be used in a server.'); return }

    const thinking = await msg.reply('⏳ Syncing agent channels…')
    try {
      const meta = await api('/agents/meta') || []
      if (!meta.length) { await thinking.edit('No agents found.'); return }

      const cats = {
        core: await ensureCategory(guild, CATEGORIES.core),
        web:  await ensureCategory(guild, CATEGORIES.web),
      }
      const results = []

      for (const { name: agent, group } of meta) {
        try {
          const chName = agent.toLowerCase().replace(/[^a-z0-9-]/g, '-')
          const parent = (cats[group] || cats.core).id

          const [log, history] = await Promise.all([api(`/logs/${agent}`), api(`/history/${agent}`)])
          const emoji = statusEmoji(log?.content)
          const label = statusLabel(log?.content)
          const date  = log?.file?.replace('.md', '') || '—'

          const def = agentDefaults.get(agent) || {}
          const topic = `${emoji} ${label} · ${date} · 🧠 ${def.model || 'default'} · ⚡ ${def.effort || 'default'}`
          const { ch, isNew } = await ensureTextChannel(guild, chName, parent, topic)

          let post = `${emoji} **${agent}** · ${label} · \`${date}\`\n`
          if (log?.content) {
            const m = log.content.match(/##\s*What I did\s*\n+([\s\S]*?)(?=\n##|\n---|$)/i)
            if (m) {
              const bullets = m[1].split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean).slice(0, 3)
              if (bullets.length) post += bullets.map(b => `> ${b}`).join('\n') + '\n'
            }
          }
          if (history?.messages?.length) {
            post += `\n**Last conversation** (${history.messages.length} msgs total)\n\`\`\`\n`
            post += history.messages.slice(-4).map(m => `${m.role === 'user' ? '▶' : '◀'} ${m.text.slice(0, 180)}`).join('\n\n')
            post += '\n```'
          } else {
            post += '\n_No conversation history yet — use `!run` to start one._'
          }

          await ch.send(post.slice(0, 1900))
          results.push(`${isNew ? '🆕' : '🔄'} ${group === 'web' ? '🌐' : '🤖'} #${chName}`)
          await new Promise(r => setTimeout(r, 600)) // gentle on rate limits
        } catch (e) {
          results.push(`❌ ${agent}: ${e.message}`)
        }
      }

      const ok = results.filter(r => !r.startsWith('❌')).length
      const summary = chunks(`✅ Synced ${ok}/${meta.length} channels into 🤖/🌐 categories\n${results.join('\n')}`)
      await thinking.edit(summary[0])
      for (const part of summary.slice(1)) await msg.channel.send(part)
    } catch (e) {
      await thinking.edit(`❌ ${e.message}`)
    }
    return
  }

  // Unknown command
  await msg.reply(`Unknown command. Try \`!help\``)
})

client.once('ready', () => {
  console.log(`✅ Discord bot online as ${client.user.tag}`)
  console.log(`   Prefix: ${PREFIX}  |  Commands: help, agents, log, history, run, model, swarm, runs, new-agent, jarvislog, todos, board, activity, mirror, money, gif, archive, usage, manage, schedule, sync, status`)
  startBoardLoop()    // resume the pinned status board if one was set before restart
  startActivityLoop() // resume the activity feed if one was set before restart
  startMirrorLoop()   // resume run mirroring if it was enabled before restart
  startOpsLoop()      // execute Discord ops Jarvis queues (archive/say/move)
})

client.on('error', err => console.error('Discord error:', err))

client.login(TOKEN)
