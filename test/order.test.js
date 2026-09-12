import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMER_MS,
  isUsableResult,
  resolveCandidates,
  runSearchChain,
  timeoutSecondsToMs,
} from '../lib/order.js'

/** Stand-in for the seam's WebError; the walk only needs `message` and `code`. */
class StubError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.code = code
  }
}

const createError = (message, code, options) => new StubError(message, code, options)

/** Build a registry entry with overridable provider behaviour. */
function entry(id, overrides = {}) {
  return {
    id,
    provider: {
      id,
      available: overrides.available ?? (() => true),
      search:
        overrides.search ??
        (async () => ({ sources: [{ url: `https://${id}.example/` }], truncated: false })),
    },
  }
}

const request = { query: 'test query', maxResults: 5 }

// ── timeoutSecondsToMs ──────────────────────────────────────────────────────

test('timeoutSecondsToMs converts, defaults, and saturates at the timer limit', () => {
  assert.equal(timeoutSecondsToMs(5), 5000)
  assert.equal(timeoutSecondsToMs(0.05), 50)
  assert.equal(timeoutSecondsToMs(undefined), DEFAULT_TIMEOUT_SECONDS * 1000)
  assert.equal(timeoutSecondsToMs(0), DEFAULT_TIMEOUT_SECONDS * 1000)
  assert.equal(timeoutSecondsToMs(Number.NaN), DEFAULT_TIMEOUT_SECONDS * 1000)
  // No practical upper clamp: the caller's own budget bounds the call, so a
  // large configured value is passed through rather than silently rewritten.
  assert.equal(timeoutSecondsToMs(10_000), 10_000_000)
  // ...but it saturates where `setTimeout` stops being able to express it,
  // because Node coerces anything larger to 1 ms — a silently instant timeout.
  assert.equal(timeoutSecondsToMs(1_000_000_000), MAX_TIMER_MS)
  assert.equal(MAX_TIMER_MS, 2_147_483_647)
})

// ── isUsableResult ──────────────────────────────────────────────────────────

test('isUsableResult accepts sources or answer text only', () => {
  assert.equal(isUsableResult({ sources: [{ url: 'https://a.test' }], truncated: false }), true)
  assert.equal(isUsableResult({ sources: [], content: 'an answer' }), true)
  assert.equal(isUsableResult({ sources: [], content: '   ' }), false)
  assert.equal(isUsableResult({ sources: [] }), false)
  assert.equal(isUsableResult(undefined), false)
  assert.equal(isUsableResult(null), false)
  assert.equal(isUsableResult('nope'), false)
})

// ── resolveCandidates ───────────────────────────────────────────────────────

test('order wins, first occurrence only, unlisted providers follow in registry order', () => {
  const providers = [entry('a'), entry('b'), entry('c'), entry('d')]
  const { candidates, skipped, unknownOrderIds } = resolveCandidates(providers, {
    order: ['c', 'a', 'c'],
    exclude: [],
    selfId: 'router',
  })
  assert.deepEqual(
    candidates.map((candidate) => candidate.id),
    ['c', 'a', 'b', 'd'],
  )
  assert.deepEqual(skipped, [])
  assert.deepEqual(unknownOrderIds, [])
})

test('an empty order preserves registry order', () => {
  const providers = [entry('a'), entry('b')]
  const { candidates } = resolveCandidates(providers, { order: [], exclude: [], selfId: 'router' })
  assert.deepEqual(
    candidates.map((candidate) => candidate.id),
    ['a', 'b'],
  )
})

test('exclude beats the preferred list and the registry', () => {
  const providers = [entry('a'), entry('b'), entry('c')]
  const { candidates, skipped } = resolveCandidates(providers, {
    order: ['b', 'a'],
    exclude: ['b'],
    selfId: 'router',
  })
  assert.deepEqual(
    candidates.map((candidate) => candidate.id),
    ['a', 'c'],
  )
  assert.deepEqual(skipped, [{ id: 'b', reason: 'excluded' }])
})

