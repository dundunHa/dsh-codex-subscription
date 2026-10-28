import assert from 'node:assert/strict'
import test from 'node:test'
import { zstdDecompressSync } from 'node:zlib'

import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'

import { openaiCodexSubscriptionProvider } from '../src/pi-ai-runtime.js'
import { SESSION_SPEED_KEY, createSessionSpeedRegistry, installSessionSpeedRegistry } from '../src/session-speed.js'

const sse = events => `${events.map(event => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\n`
const jwt = accountId => {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.signature`
}

test('the session speed registry keeps only known modes and clears on request', () => {
  const registry = createSessionSpeedRegistry()
  assert.equal(registry.set('s1', 'fast'), true)
  assert.equal(registry.set('s2', 'ultrafast'), true)
  assert.equal(registry.set('s3', 'warp'), false, 'an unknown mode is rejected')
  assert.equal(registry.set('', 'fast'), false, 'an empty session id is rejected')
  assert.equal(registry.get('s1'), 'fast')
  assert.equal(registry.get('s3'), undefined)
  assert.equal(registry.get(undefined), undefined)
  registry.set('s2', undefined)
  assert.equal(registry.get('s2'), undefined, 'setting undefined removes the override')
  registry.clear('s1')
  assert.equal(registry.size(), 0)
})

test('the process-wide slot is removed only by the instance that still owns it', () => {
  const target = {}
  const first = createSessionSpeedRegistry()
  const second = createSessionSpeedRegistry()
  const removeFirst = installSessionSpeedRegistry(first, target)
  const removeSecond = installSessionSpeedRegistry(second, target)
  removeFirst()
  assert.equal(target[SESSION_SPEED_KEY], second, 'a reload that replaced the slot is left alone')
  removeSecond()
  assert.equal(SESSION_SPEED_KEY in target, false)
  assert.equal(SESSION_SPEED_KEY, Symbol.for('dsh-codex-subscription.session-speed'))
})

test('a per-session speed override reaches the wire while other sessions follow the global mode', async () => {
  const previousFetch = globalThis.fetch
  const wires = []
  globalThis.fetch = async (_input, init) => {
    wires.push(JSON.parse(zstdDecompressSync(Buffer.from(init.body)).toString('utf8')))
    return new Response(sse([
      { type: 'response.created', response: { id: `resp_s${wires.length}` } },
      { type: 'response.done', response: { id: `resp_s${wires.length}`, status: 'completed', output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
    ]), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const registry = createSessionSpeedRegistry()
    const metadata = { 'gpt-6-astra': { supportsFast: true, supportsUltrafast: true }, 'gpt-6-sol': { supportsFast: true, supportsUltrafast: false } }
    const base = openaiCodexProvider().getModels()[0]
    const catalog = {
      getModels: () => Object.keys(metadata).map(id => ({ ...base, id, name: id })),
      metadata: id => metadata[id],
    }
    const provider = openaiCodexSubscriptionProvider({
      catalog,
      resolveSpeedMode: options => registry.get(options?.sessionId) ?? 'standard',
    })
    const profiles = new Map([['openai-codex', {
      provider: 'openai-codex', displayName: 'ChatGPT subscription', piProvider: provider,
      configuredMaxTokens: new Map(), modelErrors: new Map(), transport: 'sse', streamIdleTimeoutMs: 10_000,
    }]])
    const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => jwt('account-session-speed') })
    const run = async (modelId, sessionId) => {
      for await (const chunk of adapter.stream({
        provider: 'openai-codex', model: modelId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], sessionId,
      })) void chunk
    }
    registry.set('child-fast', 'fast')
    registry.set('child-ultra', 'ultrafast')
    await run('gpt-6-astra', 'parent')
    await run('gpt-6-astra', 'child-fast')
    await run('gpt-6-astra', 'child-ultra')
    await run('gpt-6-sol', 'child-ultra')
    assert.equal('service_tier' in wires[0], false, 'a session without an override follows the global standard mode')
    assert.equal(wires[1].service_tier, 'priority')
    assert.equal(wires[2].service_tier, 'ultrafast')
    assert.equal('service_tier' in wires[3], false, 'a model without the tier stays standard')
  } finally {
    globalThis.fetch = previousFetch
  }
})
