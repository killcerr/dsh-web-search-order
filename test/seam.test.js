import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { WebRuntime } from '@deepseek-ai/dsh-web'
import { Config, apply } from '../lib/index.js'

/** Provider stub; overrides replace `available` and/or `search`. */
function stubProvider(id, overrides = {}) {
  return {
    id,
    available: overrides.available ?? (() => true),
    search:
      overrides.search ??
      (async () => ({ sources: [{ url: `https://${id}.example/` }], truncated: false })),
  }
}

/**
 * A real `ctx.web` seam (the shipped `WebRuntime`) with this plugin applied on
 * top, so selection, `available()`, error codes, and `maxResults` capping are
 * exercised exactly as the harness runs them.
 */
function harness(config, providers) {
  const ctx = new Context()
  const web = new WebRuntime(ctx, { searchProvider: 'auto-fallback' })
  for (const provider of providers) web.registerSearchProvider(provider)
  apply(ctx, Config(config))
  return { ctx, web }
}

test('the real seam selects the router and falls back to the next provider', async () => {
  const { web } = harness({ order: ['exa', 'deepseek-official'], timeoutSeconds: 5 }, [
    stubProvider('exa', {
      search: async () => {
        throw new Error('Exa API error (HTTP 401)')
      },
    }),
    stubProvider('deepseek-official'),
  ])

  const result = await web.search({ query: 'q', maxResults: 8 })
  assert.equal(result.sources[0].url, 'https://deepseek-official.example/')
  assert.equal(result.truncated, false)
})

test('an empty registry list surfaces the router diagnostic, not the seam generic message', async () => {
  const { web } = harness({ order: [], exclude: ['exa', 'deepseek-official'], timeoutSeconds: 5 }, [
    stubProvider('exa'),
    stubProvider('deepseek-official'),
  ])

  await assert.rejects(
    web.search({ query: 'q' }),
    (error) => {
      assert.equal(error.code, 'WEB_PROVIDER_UNAVAILABLE')
      assert.match(error.message, /web search router "auto-fallback" has no candidate provider to try/)
      assert.match(error.message, /exa: skipped \(excluded\)/)
      assert.doesNotMatch(error.message, /is registered but unavailable/)
      return true
    },
  )
})

test('the seam caps the router result at maxResults', async () => {
  const many = stubProvider('exa', {
    search: async () => ({
      sources: [1, 2, 3, 4, 5].map((n) => ({ url: `https://exa.example/${n}` })),
      truncated: false,
    }),
  })
  const { web } = harness({ order: ['exa'], timeoutSeconds: 5 }, [many])

  const result = await web.search({ query: 'q', maxResults: 2 })
  assert.equal(result.sources.length, 2)
  assert.equal(result.truncated, true)
})

test('a caller abort through the real seam stops the walk without fallback', async () => {
  let secondCalled = false
  const controller = new AbortController()
  let started
  const running = new Promise((resolve) => {
    started = resolve
  })
  const { web } = harness({ order: ['slow', 'next'], timeoutSeconds: 300 }, [
    stubProvider('slow', {
      search: (request, signal) =>
        new Promise((resolve, reject) => {
          started()
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    }),
    stubProvider('next', {
      search: async () => {
        secondCalled = true
        return { sources: [{ url: 'https://next.example/' }], truncated: false }
      },
    }),
  ])

  const promise = web.search({ query: 'q' }, controller.signal)
  await running
  controller.abort(new Error('user cancelled'))
  await assert.rejects(promise, (error) => error.code === 'WEB_ABORTED')
  assert.equal(secondCalled, false)
})