test('the router id is never a candidate, even when listed', () => {
  const providers = [entry('router'), entry('a')]
  const { candidates, skipped } = resolveCandidates(providers, {
    order: ['router'],
    exclude: [],
    selfId: 'router',
  })
  assert.deepEqual(
    candidates.map((candidate) => candidate.id),
    ['a'],
  )
  assert.deepEqual(skipped, [{ id: 'router', reason: 'router-id' }])
})

test('unknown order ids are reported once and ignored', () => {
  const { candidates, unknownOrderIds } = resolveCandidates([entry('a')], {
    order: ['ghost', 'ghost', 'a'],
    exclude: [],
    selfId: 'router',
  })
  assert.deepEqual(
    candidates.map((candidate) => candidate.id),
    ['a'],
  )
  assert.deepEqual(unknownOrderIds, ['ghost'])
})

test('malformed registry entries are dropped', () => {
  const providers = [null, { id: '' }, { id: 'a' }, { id: 'a' }, { provider: {} }]
  const { candidates } = resolveCandidates(providers, { order: [], exclude: [], selfId: 'router' })
  assert.deepEqual(
    candidates.map((candidate) => candidate.id),
    ['a'],
  )
})

// ── runSearchChain ──────────────────────────────────────────────────────────

test('returns the first usable result and stops', async () => {
  let secondCalled = false
  const candidates = [
    entry('first'),
    entry('second', {
      search: async () => {
        secondCalled = true
        return { sources: [], truncated: false }
      },
    }),
  ]
  const result = await runSearchChain({ candidates, request, timeoutMs: 50, createError })
  assert.equal(result.sources[0].url, 'https://first.example/')
  assert.equal(secondCalled, false)
})

test('falls through a provider error to the next provider', async () => {
  const candidates = [
    entry('broken', {
      search: async () => {
        throw new StubError('boom', 'WEB_PROVIDER_ERROR')
      },
    }),
    entry('good'),
  ]
  const result = await runSearchChain({ candidates, request, timeoutMs: 50, createError })
  assert.equal(result.sources[0].url, 'https://good.example/')
})

test('falls through a synchronous throw', async () => {
  const candidates = [
    entry('sync', {
      search: () => {
        throw new Error('sync boom')
      },
    }),
    entry('good'),
  ]
  const result = await runSearchChain({ candidates, request, timeoutMs: 50, createError })
  assert.equal(result.sources[0].url, 'https://good.example/')
})

test('skips providers whose available() is false or throws', async () => {
  const called = []
  const candidates = [
    entry('off', {
      available: () => false,
      search: async () => {
        called.push('off')
        return { sources: [{ url: 'https://off.example/' }] }
      },
    }),
    entry('throws', {
      available: () => {
        throw new Error('bad config')
      },
    }),
    entry('good', {
      search: async () => {
        called.push('good')
        return { sources: [{ url: 'https://good.example/' }] }
      },
    }),
  ]
  const result = await runSearchChain({ candidates, request, timeoutMs: 50, createError })
  assert.equal(result.sources[0].url, 'https://good.example/')
  assert.deepEqual(called, ['good'])
})

test('a slow provider times out and the next provider serves', async () => {
  const candidates = [
    entry('slow', {
      search: (searchRequest, signal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => resolve({ sources: [{ url: 'https://slow.example/' }] }),
            5000,
          )
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              reject(new Error('aborted'))
            },
            { once: true },
          )
        }),
    }),
    entry('good'),
  ]
  const result = await runSearchChain({ candidates, request, timeoutMs: 30, createError })
  assert.equal(result.sources[0].url, 'https://good.example/')
})

test('a provider that ignores the signal still loses its turn at the deadline', async () => {
  const candidates = [
    entry('ignores', { search: () => new Promise(() => {}) }),
    entry('good'),
  ]
  const result = await runSearchChain({ candidates, request, timeoutMs: 30, createError })
  assert.equal(result.sources[0].url, 'https://good.example/')
})

