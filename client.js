// Agent HUD — Client half: a screen-edge strip inside the DSH web page.
// Renders one chip per agent from /agent-hud/state.json: the DSH token ring
// (DeepSeek Harness, polled every 2s), the DeepSeek API balance (polled on
// its own schedule with ?refresh=1), and the current DeepSeek peak/off-peak
// price period with a live countdown (computed locally), plus live session
// notices (approval / question / running / unread) read from the framework's
// useSessionStatus() slot prop. Approvals use the same PendingApproval object
// as the conversation card, so both views stay in sync automatically.
window.__ModuleLoader__.load({
  id: '@local/agent-hud',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const NS = '@local/agent-hud'
    const POS_KEY = 'agent-hud.pos.v1'
    const BAL_KEY = 'agent-hud.balance.v1'
    const WARN_KEY = 'agent-hud.warn.v1'
    const RESET_KEY = 'agent-hud.reset.v1'
    const DSH_POLL_MS = 2000

    // DeepSeek API peak/off-peak rule, per the official pricing page (checked
    // 2026-10-20): peak is Beijing Mon–Fri 09:00–12:00 and 14:00–18:00,
    // excluding Chinese statutory holidays; everything else (weekends and
    // holidays all day) is off-peak at 50% of the peak price. China has no
    // DST, so the fixed +08:00 offset is enough — no timezone library needed.
    const BJ_OFFSET_MS = 8 * 3_600_000
    const PRICE_DAY_MS = 86_400_000
    const PEAK_WINDOWS = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]]
    const PRICE_CAL_YEAR = 2026
    const HOLIDAYS_2026 = new Set([
      '2026-01-01', '2026-01-02', // 元旦
      '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23', // 春节
      '2026-04-06', // 清明
      '2026-05-01', '2026-05-04', '2026-05-05', // 劳动节
      '2026-06-19', // 端午
      '2026-09-25', // 中秋
      '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', // 国庆
    ])

    const CSS = `
.ahud-chip{display:flex;align-items:center;gap:5px;padding:2px 6px;border-radius:8px;cursor:pointer}
.ahud-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ahud-name{font-weight:600;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ahud-val{font-size:12px;color:var(--dsw-alias-label-primary);white-space:nowrap}
.ahud-hoverline{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ahud-panel{pointer-events:auto;flex:0 0 auto;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.18);padding:8px 10px;font-size:12px;color:var(--dsw-alias-label-primary);max-width:280px}
.ahud-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.ahud-big{font-size:15px;font-weight:600}
.ahud-x{margin-left:auto;cursor:pointer;color:var(--dsw-alias-label-tertiary);padding:0 4px}
.ahud-track{height:6px;border-radius:3px;background:var(--dsw-alias-border-l2);overflow:hidden;margin:2px 0 6px}
.ahud-fill{height:100%;border-radius:3px}
.ahud-row{display:flex;gap:10px;justify-content:space-between;padding:1px 0;color:var(--dsw-alias-label-secondary)}
.ahud-row b{font-weight:500;color:var(--dsw-alias-label-primary)}
.ahud-item{display:flex;align-items:center;gap:6px;padding:3px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.ahud-item .nm{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ahud-kd{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ahud-err{color:var(--dsw-alias-state-error-primary);font-size:11px;padding-top:2px}
.ahud-ctl{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:6px;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.ahud-lbl{display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap}
.ahud-num{width:56px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);padding:1px 4px;font-size:11px}
.ahud-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:1px 7px;font-size:11px;cursor:pointer}
.ahud-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ahud-btn:disabled{opacity:.5;cursor:default}
.ahud-btn.ok{color:var(--dsw-alias-state-success-primary)}
.ahud-btn.deny{color:var(--dsw-alias-state-error-primary)}
.ahud-price .ahud-name{font-variant-numeric:tabular-nums}
.ahud-count{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.ahud-rule{padding:3px 0;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);line-height:1.5}
.ahud-rule b{font-weight:600;color:var(--dsw-alias-label-primary);margin-right:4px}
.ahud-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-state-success-primary);animation:ahudpulse 1.2s ease-in-out infinite}
.ahud-dot.st{animation:none}
@keyframes ahudpulse{50%{opacity:.35}}
`

    const DICT = {
      zh: {
        rate: '速率', calls: '调用', sessions: '会话', prev24: '前24h', inOut: '输入/输出',
        cache: '缓存读取',
        budget: '预算', balance: '余额', used: '已用', approve: '同意', deny: '不同意',
        jump: '打开', none: '没有需要处理的会话', notices: '会话动态', approval: '待批准',
        wait: '待处理', unread: '有回复', running: '运行中', unavailable: '无数据', perH: '/时',
        wallets: '钱包', updated: '更新于', warnOn: '低余额预警', yuan: '元',
        stale: '暂用上次数据', apiError: '错误', source: '来源',
        autoRefresh: '自动刷新', seconds: '秒', refreshNow: '立即刷新', refreshing: '刷新中…',
        resetStats: '重置统计', resetClear: '恢复 24h', since: '统计自',
        resetNeedsHost: '重启 DSH 后生效',
        pricing: '价格时段', peak: '峰时', offPeak: '谷时', fullPrice: '原价', halfPrice: '5 折',
        remaining: '剩余', toSwitch: '后切换', nextSwitch: '下次切换（本地时间）',
        peakWindow: '工作日 09:00–12:00、14:00–18:00（北京时间）',
        offPeakWindow: '其余时间（含周末、节假日）· 5 折',
        calendarNote: '节假日按 2026 年日历；其他年份按工作日估算',
        priceSource: 'DeepSeek 官方价格页',
      },
      en: {
        rate: 'rate', calls: 'calls', sessions: 'sessions', prev24: 'prev 24h', inOut: 'in/out',
        cache: 'cache read',
        budget: 'budget', balance: 'balance', used: 'used', approve: 'Allow', deny: 'Deny',
        jump: 'Open', none: 'Nothing waiting', notices: 'Sessions', approval: 'approval',
        wait: 'question', unread: 'reply', running: 'running', unavailable: 'no data', perH: '/h',
        wallets: 'wallets', updated: 'updated', warnOn: 'low balance alert', yuan: 'CNY',
        stale: 'showing last known', apiError: 'error', source: 'source',
        autoRefresh: 'auto refresh', seconds: 's', refreshNow: 'Refresh now', refreshing: 'refreshing…',
        resetStats: 'Reset stats', resetClear: 'Restore 24h', since: 'counting since',
        resetNeedsHost: 'restart DSH to enable',
        pricing: 'Pricing', peak: 'Peak', offPeak: 'Off-peak', fullPrice: 'full price', halfPrice: '50% off',
        remaining: 'remaining', toSwitch: 'to switch', nextSwitch: 'next switch (local)',
        peakWindow: 'Mon–Fri 09:00–12:00, 14:00–18:00 (Beijing)',
        offPeakWindow: 'all other times (weekends & holidays) · 50% off',
        calendarNote: 'Holidays per the 2026 calendar; other years assume weekdays',
        priceSource: 'DeepSeek official pricing',
      },
    }

    function clampSecs(v) {
      return Math.min(3600, Math.max(15, Math.round(v)))
    }

    function loadPos() {
      try {
        const p = JSON.parse(localStorage.getItem(POS_KEY))
        if (p && ['top', 'bottom', 'left', 'right'].includes(p.edge) && typeof p.off === 'number') return p
      } catch {}
      return { edge: 'top', off: 0.5 }
    }

    function loadBalCfg() {
      try {
        const c = JSON.parse(localStorage.getItem(BAL_KEY))
        if (c && typeof c.auto === 'boolean' && Number.isFinite(c.seconds)) {
          return { auto: c.auto, seconds: clampSecs(c.seconds) }
        }
      } catch {}
      return { auto: true, seconds: 90 }
    }

    function loadWarnCfg() {
      try {
        const c = JSON.parse(localStorage.getItem(WARN_KEY))
        if (c && typeof c.on === 'boolean' && Number.isFinite(c.amount)) {
          return { on: c.on, amount: Math.max(0, Math.round(c.amount * 100) / 100) }
        }
      } catch {}
      return { on: true, amount: 20 }
    }

    function loadReset() {
      try {
        const at = Number(localStorage.getItem(RESET_KEY))
        if (Number.isFinite(at) && at > 0) return Math.min(at, Date.now())
      } catch {}
      return 0
    }

    function fmtTok(n) {
      if (!Number.isFinite(n) || n <= 0) return '0'
      if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
      if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
      return String(Math.round(n))
    }

    function moneyText(w) {
      if (!w) return null
      const sym = w.currency === 'CNY' ? '¥' : w.currency === 'USD' ? '$' : w.currency + ' '
      return sym + Number(w.balance).toFixed(2)
    }

    function fmtBalance(arr) {
      if (!arr || !arr.length) return null
      return arr.map(moneyText).join(' · ')
    }

    function pickPrimary(a) {
      const arr = Array.isArray(a.balance) ? a.balance : []
      const num = (w) => Number(w.balance)
      return (
        arr.find((w) => w.currency === 'CNY' && num(w) > 0) ||
        arr.find((w) => num(w) > 0) ||
        arr.find((w) => w.currency === 'CNY') ||
        arr[0] || null
      )
    }

    function fmtTime(at) {
      if (!at) return '—'
      try {
        return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      } catch {
        return '—'
      }
    }

    function pad2(n) {
      return n < 10 ? '0' + n : String(n)
    }

    // Beijing wall clock for an instant, plus the instant of that day's 00:00.
    function bjClock(ms) {
      const d = new Date(ms + BJ_OFFSET_MS)
      const year = d.getUTCFullYear()
      const month = d.getUTCMonth() + 1
      const day = d.getUTCDate()
      return {
        year,
        weekday: d.getUTCDay(), // 0 = Sunday
        minute: d.getUTCHours() * 60 + d.getUTCMinutes(),
        dateKey: year + '-' + pad2(month) + '-' + pad2(day),
        dayStartMs: Date.UTC(year, month - 1, day) - BJ_OFFSET_MS,
      }
    }

    function isPeakParts(p) {
      if (p.weekday === 0 || p.weekday === 6) return false
      if (p.year === PRICE_CAL_YEAR && HOLIDAYS_2026.has(p.dateKey)) return false
      return PEAK_WINDOWS.some(([start, end]) => p.minute >= start && p.minute < end)
    }

    function isPeakAt(ms) {
      return isPeakParts(bjClock(ms))
    }

    // Period, countdown to the next flip, and whether the holiday calendar
    // covers the current year. Windows are half-open, so a boundary already
    // belongs to the new period.
    function pricingAt(ms) {
      const p = bjClock(ms)
      const peak = isPeakParts(p)
      let next = null
      // A long holiday can push the next flip more than a week out; 12 days
      // covers the National Day block plus its surrounding weekend.
      for (let day = 0; day < 12 && next === null; day++) {
        for (const [start, end] of PEAK_WINDOWS) {
          for (const minute of [start, end]) {
            const at = p.dayStartMs + day * PRICE_DAY_MS + minute * 60_000
            if (at > ms && isPeakAt(at) !== peak) {
              next = at
              break
            }
          }
          if (next !== null) break
        }
      }
      return {
        peak,
        next,
        left: next === null ? 0 : Math.max(0, next - ms),
        covered: p.year === PRICE_CAL_YEAR,
      }
    }

    function fmtCountdown(ms) {
      const total = Math.max(0, Math.ceil(ms / 1000))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      return hours > 0
        ? hours + ':' + pad2(minutes) + ':' + pad2(seconds)
        : minutes + ':' + pad2(seconds)
    }

    // Switch time in the viewer's own clock (the schedule itself is Beijing).
    function fmtSwitch(at) {
      if (!at) return '—'
      const d = new Date(at)
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    }

    function tokenRing(a) {
      const pct = a.budget > 0 ? Math.min(1, a.tokens24h / a.budget) : 0
      const color =
        pct >= 0.9
          ? 'var(--dsw-alias-state-error-primary)'
          : pct >= 0.7
            ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-state-success-primary)'
      return { fill: pct, color, dot: a.available ? color : 'var(--dsw-alias-border-l4)' }
    }

    function balanceRing(a, warn) {
      const w = pickPrimary(a)
      const amount = w ? Number(w.balance) : 0
      const on = !!(warn && warn.on)
      const threshold = warn ? Number(warn.amount) || 0 : 0
      const low = on && amount < threshold
      const fill = !a.available ? 0 : !on || threshold <= 0 ? 1 : Math.min(1, Math.max(0, amount / threshold))
      const color = !a.available
        ? 'var(--dsw-alias-border-l4)'
        : low
          ? 'var(--dsw-alias-state-error-primary)'
          : 'var(--dsw-alias-state-success-primary)'
      return { fill, color, dot: color }
    }

    function Ring(a, warn) {
      const ring = a.kind === 'balance' ? balanceRing(a, warn) : tokenRing(a)
      const r = 10
      const c = 2 * Math.PI * r
      return h('svg', { width: 24, height: 24, viewBox: '0 0 24 24', 'aria-hidden': true, style: { flex: '0 0 auto' } },
        h('circle', { cx: 12, cy: 12, r, fill: 'none', stroke: 'var(--dsw-alias-border-l2)', 'stroke-width': 3 }),
        h('circle', {
          cx: 12, cy: 12, r, fill: 'none', stroke: ring.color, 'stroke-width': 3,
          'stroke-linecap': 'round', 'stroke-dasharray': (c * ring.fill).toFixed(1) + ' ' + c.toFixed(1),
          transform: 'rotate(-90 12 12)',
        }),
        h('circle', { cx: 12, cy: 12, r: 4, fill: ring.dot, opacity: 0.25 }))
    }

    function Spark(a) {
      const max = Math.max(1, ...a.buckets)
      return h('svg', { width: 240, height: 34, 'aria-hidden': true, style: { display: 'block', margin: '4px 0' } },
        a.buckets.map((v, i) =>
          h('rect', {
            key: i, x: i * 10 + 1, width: 8,
            height: Math.max(1.5, (v / max) * 30), y: 32 - Math.max(1.5, (v / max) * 30),
            rx: 1.5, fill: 'var(--dsw-alias-brand-primary)',
          })))
    }

    function Hud({ ctx, t, ...props }) {
      const [snap, setSnap] = useState(null)
      const [pos, setPos] = useState(loadPos)
      const [hover, setHover] = useState(null)
      const [openPanels, setOpenPanels] = useState([])
      const [balCfg, setBalCfg] = useState(loadBalCfg)
      const [warnCfg, setWarnCfg] = useState(loadWarnCfg)
      const [busy, setBusy] = useState(false)
      const [now, setNow] = useState(() => Date.now())
      const [resetAt, setResetAt] = useState(loadReset)
      const drag = useRef(null)
      const useStatus = props.useSessionStatus
      // Official callers always pass an explicit selector (the zero-arg path
      // hands an undefined selector to the external-store shim); identity
      // selectors keep snapshot references stable between changes.
      const list = props.useSessions ? props.useSessions((s) => s) : null
      const status = useStatus ? useStatus((m) => m) : null

      const applySnap = (j) => {
        if (j && Array.isArray(j.agents)) setSnap(j)
      }

      // Every snapshot request carries the reset instant, so a balance poll
      // cannot overwrite the clipped token stats with an unclipped copy.
      const apiUrl = (refresh, since = resetAt) => {
        const q = new URLSearchParams()
        if (refresh) q.set('refresh', '1')
        if (since) q.set('since', String(since))
        const qs = q.toString()
        return '/agent-hud/state.json' + (qs ? '?' + qs : '')
      }

      // DSH: real-time polling, paused while the page is hidden.
      useEffect(() => {
        let alive = true
        const tick = async () => {
          if (document.visibilityState === 'hidden') return
          try {
            const r = await fetch(apiUrl(false), { cache: 'no-store' })
            if (!r.ok) throw new Error(String(r.status))
            const j = await r.json()
            if (alive) applySnap(j)
          } catch {
            /* keep the last snapshot */
          }
        }
        tick()
        const id = setInterval(tick, DSH_POLL_MS)
        const onVis = () => {
          if (document.visibilityState === 'visible') tick()
        }
        document.addEventListener('visibilitychange', onVis)
        return () => {
          alive = false
          clearInterval(id)
          document.removeEventListener('visibilitychange', onVis)
        }
      }, [resetAt])

      // Balance: forced refetch on the user's own schedule (and only then).
      useEffect(() => {
        if (!balCfg.auto) return undefined
        let alive = true
        const tick = async () => {
          try {
            const r = await fetch(apiUrl(true), { cache: 'no-store' })
            if (!r.ok) throw new Error(String(r.status))
            const j = await r.json()
            if (alive) applySnap(j)
          } catch {
            /* keep the last snapshot */
          }
        }
        const id = setInterval(tick, clampSecs(balCfg.seconds) * 1000)
        return () => {
          alive = false
          clearInterval(id)
        }
      }, [balCfg.auto, balCfg.seconds, resetAt])

      useEffect(() => {
        try {
          localStorage.setItem(POS_KEY, JSON.stringify(pos))
        } catch {}
      }, [pos])

      useEffect(() => {
        try {
          localStorage.setItem(WARN_KEY, JSON.stringify(warnCfg))
        } catch {}
      }, [warnCfg])

      useEffect(() => {
        try {
          localStorage.setItem(BAL_KEY, JSON.stringify(balCfg))
        } catch {}
      }, [balCfg])

      useEffect(() => {
        try {
          if (resetAt) localStorage.setItem(RESET_KEY, String(resetAt))
          else localStorage.removeItem(RESET_KEY)
        } catch {}
      }, [resetAt])

      // One-second clock for the price-period countdown; resync on return.
      useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000)
        const onVis = () => setNow(Date.now())
        document.addEventListener('visibilitychange', onVis)
        return () => {
          clearInterval(id)
          document.removeEventListener('visibilitychange', onVis)
        }
      }, [])

      useEffect(() => {
        if (!useStatus) console.warn('[agent-hud] useSessionStatus unavailable; notices hidden')
      }, [useStatus])

      if (!snap || !Array.isArray(snap.agents)) return [h('style', { key: 's' }, CSS)]

      let curUuid = null
      try {
        const m = (location.pathname + location.search + location.hash)
          .match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
        if (m) curUuid = m[0]
      } catch {}

      const notices = []
      // Subagent sessions are framework plumbing, not conversations to attend:
      // keep them out of the bell entirely (approvals included). Prefer the
      // list metadata; fall back to id shape (subagents are bare uuids, user
      // sessions are `session-<uuid>`) when the row has not arrived yet.
      function isSubagent(sid) {
        try {
          const row = list && list.byId ? list.byId[sid] : null
          if (row && (row.origin === 'subagent' || row.parentSessionId)) return true
          if (row) return false
        } catch {}
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(sid))
      }
      if (status && typeof status.forEach === 'function') {
        status.forEach((st, sid) => {
          if (curUuid && sid.includes(curUuid)) return
          if (isSubagent(sid)) return
          const pi = st.pendingInteraction
          if (pi && pi.kind === 'approval') notices.push({ sid, kind: 'approval', pi })
          else if (pi) notices.push({ sid, kind: 'wait', pi })
          else if (st.running) notices.push({ sid, kind: 'running' })
          else if (st.completionUnread) notices.push({ sid, kind: 'unread' })
        })
        const rank = { approval: 0, wait: 1, unread: 2, running: 3 }
        notices.sort((x, y) => rank[x.kind] - rank[y.kind])
      }
      const alertCount = notices.filter((n) => n.kind !== 'running').length
      const pricing = pricingAt(now)

      function titleOf(sid) {
        try {
          const pj = list && list.projectionsBySession && list.projectionsBySession[sid]
          const src = pj && pj.values ? pj.values : pj
          const tt = src && (src.title || (src.sessionTitle && src.sessionTitle.title))
          const name = tt && (tt.title || tt)
          if (typeof name === 'string' && name) return name
        } catch {}
        try {
          const row = list && list.byId && list.byId[sid]
          if (row && row.title) return row.title
        } catch {}
        return sid.replace('session-', '').slice(0, 8)
      }

      const jump = (sid) => {
        try {
          ctx.uiWorkspace.openSession(sid)
        } catch (e) {
          console.warn('[agent-hud] openSession failed', e)
        }
      }
      const answer = (pi, outcome) => {
        try {
          const r = pi.answer(outcome)
          if (r && r.catch) r.catch((e) => console.warn('[agent-hud] answer failed', e))
        } catch (e) {
          console.warn('[agent-hud] answer failed', e)
        }
      }

      const togglePanel = (id) => {
        setOpenPanels((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]))
      }
      const closePanel = (id) => {
        setOpenPanels((list) => list.filter((x) => x !== id))
      }
      const refreshNow = async () => {
        setBusy(true)
        try {
          const r = await fetch(apiUrl(true), { cache: 'no-store' })
          if (r.ok) applySnap(await r.json())
        } catch {
          /* keep the last snapshot */
        } finally {
          setBusy(false)
        }
      }

      const resetStats = async () => {
        const at = Date.now()
        setResetAt(at)
        try {
          const r = await fetch(apiUrl(true, at), { cache: 'no-store' })
          if (r.ok) applySnap(await r.json())
        } catch {
          /* keep the last snapshot */
        }
      }

      const clearReset = async () => {
        setResetAt(0)
        try {
          const r = await fetch(apiUrl(true, 0), { cache: 'no-store' })
          if (r.ok) applySnap(await r.json())
        } catch {
          /* keep the last snapshot */
        }
      }

      // --- drag to any edge ---
      const onDown = (e) => {
        if (e.button !== 0) return
        if (e.target.closest && e.target.closest('.ahud-nodrag')) return
        drag.current = e.pointerId
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {}
      }
      const onMove = (e) => {
        if (drag.current !== e.pointerId) return
        const vw = window.innerWidth
        const vh = window.innerHeight
        const d = [e.clientY, vh - e.clientY, e.clientX, vw - e.clientX]
        const m = Math.min(...d)
        const edge = m === d[0] ? 'top' : m === d[1] ? 'bottom' : m === d[2] ? 'left' : 'right'
        let off = edge === 'left' || edge === 'right' ? e.clientY / vh : e.clientX / vw
        off = Math.min(0.95, Math.max(0.05, off))
        setPos((p) => (p.edge === edge && Math.abs(p.off - off) < 0.004 ? p : { edge, off }))
      }
      const onUp = (e) => {
        if (drag.current === e.pointerId) drag.current = null
      }

      // --- layout anchors ---
      const horiz = pos.edge === 'top' || pos.edge === 'bottom'
      const outer = {
        position: 'fixed', display: 'flex', alignItems: 'flex-start',
        pointerEvents: 'none', zIndex: 9000, flexDirection: 'column',
      }
      if (pos.edge === 'top') {
        outer.top = 4; outer.left = pos.off * 100 + '%'; outer.transform = 'translateX(-50%)'
      } else if (pos.edge === 'bottom') {
        outer.bottom = 4; outer.left = pos.off * 100 + '%'; outer.transform = 'translateX(-50%)'
      } else if (pos.edge === 'left') {
        outer.left = 4; outer.top = pos.off * 100 + '%'; outer.transform = 'translateY(-50%)'
      } else {
        outer.right = 4; outer.top = pos.off * 100 + '%'; outer.transform = 'translateY(-50%)'
      }
      // Panels are absolutely anchored to the bar so their width never shifts
      // the bar's centering; they start at the bar's left edge and run right.
      // The containing block is the bar-sized wrapper, so an absolute flex row
      // defaults to that narrow width and squeezes the panels into wrapping
      // columns. max-content plus non-shrinking panels keeps them full width.
      const panelsStyle = { position: 'absolute', display: 'flex', gap: 6, width: 'max-content', alignItems: 'flex-start' }
      if (pos.edge === 'top') {
        panelsStyle.top = '100%'; panelsStyle.left = 0; panelsStyle.paddingTop = 4; panelsStyle.flexDirection = 'row'
      } else if (pos.edge === 'bottom') {
        panelsStyle.bottom = '100%'; panelsStyle.left = 0; panelsStyle.paddingBottom = 4; panelsStyle.flexDirection = 'row'
      } else if (pos.edge === 'left') {
        panelsStyle.left = '100%'; panelsStyle.top = 0; panelsStyle.paddingLeft = 6; panelsStyle.flexDirection = 'column'
      } else {
        panelsStyle.right = '100%'; panelsStyle.top = 0; panelsStyle.paddingRight = 6; panelsStyle.flexDirection = 'column'
      }
      const bar = {
        display: 'flex', flexDirection: horiz ? 'row' : 'column', alignItems: 'center',
        gap: 6, padding: '3px 8px', borderRadius: 12, pointerEvents: 'auto', cursor: 'grab',
        background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)',
        boxShadow: '0 2px 12px rgba(0,0,0,.16)', fontSize: 12, lineHeight: 1.35,
        color: 'var(--dsw-alias-label-primary)',
      }

      const chipValue = (a) => {
        if (a.kind === 'balance') {
          if (!a.available) return '—'
          return moneyText(pickPrimary(a)) || '—'
        }
        return a.available ? fmtTok(a.tokens24h) : t('unavailable')
      }

      const hoverline = (a) => {
        if (a.kind === 'balance') {
          const parts = []
          const all = fmtBalance(a.balance)
          if (all) parts.push(all)
          if (a.balanceAt) parts.push(t('updated') + ' ' + fmtTime(a.balanceAt))
          if (a.balanceError) parts.push(t('apiError') + ': ' + String(a.balanceError).slice(0, 40))
          return parts.join(' · ') || t('unavailable')
        }
        return [fmtTok(a.ratePerH) + t('perH'), a.calls24h + ' ' + t('calls'), a.sessions24h + ' ' + t('sessions')].join(' · ')
      }

      const agentChip = (a) => {
        const showing = openPanels.includes(a.id)
        return h('div', {
          className: 'ahud-chip ahud-nodrag', key: a.id,
          onMouseEnter: () => setHover(a.id), onMouseLeave: () => setHover(null),
          onClick: () => togglePanel(a.id),
        },
          Ring(a, warnCfg),
          h('span', { className: 'ahud-name' }, a.label),
          h('span', { className: 'ahud-val' }, chipValue(a)),
          !showing && hover === a.id ? h('span', { className: 'ahud-hoverline' }, hoverline(a)) : null)
      }

      const panelHead = (a, subtitle) => h('div', { className: 'ahud-head' },
        h('span', { className: 'ahud-big' }, a.label),
        h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, subtitle),
        h('span', {
          className: 'ahud-x',
          onClick: (e) => {
            e.stopPropagation()
            closePanel(a.id)
          },
        }, '×'))

      const tokenPanel = (a) => {
        const pct = a.budget > 0 ? Math.min(1, a.tokens24h / a.budget) : 0
        const ring = tokenRing(a)
        const row = (k, v) => h('div', { className: 'ahud-row', key: k }, h('span', null, k), h('b', null, v))
        const resetSupported = Object.prototype.hasOwnProperty.call(a, 'statsSince')
        const resetActive = resetSupported && resetAt > 0 && now - resetAt < PRICE_DAY_MS
        return h('div', { className: 'ahud-panel ahud-nodrag', key: 'p-' + a.id },
          panelHead(a, fmtTok(a.tokens24h) + ' / 24h'),
          h('div', { className: 'ahud-track' }, h('div', {
            className: 'ahud-fill',
            style: { width: (pct * 100).toFixed(1) + '%', background: ring.color },
          })),
          h('div', { className: 'ahud-row' },
            h('span', null, t('used') + ' ' + (pct * 100).toFixed(0) + '%'),
            h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, t('budget') + ' ' + fmtTok(a.budget))),
          row(t('rate'), fmtTok(a.ratePerH) + t('perH')),
          row(t('prev24'), fmtTok(a.prev24h)),
          row(t('calls'), String(a.calls24h)),
          row(t('sessions'), String(a.sessions24h)),
          row(t('inOut'), fmtTok(a.input24h) + ' / ' + fmtTok(a.output24h)),
          row(t('cache'), fmtTok(a.cache24h || 0)),
          Spark(a),
          h('div', { className: 'ahud-ctl' },
            h('button', {
              className: 'ahud-btn',
              disabled: !resetSupported,
              title: resetSupported ? undefined : t('resetNeedsHost'),
              onClick: resetStats,
            }, t('resetStats')),
            resetActive ? h('button', { className: 'ahud-btn', onClick: clearReset }, t('resetClear')) : null,
            resetActive ? h('span', { className: 'ahud-kd' }, t('since') + ' ' + fmtTime(resetAt)) : null,
            resetSupported ? null : h('span', { className: 'ahud-kd' }, t('resetNeedsHost'))))
      }

      const balancePanel = (a) => {
        const row = (k, v) => h('div', { className: 'ahud-row', key: k }, h('span', null, k), h('b', null, v))
        const wallets = Array.isArray(a.balance) && a.balance.length
          ? a.balance.map((w, i) => row(i === 0 ? t('wallets') : ' ', moneyText(w)))
          : [h('div', { className: 'ahud-row', key: 'none' }, h('span', null, t('balance')), h('b', null, '—'))]
        return h('div', { className: 'ahud-panel ahud-nodrag', key: 'p-' + a.id },
          panelHead(a, moneyText(pickPrimary(a)) || '—'),
          wallets,
          row(t('updated'), fmtTime(a.balanceAt)),
          a.stale ? h('div', { className: 'ahud-kd' }, t('stale')) : null,
          a.balanceError ? h('div', { className: 'ahud-err' }, t('apiError') + ': ' + a.balanceError) : null,
          h('div', { className: 'ahud-ctl' },
            h('label', { className: 'ahud-lbl' },
              h('input', {
                type: 'checkbox',
                checked: balCfg.auto,
                onChange: (e) => setBalCfg({ ...balCfg, auto: e.target.checked }),
              }),
              t('autoRefresh')),
            h('input', {
              className: 'ahud-num',
              type: 'number',
              min: 15,
              max: 3600,
              step: 5,
              value: String(balCfg.seconds),
              onChange: (e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v) && v >= 15 && v <= 3600) setBalCfg({ ...balCfg, seconds: Math.round(v) })
              },
            }),
            h('span', { className: 'ahud-kd' }, t('seconds'))),
          h('div', { className: 'ahud-ctl' },
            h('label', { className: 'ahud-lbl' },
              h('input', {
                type: 'checkbox',
                checked: warnCfg.on,
                onChange: (e) => setWarnCfg({ ...warnCfg, on: e.target.checked }),
              }),
              t('warnOn')),
            h('input', {
              className: 'ahud-num',
              type: 'number',
              min: 0,
              step: 1,
              value: String(warnCfg.amount),
              onChange: (e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v) && v >= 0 && v <= 1_000_000) {
                  setWarnCfg({ ...warnCfg, amount: Math.round(v * 100) / 100 })
                }
              },
            }),
            h('span', { className: 'ahud-kd' }, t('yuan'))),
          h('div', { style: { marginTop: 6 } },
            h('button', {
              className: 'ahud-btn',
              disabled: busy,
              onClick: refreshNow,
            }, busy ? t('refreshing') : t('refreshNow'))))
      }

      const priceColor = pricing.peak
        ? 'var(--dsw-alias-state-warn-primary)'
        : 'var(--dsw-alias-state-success-primary)'
      const priceCount = pricing.next ? fmtCountdown(pricing.left) : '—'
      const priceLabel = t(pricing.peak ? 'peak' : 'offPeak') + ' ' + t(pricing.peak ? 'fullPrice' : 'halfPrice')

      const pricingChip = h('div', {
        className: 'ahud-chip ahud-price ahud-nodrag', key: 'pricing',
        title: priceLabel + ' · ' + t('remaining') + ' ' + priceCount + '\n' + t('peakWindow') + '\n' + t('offPeakWindow'),
        onClick: () => togglePanel('pricing'),
      },
        h('span', { className: 'ahud-dot st', style: { background: priceColor } }),
        h('span', { className: 'ahud-name', style: { color: priceColor } }, priceLabel),
        h('span', { className: 'ahud-count' }, '· ' + priceCount + ' ' + t('toSwitch')))

      const pricingPanel = () => h('div', { className: 'ahud-panel ahud-nodrag', key: 'p-pricing' },
        h('div', { className: 'ahud-head' },
          h('span', { className: 'ahud-big' }, t('pricing')),
          h('span', { style: { color: priceColor } }, priceLabel),
          h('span', {
            className: 'ahud-x',
            onClick: (e) => {
              e.stopPropagation()
              closePanel('pricing')
            },
          }, '×')),
        h('div', { className: 'ahud-row' },
          h('span', null, t('remaining')),
          h('b', { style: { fontVariantNumeric: 'tabular-nums' } }, priceCount)),
        h('div', { className: 'ahud-row' },
          h('span', null, t('nextSwitch')),
          h('b', null, fmtSwitch(pricing.next))),
        h('div', { className: 'ahud-rule' }, h('b', null, t('peak')), t('peakWindow')),
        h('div', { className: 'ahud-rule' }, h('b', null, t('offPeak')), t('offPeakWindow')),
        pricing.covered ? null : h('div', { className: 'ahud-kd', style: { paddingTop: 4 } }, t('calendarNote')),
        h('div', { className: 'ahud-kd', style: { paddingTop: 4 } },
          h('a', {
            href: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
            target: '_blank',
            rel: 'noreferrer',
            style: { color: 'var(--dsw-alias-brand-primary)' },
          }, t('priceSource'))))

      const noticeChip = h('div', {
        className: 'ahud-chip ahud-nodrag', key: 'notices',
        onClick: () => togglePanel('notices'),
      },
        h('span', {
          className: alertCount ? 'ahud-dot' : 'ahud-dot st',
          style: { background: alertCount ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-caption)' },
        }),
        h('span', { className: 'ahud-val' }, String(alertCount)))

      const KIND_LABEL = { approval: t('approval'), wait: t('wait'), unread: t('unread'), running: t('running') }
      const KIND_COLOR = {
        approval: 'var(--dsw-alias-state-error-primary)',
        wait: 'var(--dsw-alias-state-warn-primary)',
        unread: 'var(--dsw-alias-state-success-primary)',
        running: 'var(--dsw-alias-brand-primary)',
      }

      const noticeRow = (n) => {
        const detail = n.kind === 'approval'
          ? (n.pi.toolName || '') + (n.pi.reason ? ' — ' + String(n.pi.reason).slice(0, 40) : '')
          : ''
        return h('div', { className: 'ahud-item ahud-nodrag', key: n.sid },
          h('span', { className: n.kind === 'running' || n.kind !== 'unread' ? 'ahud-dot' : 'ahud-dot st', style: { background: KIND_COLOR[n.kind] } }),
          h('span', {
            className: 'nm', title: titleOf(n.sid), style: { cursor: 'pointer' },
            onClick: () => jump(n.sid),
          }, titleOf(n.sid)),
          h('span', { className: 'ahud-kd' }, KIND_LABEL[n.kind] + (detail ? ' · ' + detail : '')),
          n.kind === 'approval'
            ? [
              h('button', {
                className: 'ahud-btn ok', key: 'ok', disabled: !n.pi.answerable,
                onClick: () => answer(n.pi, 'allowed-once'),
              }, t('approve')),
              h('button', {
                className: 'ahud-btn deny', key: 'no', disabled: !n.pi.answerable,
                onClick: () => answer(n.pi, 'rejected'),
              }, t('deny')),
            ]
            : h('button', { className: 'ahud-btn', onClick: () => jump(n.sid) }, t('jump')))
      }

      const noticePanel = h('div', { className: 'ahud-panel ahud-nodrag', key: 'p-notices' },
        h('div', { className: 'ahud-head' },
          h('span', { className: 'ahud-big' }, t('notices')),
          h('span', {
            className: 'ahud-x',
            onClick: (e) => {
              e.stopPropagation()
              closePanel('notices')
            },
          }, '×')),
        notices.length ? h('div', null, notices.map(noticeRow))
          : h('div', { className: 'ahud-kd' }, t('none')))

      // Panels render in chip order (agents..., pricing, then notices), never in click order.
      const panelList = []
      for (const a of snap.agents) {
        if (openPanels.includes(a.id)) panelList.push(a.kind === 'balance' ? balancePanel(a) : tokenPanel(a))
      }
      if (openPanels.includes('pricing')) panelList.push(pricingPanel())
      if (useStatus && openPanels.includes('notices')) panelList.push(noticePanel)

      const children = [h('style', { key: 's' }, CSS)]
      children.push(
        h('div', { key: 'wrap', style: { position: 'relative', pointerEvents: 'none' } },
          h('div', {
            key: 'bar', className: 'ahud-bar', style: bar,
            onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp,
          },
            snap.agents.map(agentChip),
            pricingChip,
            useStatus ? noticeChip : null),
          panelList.length ? h('div', { key: 'panels', className: 'ahud-panels', style: panelsStyle }, panelList) : null))
      return h('div', { className: 'ahud-root', style: outer }, children)
    }

    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT))
        const t = (k) => {
          try {
            return ctx.locale.bind(NS)(k)
          } catch {
            return DICT.zh[k] || k
          }
        }
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'agent-hud', order: 50 }, (props) => Hud({ ctx, t, ...(props || {}) })),
        )
      },
    }
  },
})
