import { useState, useEffect, useCallback } from 'react'

const CORE_AGENTS = ['jarvis', 'kanadojo', 'aid-helpdesk', 'eshis-curriculum']

const STATUS_COLORS = {
  'Complete':    { color: '#00ff41', border: 'pixel-border',      pulse: 'pulse-green' },
  'In Progress': { color: '#ffb000', border: 'pixel-border-amber', pulse: 'pulse-amber' },
  'Blocked':     { color: '#ff2222', border: 'pixel-border-red',   pulse: 'pulse-red'  },
  'No Data':     { color: '#335533', border: 'pixel-border',       pulse: ''           },
}

function parseStatus(content) {
  if (!content) return 'No Data'
  const match = content.match(/##\s*Status\s*\n+([^\n#]+)/i)
  if (!match) return 'No Data'
  const raw = match[1].trim().toLowerCase()
  if (raw.includes('complete')) return 'Complete'
  if (raw.includes('in progress')) return 'In Progress'
  if (raw.includes('blocked')) return 'Blocked'
  return 'No Data'
}

function parseFlags(content) {
  if (!content) return []
  const flagSection = content.match(/##\s*Flags for Lachy[^\n]*\n+([\s\S]*?)(?=\n##|\n---|\s*$)/i)
  if (!flagSection) return []
  return flagSection[1]
    .split('\n')
    .map(l => l.replace(/^[-*]\s*/, '').trim())
    .filter(l => l.length > 0 && l.toLowerCase() !== 'none')
}

function parseLastEntry(content) {
  if (!content) return ''
  const didSection = content.match(/##\s*What I did\s*\n+([\s\S]*?)(?=\n##|\n---|\s*$)/i)
  if (!didSection) return ''
  const lines = didSection[1]
    .split('\n')
    .map(l => l.replace(/^[-*]\s*/, '').trim())
    .filter(l => l.length > 0)
  return lines[lines.length - 1] || ''
}

function Led({ status }) {
  const cfg = STATUS_COLORS[status] || STATUS_COLORS['No Data']
  return (
    <span style={{
      display: 'inline-block',
      width: 10, height: 10,
      borderRadius: 0,
      background: cfg.color,
      animation: cfg.pulse ? `${cfg.pulse} 1.5s ease-in-out infinite` : 'none',
      flexShrink: 0,
    }} />
  )
}

function AgentCard({ name, label, date, content, compact }) {
  const status = parseStatus(content)
  const flags = parseFlags(content)
  const lastEntry = parseLastEntry(content)
  const cfg = STATUS_COLORS[status]

  return (
    <div className={cfg.border} style={{
      background: '#020f02',
      padding: compact ? '10px 12px' : '14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      position: 'relative',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Led status={status} />
        <span style={{ color: cfg.color, fontSize: compact ? 7 : 9, letterSpacing: 1, wordBreak: 'break-all' }}>
          {(label || name).toUpperCase()}
        </span>
      </div>

      <div style={{ color: '#335533', fontSize: 6 }}>
        {date ? `LAST LOG: ${date}` : 'NO LOG FOUND'}
      </div>

      <div style={{
        display: 'inline-block',
        border: `1px solid ${cfg.color}`,
        color: cfg.color,
        fontSize: 6,
        padding: '2px 5px',
        alignSelf: 'flex-start',
      }}>
        {status.toUpperCase()}
      </div>

      {lastEntry && (
        <div style={{ color: '#00a82b', fontSize: 7, lineHeight: 1.8, wordBreak: 'break-word' }}>
          &gt; {lastEntry.length > 120 ? lastEntry.slice(0, 120) + '…' : lastEntry}
        </div>
      )}

      {flags.length > 0 && (
        <div style={{ marginTop: 2 }}>
          {flags.map((f, i) => (
            <div key={i} style={{ color: '#ffb000', fontSize: 7, lineHeight: 1.8, wordBreak: 'break-word' }}>
              🚩 {f.length > 100 ? f.slice(0, 100) + '…' : f}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function WebDevGroup({ projects }) {
  const [open, setOpen] = useState(true)

  const anyBlocked  = projects.some(p => parseStatus(p.content) === 'Blocked')
  const anyProgress = projects.some(p => parseStatus(p.content) === 'In Progress')
  const groupStatus = anyBlocked ? 'Blocked' : anyProgress ? 'In Progress'
    : projects.every(p => parseStatus(p.content) === 'Complete') ? 'Complete' : 'No Data'
  const cfg = STATUS_COLORS[groupStatus]

  return (
    <div style={{ gridColumn: '1 / -1' }}>
      {/* Section header — clickable toggle */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '8px 0',
          width: '100%',
          marginBottom: open ? 12 : 0,
        }}
      >
        <span style={{ color: cfg.color, fontSize: 8, fontFamily: "'Press Start 2P', monospace" }}>
          {open ? '▼' : '▶'}
        </span>
        <Led status={groupStatus} />
        <span style={{ color: cfg.color, fontSize: 8, letterSpacing: 2, fontFamily: "'Press Start 2P', monospace" }}>
          WEB DEV CLIENTS
        </span>
        <span style={{ color: '#335533', fontSize: 7, fontFamily: "'Press Start 2P', monospace", marginLeft: 8 }}>
          [{projects.length}]
        </span>
      </button>

      {open && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: 12,
          paddingLeft: 16,
          borderLeft: `2px solid ${cfg.color}`,
        }}>
          {projects.length === 0 && (
            <div style={{ color: '#335533', fontSize: 7, fontFamily: "'Press Start 2P', monospace", padding: 8 }}>
              No projects configured — edit web-dev-projects.json
            </div>
          )}
          {projects.map(p => (
            <AgentCard
              key={p.slug}
              name={p.slug}
              label={p.label}
              date={p.date}
              content={p.content}
              compact
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ActivityLog({ entries }) {
  return (
    <div style={{
      border: '2px solid #00ff41',
      background: '#020f02',
      padding: 12,
      height: 180,
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    }}>
      <div style={{ color: '#00ff41', fontSize: 8, marginBottom: 6, letterSpacing: 2 }}>
        ▶ ACTIVITY LOG
      </div>
      {entries.length === 0 && (
        <div style={{ color: '#335533', fontSize: 7 }}>Awaiting webhook events...</div>
      )}
      {entries.map((e, i) => (
        <div key={i} style={{ fontSize: 7, color: '#00a82b', lineHeight: 1.8 }}>
          <span style={{ color: '#335533' }}>[{e.time}]</span>{' '}
          <span style={{ color: '#00ff41' }}>{e.agent}</span>{' '}
          {e.message}
        </div>
      ))}
    </div>
  )
}

export default function App() {
  const [agents, setAgents] = useState(() =>
    CORE_AGENTS.map(name => ({ name, date: null, content: '', loading: true }))
  )
  const [webDevProjects, setWebDevProjects] = useState([])
  const [log, setLog] = useState([])
  const [lastRefresh, setLastRefresh] = useState(null)
  const [tick, setTick] = useState(0)

  const fetchAll = useCallback(async () => {
    const [agentRes, webRes] = await Promise.allSettled([
      fetch('/api/agents'),
      fetch('/api/web-dev'),
    ])

    if (agentRes.status === 'fulfilled' && agentRes.value.ok) {
      const data = await agentRes.value.json()
      setAgents(CORE_AGENTS.map(name => ({
        name,
        date: data[name]?.date || null,
        content: data[name]?.content || '',
        loading: false,
      })))
    } else {
      setAgents(prev => prev.map(a => ({ ...a, loading: false })))
    }

    if (webRes.status === 'fulfilled' && webRes.value.ok) {
      setWebDevProjects(await webRes.value.json())
    }

    setLastRefresh(new Date().toLocaleTimeString())
  }, [])

  const pollEvents = useCallback(async () => {
    try {
      const res = await fetch('/api/events')
      if (!res.ok) return
      const events = await res.json()
      if (events.length > 0) {
        setLog(prev => [
          ...events.map(e => ({
            time: new Date(e.ts).toLocaleTimeString(),
            agent: e.id,
            message: (e.log || e.status || '').slice(0, 80),
          })),
          ...prev,
        ].slice(0, 50))
        fetchAll()
      }
    } catch { /* server offline */ }
  }, [fetchAll])

  useEffect(() => {
    fetchAll()
    const r = setInterval(fetchAll, 60_000)
    const e = setInterval(pollEvents, 5_000)
    const t = setInterval(() => setTick(n => n + 1), 1000)
    return () => { clearInterval(r); clearInterval(e); clearInterval(t) }
  }, [fetchAll, pollEvents])

  const allCards = [
    ...agents.map(a => parseStatus(a.content)),
    ...webDevProjects.map(p => parseStatus(p.content)),
  ]
  const completeCount  = allCards.filter(s => s === 'Complete').length
  const progressCount  = allCards.filter(s => s === 'In Progress').length
  const blockedCount   = allCards.filter(s => s === 'Blocked').length
  const cursor = tick % 2 === 0 ? '█' : ' '

  return (
    <div style={{ minHeight: '100vh', padding: 20, fontFamily: "'Press Start 2P', monospace" }}>
      {/* Header */}
      <div style={{ marginBottom: 24, borderBottom: '2px solid #00ff41', paddingBottom: 16 }}>
        <div style={{ fontSize: 14, color: '#00ff41', letterSpacing: 3, marginBottom: 8 }}>
          ██ AI COMMAND CENTER {cursor}
        </div>
        <div style={{ fontSize: 7, color: '#335533', display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 8 }}>
          <span>AGENTS: {CORE_AGENTS.length + webDevProjects.length}</span>
          <span style={{ color: '#00ff41' }}>DONE: {completeCount}</span>
          <span style={{ color: '#ffb000' }}>RUNNING: {progressCount}</span>
          <span style={{ color: '#ff2222' }}>BLOCKED: {blockedCount}</span>
          {lastRefresh && <span>LAST SYNC: {lastRefresh}</span>}
        </div>
      </div>

      {/* Core agent grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        gap: 16,
        marginBottom: 24,
        alignItems: 'start',
      }}>
        {agents.map(a => (
          <AgentCard key={a.name} name={a.name} date={a.date} content={a.content} />
        ))}

        {/* Web dev group spans full width */}
        <WebDevGroup projects={webDevProjects} />
      </div>

      <ActivityLog entries={log} />

      <div style={{ marginTop: 12, fontSize: 6, color: '#1a3d1a', textAlign: 'center' }}>
        WEBHOOK: localhost:3333 | REFRESH: 60s | EVENTS: 5s | EDIT web-dev-projects.json TO ADD CLIENTS
      </div>
    </div>
  )
}