test('a result that lands after the deadline is not this attempt outcome', async () => {
  const candidates = [
    entry('late', {
      search: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ sources: [{ url: 'https://late.example/' }] }), 80)
        }),
    }),
    entry('good'),
  ]
  const result = await runSearchChain({ candidates, request, timeoutMs: 20, createError })
  assert.equal(result.sources[0].url, 'https://good.example/')
})

test('a caller abort is honored promptly even when the provider ignores the signal', async () => {
  const controller = new AbortController()
  const candidates = [entry('ignores', { search: () => new Promise(() => {}) })]
  const started = Date.now()
  const promise = runSearchChain({
    candidates,
    request,
    signal: controller.signal,
    timeoutMs: 5000,
    createError,
  })
  const timer = setTimeout(() => controller.abort(new Error('cancelled')), 20)
  try {
    await assert.rejects(promise, (error) => error.code === 'WEB_ABORTED')
  } finally {
    clearTimeout(timer)
  }
  assert.ok(Date.now() - started < 1000, 'the abort must not wait for the 5 s budget')
})

test('a rejection provoked by the deadline is reported as a timeout', async () => {
  // The provider rejects with its own generic shape (what undici surfaces when
  // an in-flight fetch is aborted) rather than a WEB_ABORTED WebError. The
  // deadline still owns the label: the text describes the abort, not a cause.
  const candidates = [
    entry('generic-abort', {
      search: (searchRequest, signal) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('socket hang up')), { once: true })
        }),
    }),
  ]
  await assert.rejects(
    runSearchChain({ candidates, request, timeoutMs: 20, createError }),
    (error) => {
      assert.match(error.message, /generic-abort: timeout: timed out after 20 ms/)
      return true
    },
  )
})

test('a provider failure that beats the deadline keeps its own message', async () => {
  const real = new StubError('Exa API error (HTTP 401)', 'WEB_PROVIDER_ERROR')
  const candidates = [
    entry('fast-fail', {
      search: async () => {
        throw real
      },
    }),
  ]
  await assert.rejects(
    runSearchChain({ candidates, request, timeoutMs: 5000, createError }),
    (error) => {
      assert.match(error.message, /fast-fail: error: WEB_PROVIDER_ERROR: Exa API error \(HTTP 401\)/)
      assert.equal(error.cause, real)
      return true
    },
  )
})

test('a result that lands after a caller abort is never returned', async () => {
  const controller = new AbortController()
  const candidates = [
    entry('ignores', {
      search: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ sources: [{ url: 'https://late.example/' }] }), 80)
        }),
    }),
  ]
  const promise = runSearchChain({
    candidates,
    request,
    signal: controller.signal,
    timeoutMs: 5000,
    createError,
  })
  const timer = setTimeout(() => controller.abort(), 20)
  try {
    await assert.rejects(promise, (error) => error.code === 'WEB_ABORTED')
  } finally {
    clearTimeout(timer)
  }
})

test('an empty result falls through by default and can be returned when disabled', async () => {
  const candidates = [
    entry('empty', { search: async () => ({ sources: [], content: '', truncated: false }) }),
    entry('good'),
  ]
  const fallback = await runSearchChain({ candidates, request, timeoutMs: 50, createError })
  assert.equal(fallback.sources[0].url, 'https://good.example/')

  const kept = await runSearchChain({
    candidates,
    request,
    timeoutMs: 50,
    fallbackOnEmpty: false,
    createError,
  })
  assert.deepEqual(kept, { sources: [], content: '', truncated: false })
})

