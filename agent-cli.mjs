#!/usr/bin/env node
// agent-cli.mjs — let one agent delegate work to other agents through the
// AI Command Center, so a "lead" agent can fan tasks out to specialists.
//
// The Command Center server (server.js) must be running. Override its location
// with the ACC_URL env var (default http://localhost:3333). If the server has
// ACC_SECRET set, also export ACC_TOKEN.
//
// Usage:
//   node agent-cli.mjs list
//       → print the available agent names
//
//   node agent-cli.mjs run <agent> "<prompt>" [--model opus] [--effort high]
//       → run ONE agent, wait, print its output (one-shot, fresh session)
//
//   node agent-cli.mjs swarm '<json>'
//       → run MANY agents in parallel. <json> is an array of tasks:
//         [{"agent":"hoagies","prompt":"audit the homepage copy"},
//          {"agent":"vp-elite","prompt":"check the contact form","model":"haiku"}]
//       → prints each agent's output plus a total cost.
//
// Exit code is non-zero if any sub-run failed, so you can branch on it.

const SERVER = process.env.ACC_URL || 'http://localhost:3333'
const TOKEN  = process.env.ACC_TOKEN || null

function headers(extra = {}) {
  return TOKEN ? { ...extra, Authorization: `Bearer ${TOKEN}` } : extra
}
async function getJSON(path) {
  const r = await fetch(`${SERVER}${path}`, { headers: headers() })
  if (!r.ok) throw new Error(`${path} → ${r.status}`)
  return r.json()
}
async function postJSON(path, body) {
  const r = await fetch(`${SERVER}${path}`, {
    method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body),
  })
  if (!r.ok) {
    let msg = `${r.status}`
    try { msg = (await r.json()).error || msg } catch {}
    throw new Error(`${path} → ${msg}`)
  }
  return r.json()
}

// Pull --model / --effort / provider flags out of an argv slice.
//   --codex (or --provider codex) routes the run through OpenAI Codex instead of
//   Claude — use this to spread load when Claude usage is high.
function takeFlags(argv) {
  let model, effort, provider; const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--model' || a === '-m') { model = argv[++i]; continue }
    if (a === '--effort' || a === '-e') { effort = argv[++i]; continue }
    if (a === '--provider') { provider = argv[++i]; continue }
    if (a === '--codex') { provider = 'codex'; continue }
    if (a === '--claude') { provider = 'claude'; continue }
    rest.push(a)
  }
  return { model, effort, provider, rest }
}

const bar = '─'.repeat(60)

async function main() {
  const [cmd, ...argv] = process.argv.slice(2)

  if (cmd === 'list') {
    const agents = await getJSON('/agents')
    console.log(agents.join('\n'))
    return 0
  }

  if (cmd === 'run') {
    const { model, effort, provider, rest } = takeFlags(argv)
    const agent = rest.shift()
    const prompt = rest.join(' ')
    if (!agent || !prompt) { console.error('usage: run <agent> "<prompt>" [--model m] [--effort e] [--codex]'); return 2 }
    process.stderr.write(`▶ dispatching to ${agent}${provider === 'codex' ? ' [codex]' : model ? ` [${model}]` : ''}…\n`)
    const res = await postJSON('/dispatch', { agent, prompt, model, effort, provider, parent: process.env.ACC_PARENT || null })
    console.log(res.output)
    process.stderr.write(`\n✓ ${agent} done · $${(res.cost || 0).toFixed(4)} · exit ${res.exitCode}\n`)
    return res.exitCode === 0 ? 0 : 1
  }

  if (cmd === 'schedule') {
    // schedule every <min> <agent> "<prompt>"   — recurring
    // schedule in <min> <agent> "<prompt>"      — one-off, <min> from now
    const mode = argv.shift()
    const mins = parseInt(argv.shift(), 10)
    const { model, effort, provider, rest } = takeFlags(argv)
    const agent = rest.shift()
    const prompt = rest.join(' ')
    if ((mode !== 'every' && mode !== 'in') || !mins || !agent || !prompt) {
      console.error('usage: schedule every|in <minutes> <agent> "<prompt>" [--model m] [--codex]'); return 2
    }
    const body = mode === 'every'
      ? { type: 'agent', agent, prompt, model, effort, provider, everyMin: mins }
      : { type: 'agent', agent, prompt, model, effort, provider, runAt: Date.now() + mins * 60000 }
    const res = await postJSON('/schedule', body)
    console.log(`scheduled ${res.task.id}: ${mode} ${mins}m → ${agent}`)
    return 0
  }

  if (cmd === 'discord') {
    // discord archive <agent>      — move an agent's channel to the Archive category
    // discord unarchive <agent>    — move it back
    // discord say <channel> "<text>" — post a message to a channel (e.g. money)
    // discord move <channel> <category>
    const op = argv.shift()
    let body
    if (op === 'archive' || op === 'unarchive') body = { op, agent: argv.shift() }
    else if (op === 'say') { const channel = argv.shift(); body = { op, channel, text: argv.join(' ') } }
    else if (op === 'move') { const channel = argv.shift(); body = { op, channel, category: argv.join(' ') } }
    else { console.error('usage: discord archive|unarchive <agent> | say <channel> "<text>" | move <channel> <category>'); return 2 }
    const r = await postJSON('/discord-op', body)
    console.log(`queued discord op ${r.op.id} (${op})`)
    return 0
  }

  if (cmd === 'swarm') {
    let tasks
    try { tasks = JSON.parse(argv[0]) } catch { console.error('swarm: first arg must be a JSON array of tasks'); return 2 }
    if (!Array.isArray(tasks) || !tasks.length) { console.error('swarm: tasks array is empty'); return 2 }
    process.stderr.write(`🐝 swarm: running ${tasks.length} agents in parallel…\n`)
    const res = await postJSON('/swarm', { tasks, parent: process.env.ACC_PARENT || 'swarm' })
    let failed = 0
    for (const t of res.tasks) {
      console.log(`\n${bar}\n● ${t.agent}${t.error ? ` (ERROR: ${t.error})` : ''}\n${bar}`)
      console.log(t.output || '(no output)')
      if (t.exitCode !== 0) failed++
    }
    process.stderr.write(`\n🐝 swarm done · ${res.count} agents · $${(res.totalCost || 0).toFixed(4)} total${failed ? ` · ${failed} failed` : ''}\n`)
    return failed ? 1 : 0
  }

  console.error('commands: list | run <agent> "<prompt>" [--codex] | swarm \'<json>\' | schedule every|in <min> <agent> "<prompt>" | discord archive|say|move …')
  return 2
}

main().then(code => process.exit(code)).catch(e => { console.error('✗', e.message); process.exit(1) })
