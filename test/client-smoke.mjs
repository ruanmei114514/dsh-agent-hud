// Minimal smoke check for the Client half: loads client.js under a mock module
// loader + React stub, then asserts full-name chips, multi-panel ordering, the
// working × button, balance controls, the peak/off-peak countdown, stats reset,
// and degradation paths.
import assert from 'node:assert/strict'
import fs from 'node:fs'

const SNAP = {
  updatedAt: 1,
  agents: [
    {
      id: 'dsh', label: 'DeepSeek Harness', kind: 'tokens', available: true,
      tokens24h: 147200000, input24h: 8500000, output24h: 980000, cache24h: 137000000,
      prev24h: 3400000, ratePerH: 27500000, calls24h: 1179, sessions24h: 37,
      budget: 200000000, buckets: new Array(24).fill(5000000), statsSince: 0,
    },
    {
      id: 'deepseek', label: 'DeepSeek', kind: 'balance',
      available: true, balance: [{ currency: 'CNY', balance: '42.10' }],
      balanceError: null, stale: false, balanceAt: 1792390000000,
      warnBelow: 20, errorBelow: 5,
    },
  ],
}

let factory = null
globalThis.window = { __ModuleLoader__: { load(mod) { factory = mod.factory } } }
globalThis.location = {
  pathname: '/s/session-6d05b48e-ecf7-486a-9420-91107954d31a', search: '', hash: '',
}
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)) },
  removeItem: (k) => { store.delete(k) },
}
globalThis.document = {
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
}

let intervals = []
globalThis.setInterval = (fn, ms) => { intervals.push(ms); return intervals.length }
globalThis.clearInterval = () => {}
const fetched = []
globalThis.fetch = async (url) => {
  fetched.push(String(url))
  return { ok: true, json: async () => SNAP }
}

let hooks = []
let idx = 0
function useState(init) {
  const i = idx++
  if (hooks[i] === undefined) hooks[i] = typeof init === 'function' ? init() : init
  return [hooks[i], (v) => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v }]
}
function useEffect(fn) { try { fn() } catch {} }
function useRef(v) { return { current: v ?? null } }
const React = { createElement: (type, props, ...kids) => ({ type, props, kids }), useState, useEffect, useRef }
globalThis.require = (id) => { if (id === 'react') return React; throw new Error('unknown ' + id) }

