// Minimal smoke check for the Client half: loads client.js under a mock module
// loader + React stub, then asserts full-name chips, multi-panel ordering, the
// working × button, the balance refresh controls, and degradation paths.
import assert from 'node:assert/strict'
import fs from 'node:fs'

const SNAP = {
  updatedAt: 1,
  agents: [
    {
      id: 'dsh', label: 'DeepSeek Harness', kind: 'tokens', available: true,
      tokens24h: 147200000, input24h: 8500000, output24h: 980000, cache24h: 137000000,
      prev24h: 3400000, ratePerH: 27500000, calls24h: 1179, sessions24h: 37,
      budget: 200000000, buckets: new Array(24).fill(5000000),
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
globalThis.localStorage = { getItem: () => null, setItem: () => {} }
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

function render(snap, openPanels = [], balCfg = { auto: true, seconds: 90 }, withProps = props, warnCfg = { on: true, amount: 20 }) {
  hooks = []
  idx = 0
  hooks[0] = snap
  hooks[3] = openPanels
  hooks[4] = balCfg
  hooks[5] = warnCfg
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
  assert.ok(!s.includes(CUR), 'current session excluded')
  console.log('ok: notices panel')
}

// 7) auto-refresh off means no balance interval, only the 2s DSH poll
{
  intervals = []
  render(SNAP, [], { auto: false, seconds: 90 })
  assert.deepEqual(intervals, [2000], 'only the DSH poll runs when auto is off')
  intervals = []
  render(SNAP, [], { auto: true, seconds: 30 })
  assert.deepEqual(intervals, [2000, 30000], 'DSH poll + balance poll when auto is on')
  console.log('ok: auto-refresh toggle controls the balance interval')
}

// 8) without framework props: strip renders, notices hidden
{
  const s = flat(render(SNAP, [], undefined, {}))
  assert.ok(s.includes('ahud-bar'), 'strip still renders')
  assert.ok(!s.includes('notices'), 'no bell without useSessionStatus')
  console.log('ok: degrade without framework props')
}

console.log('CLIENT SMOKE PASS')
