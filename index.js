// Agent HUD — Host half: DSH token aggregation (incremental session-log cache)
// plus the DeepSeek API balance, published over one read-only JSON route for
// the Client strip. Session/approval state is NOT tracked here: the Client
// reads it live from the framework's useSessionStatus() selector.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { decompressConcat } from './lib/zstd-frames.mjs'

export const inject = ['webServer', 'connection', 'credentials']

const DAY = 86_400_000
const HOUR = 3_600_000
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const BALANCE_TIMEOUT_MS = 8000
const BALANCE_STALE_MS = 300_000

export function apply(ctx, config = {}) {
  const cfg = {
    // Minimum interval between two DSH rescans (client polls every 2s while visible).
    dshMinMs: Math.max(500, Number(config.refreshMs) || 1500),
    // Hard floor between two balance API calls, whatever the client asks for.
    balanceMinIntervalMs: Math.max(1000, Number(config.balanceMinIntervalMs) || 15_000),
    dshHome: config.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    dshBudget: Math.max(1, Number(config.dshBudgetTokens24h) || 200_000_000),
    labelHarness: String(config.labelHarness || 'DeepSeek Harness'),
    labelBalance: String(config.labelBalance || 'DeepSeek'),
  }

  // ---- DSH token aggregation (incremental, per file) ----------------------

  // path -> { size, mtimeMs, entries: [[time,total,input,output,cache],...], seenAt }
  const fileCache = new Map()

  function freshStats() {
    return {
      available: true, tokens: 0, input: 0, output: 0, cache: 0, calls: 0, prev24h: 0,
      sessions: new Set(), buckets: new Array(24).fill(0),
    }
  }

  function addUsage(s, t, total, input, output, cache, sessionId, now, since, sub) {
    // A reset clips the rolling 24h window to the reset instant, so the panel
    // starts from zero and grows back into a normal 24h window.
    const floor = Math.max(now - DAY, since || 0)
    if (t >= floor && t <= now && total > 0) {
      s.tokens += total
      s.input += input
      s.output += output
      s.cache += cache
      s.calls++
      // Subagent sessions really spend tokens, but they are not a "session"
      // the user opened: keep them out of the session count.
      if (!sub) s.sessions.add(sessionId)
      const i = Math.min(23, Math.max(0, Math.floor((t - (now - DAY)) / HOUR)))
      s.buckets[i] += total
    } else if (!since && t >= now - 2 * DAY && t < now - DAY && total > 0) {
      s.prev24h += total
    }
  }

  function readEntries(f) {
    const text = decompressConcat(fs.readFileSync(f)).toString('utf8')
    const entries = []
    // Line 0 of a real log is the {"type":"session"...} header; delegated
    // children carry origin:"subagent" (and parentSession). No header, or a
    // plain one, means a user-opened session.
    let sub = false
    const head = (text.split('\n', 1)[0] || '').trim()
    if (head.charCodeAt(0) === 0x7b) {
      // starts with '{'
      try {
        const h = JSON.parse(head)
        if (h && h.type === 'session') sub = h.origin === 'subagent' || !!h.parentSession
      } catch {
        /* fall through: treat as a normal session */
      }
    }
    for (const line of text.split('\n')) {
      if (!line || line.indexOf('"assistant/message"') === -1) continue
      let d
      try {
        d = JSON.parse(line)
      } catch {
        continue
      }
      if (d.type !== 'assistant/message' || !d.data) continue
      const u = d.data.usage
      if (!u || !u.totalTokens) continue
      entries.push([d.time, u.totalTokens, u.inputTokens || 0, u.outputTokens || 0, u.cacheReadTokens || 0])
    }
    return { entries, sub }
  }

  function scanDsh(now, since) {
    const s = freshStats()
    const root = path.join(cfg.dshHome, 'sessions')
    let workspaces
    try {
      workspaces = fs.readdirSync(root)
    } catch {
      s.available = false
      return s
    }
    for (const w of workspaces) {
      let dirs
      try {
        dirs = fs.readdirSync(path.join(root, w))
      } catch {
        continue
      }
      for (const sd of dirs) {
        // Session dirs are `session-<uuid>` in current builds, but legacy
        // installs used bare uuids — the file stat check below filters the rest.
        // Subagent dirs are bare uuids too; they are told apart by the log
        // header, not the name (see readEntries).
        const f = path.join(root, w, sd, 'session.v4.jsonl.zstd')
        let st
        try {
          st = fs.statSync(f)
        } catch {
          continue
        }
        if (st.size === 0 || st.mtimeMs <= now - 2 * DAY) continue
        let rec = fileCache.get(f)
        if (!rec || rec.size !== st.size || rec.mtimeMs !== st.mtimeMs) {
          try {
            const parsed = readEntries(f)
            rec = { size: st.size, mtimeMs: st.mtimeMs, entries: parsed.entries, sub: parsed.sub }
          } catch {
            continue
          }
          fileCache.set(f, rec)
        }
        rec.seenAt = now
        for (const e of rec.entries) addUsage(s, e[0], e[1], e[2], e[3], e[4], sd, now, since, rec.sub)
      }
    }
    for (const [p, r] of fileCache) if (now - r.seenAt > 2 * DAY) fileCache.delete(p)
    return s
  }

  let dshCache = null
  let dshAt = 0
  let dshSince = 0

  function dshStats(now, since) {
    if (dshCache && since === dshSince && now - dshAt < cfg.dshMinMs) return dshCache
    dshCache = scanDsh(now, since)
    dshAt = now
    dshSince = since
    return dshCache
  }

  // ---- DeepSeek API balance ------------------------------------------------

  let balanceCache = null // { wallets, at }
  let balanceInFlight = null
  let lastBalanceError = null

  function pickWallets(infos) {
    if (!Array.isArray(infos)) return []
    return infos
      .filter((x) => x && x.total_balance !== undefined && Number.isFinite(Number(x.total_balance)))
      .map((x) => ({ currency: String(x.currency || 'CNY'), balance: String(x.total_balance) }))
  }

  async function fetchBalance() {
    let cred
    try {
      cred = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
    } catch (err) {
      return { error: 'no-key: ' + String((err && err.message) || err).slice(0, 120) }
    }
    if (!cred || !cred.value) return { error: 'no-key' }
    let res
    try {
      res = await fetch(BALANCE_URL, {
        headers: { Authorization: 'Bearer ' + cred.value, Accept: 'application/json' },
        signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
      })
    } catch (err) {
      return { error: 'network: ' + String((err && err.message) || err).slice(0, 120) }
    }
    if (!res.ok) return { error: 'http-' + res.status }
    let data
    try {
      data = await res.json()
    } catch {
      return { error: 'parse' }
    }
    const wallets = pickWallets(data && data.balance_infos)
    if (wallets.length === 0) return { error: 'shape' }
    return { wallets }
  }

  function fetchBalanceIntoCache() {
    if (balanceInFlight) return balanceInFlight
    balanceInFlight = fetchBalance()
      .then((r) => {
        if (r.wallets) {
          balanceCache = { wallets: r.wallets, at: Date.now() }
          lastBalanceError = null
          return balanceCache
        }
        lastBalanceError = r.error
        return balanceCache
          ? { ...balanceCache, stale: true, error: r.error }
          : { wallets: null, at: 0, error: r.error }
      })
      .finally(() => {
        balanceInFlight = null
      })
    return balanceInFlight
  }

  async function readBalance(force) {
    if (!balanceCache) return fetchBalanceIntoCache()
    const age = Date.now() - balanceCache.at
    if (force && age >= cfg.balanceMinIntervalMs) return fetchBalanceIntoCache()
    if (age > BALANCE_STALE_MS) return { ...balanceCache, stale: true }
    return balanceCache
  }

  // ---- snapshot ------------------------------------------------------------

  function packDsh(s, since) {
    return {
      id: 'dsh',
      label: cfg.labelHarness,
      kind: 'tokens',
      available: s.available,
      tokens24h: s.tokens,
      input24h: s.input,
      output24h: s.output,
      cache24h: s.cache,
      prev24h: s.prev24h,
      ratePerH: Math.round((s.buckets[21] + s.buckets[22] + s.buckets[23]) / 3),
      calls24h: s.calls,
      sessions24h: s.sessions.size,
      budget: cfg.dshBudget,
      buckets: s.buckets,
      // 0 = normal rolling 24h window; otherwise the client's reset instant.
      statsSince: since || 0,
    }
  }

  function packBalance(bal) {
    const OK = bal && Array.isArray(bal.wallets) && bal.wallets.length > 0
    return {
      id: 'deepseek',
      label: cfg.labelBalance,
      kind: 'balance',
      available: OK,
      balance: OK ? bal.wallets : null,
      balanceError: bal ? (bal.error || (OK ? null : lastBalanceError)) : lastBalanceError,
      stale: !!(bal && bal.stale),
      balanceAt: bal ? bal.at : 0,
    }
  }

  async function collect(forceBalance, since) {
    const now = Date.now()
    // A reset older than the rolling window no longer changes the stats.
    const activeSince = since && since > now - DAY ? since : 0
    const dsh = dshStats(now, activeSince)
    const bal = await readBalance(forceBalance)
    return {
      v: '0.3.0',
      updatedAt: now,
      agents: [packDsh(dsh, activeSince), packBalance(bal)],
    }
  }

  // ---- route ---------------------------------------------------------------

  // Same trust fence as the host's own routes: loopback/origin check plus the
  // login cookie, so /agent-hud/state.json is not readable by other local
  // pages. (Mirrors dsh-host-open-in-app / dsh-whale-widget.)
  function rejected(req, res) {
    try {
      const conn = (typeof ctx.get === 'function' ? ctx.get('connection') : undefined) || ctx.connection
      if (!conn || typeof conn.requestRejection !== 'function') {
        if (!rejected.warned) {
          rejected.warned = true
          console.warn('[agent-hud] connection fence unavailable; route serving unguarded')
        }
        return false
      }
      const code = conn.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return true
    } catch {
      return false
    }
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/agent-hud',
      handler: async (req, res) => {
        if (rejected(req, res)) return
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        if (req.method === 'GET' && url.pathname === '/agent-hud/state.json') {
          try {
            // ?refresh=1 asks for a balance refetch (subject to the floor);
            // without it the balance is served from cache so that turning the
            // client's auto-refresh off really means "no automatic refresh".
            // ?since=<ms> clips the token stats to that instant (stats reset).
            const sinceRaw = Number(url.searchParams.get('since'))
            const since = Number.isFinite(sinceRaw) && sinceRaw > 0
              ? Math.min(sinceRaw, Date.now())
              : 0
            const snap = await collect(url.searchParams.get('refresh') === '1', since)
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(JSON.stringify(snap))
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: String((err && err.message) || err) }))
          }
          return
        }
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
      },
    }),
  )
}
