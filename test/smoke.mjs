// Minimal smoke check for the Host half: boots the plugin with a mock ctx and
// asserts the published schema, the balance error taxonomy, the force-refresh /
// floor semantics of ?refresh=1, and the ?since= stats reset clip. No network
// and no running Harness required — the balance endpoint is stubbed for the
// whole run.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

globalThis.AbortSignal = { timeout: () => undefined }

function boot({ fetchImpl, credImpl, config = {} }) {
  globalThis.fetch = fetchImpl
  let route = null
  const ctx = {
    effect: (fn) => fn(),
    get: () => undefined,
    credentials: credImpl || { resolve: async () => ({ value: 'sk-test' }) },
    webServer: { register: (r) => { route = r; return () => {} } },
  }
  apply(ctx, config)
  return async (query = '') => {
    let out = ''
    await route.handler({ method: 'GET', url: '/agent-hud/state.json' + query }, { writeHead() {}, end(s) { out += s } })
    return JSON.parse(out)
  }
}

const okBody = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '42.10' }] }

// 1) happy path + schema
{
  const getState = boot({
    fetchImpl: async (url, opts) => {
      assert.equal(url, 'https://api.deepseek.com/user/balance')
      assert.match(opts.headers.Authorization, /^Bearer sk-test$/)
      return { ok: true, status: 200, json: async () => okBody }
    },
  })
  const snap = await getState()
  assert.equal(snap.agents.length, 2, 'exactly two chips')
  const [dsh, bal] = snap.agents
  assert.equal(dsh.id, 'dsh')
  assert.equal(dsh.kind, 'tokens')
  assert.equal(dsh.label, 'DeepSeek Harness')
  assert.equal(dsh.budget, 200_000_000)
  assert.ok(dsh.buckets.length === 24)
  assert.equal(dsh.statsSince, 0)
  assert.equal(bal.id, 'deepseek')
  assert.equal(bal.kind, 'balance')
  assert.equal(bal.available, true, 'balance: ' + bal.balanceError)
  assert.deepEqual(bal.balance, [{ currency: 'CNY', balance: '42.10' }])
  assert.equal(bal.balanceError, null)
  assert.ok(!('warnBelow' in bal) && !('errorBelow' in bal), 'thresholds are client-side')
  assert.ok(!JSON.stringify(snap).includes('codex'), 'codex must be gone')
  console.log('ok: happy path schema')
}

// 2) missing credential
{
  const getState = boot({
    credImpl: { resolve: async () => undefined },
    fetchImpl: async () => assert.fail('must not call the API without a key'),
  })
  const snap = await getState()
  const bal = snap.agents.find((a) => a.id === 'deepseek')
  assert.equal(bal.available, false)
  assert.match(bal.balanceError, /^no-key/)
  assert.equal(snap.agents.find((a) => a.id === 'dsh').kind, 'tokens')
  console.log('ok: missing key degrades')
}

// 3) network failure
{
  const getState = boot({ fetchImpl: async () => { throw new Error('boom') } })
  const bal = (await getState()).agents.find((a) => a.id === 'deepseek')
  assert.equal(bal.available, false)
  assert.match(bal.balanceError, /^network: boom/)
  console.log('ok: network failure degrades')
}

// 4) http error, shape error, bad JSON
for (const [impl, expected] of [
  [async () => ({ ok: false, status: 401 }), /^http-401$/],
  [async () => ({ ok: true, status: 200, json: async () => ({ balance_infos: [] }) }), /^shape$/],
  [async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } }), /^parse$/],
]) {
  const getState = boot({ fetchImpl: impl })
  const bal = (await getState()).agents.find((a) => a.id === 'deepseek')
  assert.equal(bal.available, false)
  assert.match(bal.balanceError, expected)
}
console.log('ok: http/parse/shape errors classified')

// 5) ?refresh=1 forces a refetch, but never faster than the configured floor
{
  let calls = 0
  const getState = boot({
    config: { balanceMinIntervalMs: 1000 },
    fetchImpl: async () => {
      calls++
      return { ok: true, status: 200, json: async () => okBody }
    },
  })
  await getState()
  assert.equal(calls, 1, 'first call fetches')
  await getState()
  assert.equal(calls, 1, 'plain poll serves the cache')
  await getState('?refresh=1')
  assert.equal(calls, 1, 'force within the floor is ignored')
  await new Promise((r) => setTimeout(r, 1100))
  await getState('?refresh=1')
  assert.equal(calls, 2, 'force after the floor refetches')
  console.log('ok: refresh=1 force + floor')
}

// 6) ?since=<ms> clips the token stats to the reset instant
{
  const home = fs.mkdtempSync(fileURLToPath(new URL('./.tmp-', import.meta.url)))
  const dir = path.join(home, 'sessions', 'ws', 'session-test')
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const line = (t, total) => JSON.stringify({
    type: 'assistant/message',
    time: t,
    data: { usage: { totalTokens: total, inputTokens: total, outputTokens: 0, cacheReadTokens: 0 } },
  })
  const log = [line(now - 3_600_000, 100), line(now - 7_200_000, 200)].join('\n') + '\n'
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(log)))

  const getState = boot({
    config: { dshHome: home, refreshMs: 200 },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => okBody }),
  })

  let dsh = (await getState()).agents[0]
  assert.equal(dsh.tokens24h, 300, 'both entries inside the normal 24h window')
  assert.equal(dsh.statsSince, 0)

  const since = Date.now() - 5_400_000 // 1.5h ago: only the 1h-old entry survives
  dsh = (await getState('?since=' + since)).agents[0]
  assert.equal(dsh.tokens24h, 100)
  assert.equal(dsh.statsSince, since)

  dsh = (await getState('?since=' + (Date.now() - 1000))).agents[0]
  assert.equal(dsh.tokens24h, 0, 'reset to now clears the window')

  dsh = (await getState('?since=' + (Date.now() - 25 * 3_600_000))).agents[0]
  assert.equal(dsh.tokens24h, 300, 'a reset older than 24h no longer clips')
  assert.equal(dsh.statsSince, 0)

  fs.rmSync(home, { recursive: true, force: true })
  console.log('ok: since clips stats')
}

console.log('SMOKE PASS')
