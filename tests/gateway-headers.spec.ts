import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { withGatewayChatHeaders, WorkBuddyUpstreamClient } from '../src/upstream.ts'

/**
 * Pin for the gateway's channel-verification headers (HTTP 400 / code 11128).
 *
 * The gate is **separately switched per deployment**, which decides what these
 * tests can assert. Measured 2026-10-20 12:2x (+08:00) with this plugin's own
 * credential against both live deployments: the same well-formed chat was
 * answered 200 on CN and 200 on international with only the pre-existing header
 * family, while the same account with the leading system message stripped was
 * refused `400 / 11128 / "first message is not system prompt"`. So the gate is
 * armed, and its conversation-header arm was not switched on for that account —
 * which is why a request without this family still succeeds today and still has
 * to carry it: other deployments report it switched on since 2026-10-15, with a
 * 400 that reads `"request illegal"` / 「请求被拦截，请重新发送」.
 *
 * The assertions below therefore describe what we put on the wire, not what we
 * assume the upstream will require on a given day.
 */

const CN: WorkBuddyCredential = {
  accessToken: 'at', refreshToken: 'rt', expiresAtMs: 0,
  domain: 'www.codebuddy.cn', uid: 'uid-1', source: 'login',
}
const GLOBAL: WorkBuddyCredential = { ...CN, domain: 'www.workbuddy.ai' }

const HEX32 = /^[0-9a-f]{32}$/

const chat = (messages: unknown[]): string => JSON.stringify({ model: 'm', stream: true, messages })

const TWO_TURNS = chat([
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'first question' },
])

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Drive one `chatStream` with fetch stubbed; returns the headers it sent. */
async function wire(credential: WorkBuddyCredential, body: string): Promise<Record<string, string>> {
  const calls: Array<Record<string, string>> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    calls.push(init.headers as Record<string, string>)
    return { ok: true, status: 200, body: null } as unknown as Response
  }))
  const client = new WorkBuddyUpstreamClient({ resolveChatIdentity: async () => ({ clientVersion: '5.8.4' }) })
  const result = await client.chatStream(credential, body)
  expect(result.ok).toBe(true)
  expect(calls).toHaveLength(1)
  return calls[0]!
}

describe('conversation tracking family on the wire', () => {
  it('sends gateway ids, omitting the CN conversation id', async () => {
    for (const credential of [CN, GLOBAL]) {
      const headers = await wire(credential, TWO_TURNS)
      for (const name of [
        'X-Conversation-Request-ID',
        'X-Conversation-Message-ID',
        'X-Request-ID',
      ]) {
        expect(headers[name]).toMatch(HEX32)
      }
      if (credential.domain.endsWith('workbuddy.ai')) expect(headers['X-Conversation-ID']).toMatch(HEX32)
      else expect(headers['X-Conversation-ID']).toBeUndefined()
      // The official client has these two be one value.
      expect(headers['X-Request-ID']).toBe(headers['X-Conversation-Message-ID'])
    }
  })

  it('keeps the identity family and scopes only X-Agent-Type to international', async () => {
    const cn = await wire(CN, TWO_TURNS)
    const intl = await wire(GLOBAL, TWO_TURNS)
    // The shared pair goes out on both builds, as WorkBuddy's own client does.
    for (const headers of [cn, intl]) {
      expect(headers['X-Agent-Intent']).toBe('craft')
      expect(headers['X-Agent-Purpose']).toBe('conversation')
    }
    // `main` is the international build's own identity; claiming it on CN would
    // name a client that build does not ship.
    expect(intl['X-Agent-Type']).toBe('main')
    expect(cn['X-Agent-Type']).toBeUndefined()
  })

  it('does not displace the headers that already worked', async () => {
    const headers = await wire(CN, TWO_TURNS)
    expect(headers['X-CodeBuddy-Request']).toBe('1')
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest')
    expect(headers['Authorization']).toBe('Bearer at')
    // 安全红线：refresh token 绝不出现在 chat 请求里。
    expect(headers['X-Refresh-Token']).toBeUndefined()
  })
})

describe('id semantics', () => {
  it('repeats conversation and turn ids across the steps of one send', async () => {
    const first = await wire(GLOBAL, TWO_TURNS)
    const afterTool = await wire(GLOBAL, chat([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'pwsh' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'output' },
    ]))
    // One user send answered across a tool loop is one request upstream, so its
    // ids must not rotate with every step.
    expect(afterTool['X-Conversation-ID']).toBe(first['X-Conversation-ID'])
    expect(afterTool['X-Conversation-Request-ID']).toBe(first['X-Conversation-Request-ID'])
    // Each message is its own, as the official client makes them.
    expect(afterTool['X-Conversation-Message-ID']).not.toBe(first['X-Conversation-Message-ID'])
  })

  it('moves the turn id but not the conversation id when the user sends again', async () => {
    const first = await wire(GLOBAL, TWO_TURNS)
    const next = await wire(GLOBAL, chat([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first question' },
      { role: 'user', content: 'and another' },
    ]))
    expect(next['X-Conversation-Request-ID']).not.toBe(first['X-Conversation-Request-ID'])
    expect(next['X-Conversation-ID']).toBe(first['X-Conversation-ID'])
  })

  it('does not key the turn on a tool result carried inside a user message', () => {
    const body = (result: string): string => chat([
      { role: 'user', content: 'real question' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: result }] },
    ])
    const a = withGatewayChatHeaders({}, body('ok'))
    const b = withGatewayChatHeaders({}, body('changed'))
    // Keying on the tool result would change the id with every step — the
    // opposite of what a turn id is for.
    expect(a['X-Conversation-Request-ID']).toBe(b['X-Conversation-Request-ID'])
  })

  it('keeps an id the caller already carried', () => {
    const headers = withGatewayChatHeaders({ 'X-Conversation-ID': 'a'.repeat(32) }, TWO_TURNS)
    expect(headers['X-Conversation-ID']).toBe('a'.repeat(32))
  })
})

describe('degenerate bodies', () => {
  it('claims no conversation id when nothing names one', () => {
    const headers = withGatewayChatHeaders({}, chat([{ role: 'system', content: 's' }]))
    expect(headers['X-Conversation-ID']).toBeUndefined()
    // A chat that names no conversation still has to be attributable.
    expect(headers['X-Conversation-Request-ID']).toMatch(HEX32)
    expect(headers['X-Conversation-Message-ID']).toMatch(HEX32)
  })

  it('stays usable when the body is not JSON', () => {
    const headers = withGatewayChatHeaders({}, 'not json at all')
    expect(headers['X-Conversation-Message-ID']).toMatch(HEX32)
    expect(headers['X-Request-ID']).toBe(headers['X-Conversation-Message-ID'])
    expect(headers['X-Conversation-ID']).toBeUndefined()
  })
})

describe('probe path', () => {
  it('presents the same gateway identity as a real message', async () => {
    const calls: Array<Record<string, string>> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init.headers as Record<string, string>)
      return { ok: false, status: 200, text: () => Promise.resolve('') } as unknown as Response
    }))
    const client = new WorkBuddyUpstreamClient({ resolveChatIdentity: async () => ({ clientVersion: '5.8.4' }) })
    await client.probeEffort(GLOBAL, 'm', undefined, AbortSignal.timeout(1000))
    expect(calls).toHaveLength(1)
    // A probe that passes while a real message would be refused measures nothing.
    expect(calls[0]!['X-Agent-Type']).toBe('main')
    expect(calls[0]!['X-Conversation-ID']).toMatch(HEX32)
    expect(calls[0]!['X-Conversation-Request-ID']).toMatch(HEX32)
  })
})