test('caller abort rethrows WEB_ABORTED and never tries the next provider', async () => {
  const controller = new AbortController()
  let started
  const running = new Promise((resolve) => {
    started = resolve
  })
  let secondCalled = false
  const candidates = [
    entry('slow', {
      search: (searchRequest, signal) =>
        new Promise((resolve, reject) => {
          started()
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    }),
    entry('second', {
      search: async () => {
        secondCalled = true
        return { sources: [{ url: 'https://second.example/' }] }
      },
    }),
  ]
  const promise = runSearchChain({
    candidates,
    request,
    signal: controller.signal,
    timeoutMs: 5000,
    createError,
  })
  await running
  controller.abort(new Error('user cancelled'))
  await assert.rejects(promise, (error) => error.code === 'WEB_ABORTED')
  assert.equal(secondCalled, false)
})

test('an already-aborted caller signal throws before any provider runs', async () => {
  const controller = new AbortController()
  controller.abort()
  let called = false
  const candidates = [
    entry('a', {
      search: async () => {
        called = true
        return { sources: [{ url: 'https://a.example/' }] }
      },
    }),
  ]
  await assert.rejects(
    runSearchChain({
      candidates,
      request,
      signal: controller.signal,
      timeoutMs: 50,
      createError,
    }),
    (error) => error.code === 'WEB_ABORTED',
  )
  assert.equal(called, false)
})

test('every attempt failing produces one aggregate WEB_PROVIDER_ERROR', async () => {
  const first = new StubError('Exa API error (HTTP 401)', 'WEB_PROVIDER_ERROR')
  const candidates = [
    entry('exa', {
      search: async () => {
        throw first
      },
    }),
    entry('deepseek-official', {
      search: async () => {
        throw new StubError('no API key for "DEEPSEEK_API_KEY"', 'WEB_PROVIDER_CREDENTIAL_MISSING')
      },
    }),
  ]
  await assert.rejects(
    runSearchChain({ candidates, request, timeoutMs: 50, createError }),
    (error) => {
      assert.equal(error.code, 'WEB_PROVIDER_ERROR')
      assert.match(error.message, /exa: error: WEB_PROVIDER_ERROR: Exa API error \(HTTP 401\)/)
      assert.match(error.message, /deepseek-official: error: WEB_PROVIDER_CREDENTIAL_MISSING/)
      assert.equal(error.cause, first)
      return true
    },
  )
})

test('no candidate produces WEB_PROVIDER_UNAVAILABLE with the configuration named', async () => {
  await assert.rejects(
    runSearchChain({
      candidates: [],
      request,
      timeoutMs: 50,
      createError,
      providerId: 'auto-fallback',
      order: ['exa'],
      exclude: ['brave'],
      registryCount: 1,
    }),
    (error) => {
      assert.equal(error.code, 'WEB_PROVIDER_UNAVAILABLE')
      assert.match(error.message, /no candidate provider to try/)
      assert.match(error.message, /order: \[exa\]/)
      assert.match(error.message, /exclude: \[brave\]/)
      return true
    },
  )
})

test('a chain of only unavailable providers reports WEB_PROVIDER_UNAVAILABLE', async () => {
  const candidates = [entry('a', { available: () => false }), entry('b', { available: () => false })]
  await assert.rejects(
    runSearchChain({ candidates, request, timeoutMs: 50, createError }),
    (error) => {
      assert.equal(error.code, 'WEB_PROVIDER_UNAVAILABLE')
      assert.match(error.message, /a: unavailable/)
      assert.match(error.message, /b: unavailable/)
      return true
    },
  )
})

test('the request is forwarded unchanged to each candidate', async () => {
  const seen = []
  const candidates = [
    entry('a', {
      search: async (searchRequest) => {
        seen.push(searchRequest)
        throw new Error('nope')
      },
    }),
    entry('b', {
      search: async (searchRequest) => {
        seen.push(searchRequest)
        return { sources: [{ url: 'https://b.example/' }] }
      },
    }),
  ]
  await runSearchChain({ candidates, request, timeoutMs: 50, createError })
  assert.deepEqual(seen, [request, request])
})

test('skipped and unknown entries are listed in the aggregate message', async () => {
  const candidates = [entry('a', { available: () => false })]
  await assert.rejects(
    runSearchChain({
      candidates,
      request,
      timeoutMs: 50,
      createError,
      skipped: [{ id: 'brave', reason: 'excluded' }],
      unknownOrderIds: ['ghost'],
    }),
    (error) => {
      assert.match(error.message, /brave: skipped \(excluded\)/)
      assert.match(error.message, /ghost: not registered \(ignored from order\)/)
      return true
    },
  )
})