new Function(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'))()
assert.ok(factory, 'module factory loaded')
const mod = factory((id) => require(id))
let view = null
const ctx = {
  effect: (fn) => fn(),
  locale: { register: (ns, dict) => { assert.ok(dict.zh && dict.en, 'dict has zh+en'); return () => {} }, bind: () => (k) => k },
  slots: {
    inject: (key, cb) => { assert.equal(key, 'shell.overlay'); cb(); return () => {} },
    register: (opts, v) => { assert.equal(opts.id, 'agent-hud'); view = v; return () => {} },
  },
  uiWorkspace: { openSession: () => {} },
}
mod.apply(ctx)
assert.ok(view, 'slot view registered')

const CUR = 'session-6d05b48e-ecf7-486a-9420-91107954d31a'
const APPROVAL = 'session-aaaa0000-0000-0000-0000-000000000001'
const UNREAD = 'session-bbbb0000-0000-0000-0000-000000000002'
const status = new Map([
  [CUR, { running: true, pendingInteraction: undefined, completionUnread: false }],
  [APPROVAL, {
    running: false, completionUnread: false,
    pendingInteraction: { kind: 'approval', answerable: true, toolName: 'bash', reason: 'rm 测试', answer: async () => {} },
  }],
  [UNREAD, { running: false, pendingInteraction: undefined, completionUnread: true }],
])
const props = { useSessionStatus: () => status, useSessions: () => ({ ids: [], byId: {}, projectionsBySession: {} }) }

function render(snap, openPanels = [], balCfg = { auto: true, seconds: 90 }, withProps = props, warnCfg = { on: true, amount: 20 }, dismissArg) {
  hooks = []
  idx = 0
  hooks[0] = snap
  hooks[3] = openPanels
  hooks[4] = balCfg
  hooks[5] = warnCfg
  if (dismissArg !== undefined) hooks[9] = dismissArg
  return view(withProps)
}

const flat = (tree) => JSON.stringify(tree).replace(/\\"/g, '"')

function findAll(node, pred, out = []) {
  if (Array.isArray(node)) {
    for (const n of node) findAll(n, pred, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  for (const k of node.kids || []) findAll(k, pred, out)
  return out
}

// 1) closed strip: full names, no abbreviations, no codex
{
  const s = flat(render(SNAP))
  for (const need of ['DeepSeek Harness', '147.2M', 'DeepSeek', '¥42.10', 'ahud-bar']) {
    assert.ok(s.includes(need), 'closed strip missing: ' + need)
  }
  assert.ok(!s.includes('"DS"') && !s.includes('"CX"'), 'no old abbreviations')
  assert.ok(!s.toLowerCase().includes('codex'), 'no codex anywhere')
  assert.ok(!s.includes('budget'), 'no panel when closed')
  console.log('ok: closed strip shows full names + balance')
}

// 2) two panels coexist, laid out in chip order (harness before balance)
{
  const s = flat(render(SNAP, ['dsh', 'deepseek']))
  const iBudget = s.indexOf('budget')
  const iWallets = s.indexOf('wallets')
  assert.ok(iBudget > -1 && iWallets > -1, 'both panels rendered')
  assert.ok(iBudget < iWallets, 'panels follow chip order')
  assert.ok(s.includes('ahud-panels'), 'panels container present')
  assert.ok(s.includes('"width":"max-content"'), 'panel row is content-wide, not squeezed by the bar wrapper')
  assert.equal(
    findAll(render(SNAP, ['dsh', 'deepseek']), (n) => n.props && n.props.className === 'ahud-x').length,
    2,
    'one close button per panel',
  )
  console.log('ok: multiple panels in chip order')
}

// 3) the × button really removes only its own panel
{
  const tree = render(SNAP, ['dsh', 'deepseek'])
  const xs = findAll(tree, (n) => n.props && n.props.className === 'ahud-x')
  assert.equal(xs.length, 2)
  xs[0].props.onClick({ stopPropagation() {} })
  assert.deepEqual(hooks[3], ['deepseek'], 'first × closes only the harness panel')
  console.log('ok: × closes exactly one panel')
}

// 4) balance panel controls + pointer-events fix
{
  const s = flat(render(SNAP, ['deepseek']))
  assert.ok(s.includes('"type":"checkbox"'), 'auto-refresh toggle')
  assert.ok(s.includes('"checked":true'), 'auto refresh defaults on')
  assert.ok(s.includes('"value":"90"'), 'seconds box defaults to 90')
  assert.ok(s.includes('"value":"20"'), 'low balance threshold defaults to 20 CNY')
  assert.ok(s.includes('warnOn') && s.includes('yuan'), 'low balance warning controls')
  assert.ok(s.includes('refreshNow'), 'manual refresh button')
  assert.equal((s.match(/"type":"checkbox"/g) || []).length, 2, 'two toggles: refresh + warning')
  assert.ok(/\.ahud-panel\{[^}]*pointer-events:auto/.test(s), 'panels accept clicks')
  console.log('ok: balance controls rendered')
}

// 4b) low-balance ring: red under the threshold, green when the warning is off
{
  const low = {
    ...SNAP,
    agents: [SNAP.agents[0], { ...SNAP.agents[1], balance: [{ currency: 'CNY', balance: '4.56' }] }],
  }
  const redRing = (tree) => findAll(tree, (n) => n.type === 'circle' && n.props && n.props.stroke === 'var(--dsw-alias-state-error-primary)').length
  const greenRing = (tree) => findAll(tree, (n) => n.type === 'circle' && n.props && n.props.stroke === 'var(--dsw-alias-state-success-primary)').length
  assert.ok(redRing(render(low, [], undefined, {})) > 0, 'red ring below the threshold')
  assert.ok(redRing(render(low, [], undefined, {}, { on: false, amount: 20 })) === 0, 'no red ring when warning is off')
  assert.ok(greenRing(render(low, [], undefined, {}, { on: false, amount: 20 })) > 0)
  console.log('ok: low-balance warning drives the ring color')
}

// 5) manual refresh hits ?refresh=1
{
  render(SNAP, ['deepseek'])
  const tree = render(SNAP, ['deepseek'])
  const off = fetched.length
  const btn = findAll(tree, (n) => n.type === 'button' && (n.kids || []).includes('refreshNow'))[0]
  assert.ok(btn, 'refresh button found')
  delete btn.props.disabled
  await btn.props.onClick()
  assert.ok(fetched.slice(off).some((u) => u.includes('refresh=1')), 'manual refresh forces the balance')
  console.log('ok: manual refresh requests ?refresh=1')
}

// 6) notices: approval actions, current session excluded
{
  const s = flat(render(SNAP, ['notices']))
  assert.ok(s.includes('approve') && s.includes('deny') && s.includes('jump'), 'approval buttons')
  assert.ok(s.includes('aaaa0000'), 'other session listed')
  assert.ok(s.includes('clearAll'), 'clear-all control present')
  console.log('ok: notices panel')
}

// 6b) the session you are looking at is not an outstanding action, but a
// running session stays visible (running is ambient, not a demand)
{
  const tree = render(SNAP, ['notices'])
  const rows = findAll(tree, (n) => n.props && String(n.props.className).includes('ahud-item'))
  const rowText = (n) => flat(n)
  const curRow = rows.find((n) => rowText(n).includes('6d05b48e'))
  assert.ok(curRow, 'a running current session is still listed')
  assert.ok(rowText(curRow).includes('running'), 'listed as running, not as pending')
  // The current session in the fixture has an approval; it must not be listed.
  const approvalRows = rows.filter((n) => rowText(n).includes('approve'))
  assert.equal(approvalRows.length, 1, 'only the other session carries the approval')
  assert.ok(!rowText(approvalRows[0]).includes('6d05b48e'), 'current session has no approval row')
  console.log('ok: current session filtered by kind, not by URL')
}

// 6c) a dismissed row leaves the bell, and a newer completion brings it back
{
  store.delete('agent-hud.dismiss.v1')
  const stamp = 1792390000000
  const unreadStatus = new Map([[UNREAD, { running: false, completionUnread: true, completionAt: stamp }]])
  const withProps2 = { useSessionStatus: () => unreadStatus, useSessions: () => ({ ids: [], byId: {}, projectionsBySession: {} }) }
  assert.ok(flat(render(SNAP, ['notices'], undefined, withProps2)).includes('bbbb0000'), 'unread listed first')

  const tree = render(SNAP, ['notices'], undefined, withProps2)
  const xs = findAll(tree, (n) => n.props && n.props.className === 'ahud-xrow')
  assert.equal(xs.length, 1, 'exactly one dismiss control')
  assert.equal(xs[0].props.title, 'dismiss')
  xs[0].props.onClick({ stopPropagation() {} })
  assert.equal(hooks[9][UNREAD], stamp, 'dismiss records the completion stamp')

  // Rendered again with the same completion: the row stays gone.
  const after = render(SNAP, ['notices'], undefined, withProps2, undefined, hooks[9])
  assert.ok(!flat(after).includes('bbbb0000'), 'dismissed row stays out of the bell')

  // A newer completion is a new turn: the session comes back on its own.
  const newer = new Map([[UNREAD, { running: false, completionUnread: true, completionAt: stamp + 5000 }]])
  const revived = render(SNAP, ['notices'], undefined, { useSessionStatus: () => newer, useSessions: withProps2.useSessions }, undefined, hooks[9])
  assert.ok(flat(revived).includes('bbbb0000'), 'a newer completion revives the notice')
  store.delete('agent-hud.dismiss.v1')
  console.log('ok: × dismisses one completion, not the session')
}

// 6c-2) the dismissal is persisted, so a refresh does not resurrect the row
{
  store.set('agent-hud.dismiss.v1', JSON.stringify({ [UNREAD]: 1792390000000, bogus: 'x', zero: 0 }))
  const props3 = { useSessionStatus: () => new Map([[UNREAD, { running: false, completionUnread: true, completionAt: 1792390000000 }]]), useSessions: () => ({ ids: [], byId: {}, projectionsBySession: {} }) }
  const s = flat(render(SNAP, ['notices'], undefined, props3))
  assert.ok(!s.includes('bbbb0000'), 'a stored dismissal survives a reload')

  const revived = render(SNAP, ['notices'], undefined, { useSessionStatus: () => new Map([[UNREAD, { running: false, completionUnread: true, completionAt: 1792390000001 }]]), useSessions: props3.useSessions })
  assert.ok(flat(revived).includes('bbbb0000'), 'and expires on the next completion')
  store.delete('agent-hud.dismiss.v1')
  console.log('ok: dismissal round-trips through localStorage')
}

// 6d) clear-all sweeps informational notices but never an approval
{
  store.delete('agent-hud.dismiss.v1')
  const stamp = 1792390000000
  const mixed = new Map([
    [CUR, { running: true }],
    [APPROVAL, {
      running: false,
      pendingInteraction: { kind: 'approval', answerable: true, toolName: 'bash', reason: 'rm', answer: async () => {} },
    }],
    [UNREAD, { running: false, completionUnread: true, completionAt: stamp }],
  ])
  const mp = { useSessionStatus: () => mixed, useSessions: () => ({ ids: [], byId: {}, projectionsBySession: {} }) }
  const btn = findAll(render(SNAP, ['notices'], undefined, mp), (n) => n.type === 'button' && (n.kids || []).includes('clearAll'))[0]
  assert.ok(btn, 'clear-all button rendered')
  assert.equal(btn.props.title, 'clearAllExcept')
  btn.props.onClick({ stopPropagation() {} })
  const d = hooks[9]
  assert.equal(d[UNREAD], stamp, 'unread dismissed')
  // A running session carries no completion stamp yet, so it is stamped "now";
  // what matters is that it is stamped at all, so its later completion revives it.
  assert.ok(Number.isFinite(d[CUR]) && d[CUR] > 0, 'running session dismissed with a usable stamp')
  assert.ok(!(APPROVAL in d), 'an approval is never bulk-dismissed')

  const after = render(SNAP, ['notices'], undefined, mp, undefined, d)
  assert.ok(flat(after).includes('approve'), 'the approval survives clear-all')
  assert.ok(flat(after).includes('aaaa0000'), 'and is still actionable')
  store.delete('agent-hud.dismiss.v1')
  console.log('ok: clear-all spares approvals and questions')
}

// 7) auto-refresh off means no balance interval, only the 2s DSH poll + 1s price clock
{
  intervals = []
  render(SNAP, [], { auto: false, seconds: 90 })
  assert.deepEqual(intervals, [2000, 1000], 'DSH poll + price countdown when auto is off')
  intervals = []
  render(SNAP, [], { auto: true, seconds: 30 })
  assert.deepEqual(intervals, [2000, 30000, 1000], 'DSH poll + balance poll + price countdown when auto is on')
  console.log('ok: auto-refresh toggle controls the balance interval')
}

// 8) without framework props: strip renders, notices hidden
{
  const s = flat(render(SNAP, [], undefined, {}))
  assert.ok(s.includes('ahud-bar'), 'strip still renders')
  assert.ok(!s.includes('notices'), 'no bell without useSessionStatus')
  console.log('ok: degrade without framework props')
}

// 9) peak/off-peak chip + countdown against the Beijing schedule
{
  const realNow = Date.now
  const check = (iso, peak, count) => {
    Date.now = () => Date.parse(iso)
    const s = flat(render(SNAP))
    assert.ok(s.includes(peak ? 'peak fullPrice' : 'offPeak halfPrice'), iso + ': period')
    assert.ok(s.includes(count + ' toSwitch'), iso + ': countdown ' + count)
  }
  check('2026-10-21T02:00:00Z', true, '2:00:00') // Wed 10:00 -> 12:00
  check('2026-10-21T04:00:00Z', false, '2:00:00') // Wed 12:00 -> 14:00
  check('2026-10-24T02:00:00Z', false, '47:00:00') // Sat 10:00 -> Mon 09:00
  check('2026-10-23T10:00:00Z', false, '63:00:00') // Fri 18:00 -> Mon 09:00
  check('2026-10-01T02:00:00Z', false, '167:00:00') // holiday Thu -> Oct 8 09:00
  Date.now = realNow
  console.log('ok: peak/off-peak chip + countdown')
}

// 9b) price panel: rule rows, source link, uncovered-year note
{
  const realNow = Date.now
  Date.now = () => Date.parse('2027-01-04T02:00:00Z') // Mon 10:00, year not in the calendar
  const s = flat(render(SNAP, ['pricing']))
  assert.ok(s.includes('peakWindow') && s.includes('offPeakWindow'), 'rule rows')
  assert.ok(s.includes('calendarNote'), 'uncovered year is called out')
  assert.ok(s.includes('api-docs.deepseek.com'), 'source link')
  Date.now = realNow
  console.log('ok: pricing panel')
}

// 10) reset stats: a since= request, an undo control, and persistence
{
  const realNow = Date.now
  const NOW = 1792390000000
  Date.now = () => NOW
  store.delete('agent-hud.reset.v1')
  const tree = render(SNAP, ['dsh'])
  const btn = findAll(tree, (n) => n.type === 'button' && (n.kids || []).includes('resetStats'))[0]
  assert.ok(btn, 'reset button present')
  assert.ok(!btn.props.disabled, 'reset enabled when the host advertises statsSince')
  await btn.props.onClick()
  assert.equal(hooks[8], NOW, 'reset state set to now')
  assert.ok(fetched.some((u) => u.includes('since=' + NOW)), 'reset asks for a clipped window')

  store.set('agent-hud.reset.v1', String(NOW))
  const resetSnap = { ...SNAP, agents: [{ ...SNAP.agents[0], statsSince: NOW }, SNAP.agents[1]] }
  const s = flat(render(resetSnap, ['dsh']))
  assert.ok(s.includes('resetClear') && s.includes('since'), 'undo + since row shown')
  const clear = findAll(render(resetSnap, ['dsh']), (n) => n.type === 'button' && (n.kids || []).includes('resetClear'))[0]
  await clear.props.onClick()
  assert.equal(hooks[8], 0, 'undo clears the reset state')
  store.delete('agent-hud.reset.v1')
  Date.now = realNow
  console.log('ok: reset stats button')
}

// 10b) old host (no statsSince) disables the reset button instead of pretending
{
  const old = { ...SNAP, agents: [{ ...SNAP.agents[0] }, SNAP.agents[1]] }
  delete old.agents[0].statsSince
  const tree = render(old, ['dsh'])
  const btn = findAll(tree, (n) => n.type === 'button' && (n.kids || []).includes('resetStats'))[0]
  assert.ok(btn && btn.props.disabled, 'reset disabled until the host is restarted')
  console.log('ok: reset degrades on an old host')
}

console.log('CLIENT SMOKE PASS')
