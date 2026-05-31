import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const PORT = 3333
const AGENT_MEMORY_ROOT = 'C:\\Users\\nirke\\OneDrive\\Documents\\agent-memory'
const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web-dev-projects.json')

const CORE_AGENTS = ['jarvis', 'kanadojo', 'aid-helpdesk', 'eshis-curriculum']

// In-memory event queue (last 50 webhook POSTs)
const eventQueue = []

function getMostRecentLog(agentName) {
  const agentDir = path.join(AGENT_MEMORY_ROOT, agentName)
  try {
    const files = fs.readdirSync(agentDir)
    const dateLogs = files
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
    if (dateLogs.length === 0) return null
    const latest = dateLogs[0]
    const content = fs.readFileSync(path.join(agentDir, latest), 'utf8')
    return { date: latest.replace('.md', ''), content }
  } catch {
    return null
  }
}

function readWebDevProjects() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
    return JSON.parse(raw).projects || []
  } catch {
    return []
  }
}

function respond(res, status, body) {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(json),
  })
  res.end(json)
}

const server = http.createServer((req, res) => {
  const { method, url } = req

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    return res.end()
  }

  // GET /api/agents — core agents only
  if (method === 'GET' && url === '/api/agents') {
    const result = {}
    for (const agent of CORE_AGENTS) {
      const log = getMostRecentLog(agent)
      if (log) result[agent] = log
    }
    return respond(res, 200, result)
  }

  // GET /api/web-dev — web dev projects from config
  if (method === 'GET' && url === '/api/web-dev') {
    const projects = readWebDevProjects()
    const result = projects.map(p => ({
      slug: p.slug,
      label: p.label,
      ...(getMostRecentLog(p.slug) || { date: null, content: '' }),
    }))
    return respond(res, 200, result)
  }

  // GET /api/events — drain event queue
  if (method === 'GET' && url === '/api/events') {
    const events = [...eventQueue]
    eventQueue.length = 0
    return respond(res, 200, events)
  }

  // POST /agent-update — webhook from agents
  if (method === 'POST' && url === '/agent-update') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      try {
        const payload = JSON.parse(body)
        const event = { ts: Date.now(), ...payload }
        eventQueue.push(event)
        if (eventQueue.length > 50) eventQueue.shift()
        console.log(`[webhook] ${payload.id} — ${payload.status}`)
        return respond(res, 200, { ok: true })
      } catch {
        return respond(res, 400, { error: 'Invalid JSON' })
      }
    })
    return
  }

  respond(res, 404, { error: 'Not found' })
})

server.listen(PORT, () => {
  console.log(`AI Command Center webhook server — http://localhost:${PORT}`)
  console.log(`Agent memory: ${AGENT_MEMORY_ROOT}`)
  console.log(`Web dev config: ${CONFIG_PATH}`)
})
