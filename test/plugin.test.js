import test from 'node:test'
import assert from 'node:assert/strict'
import { Config, PROVIDER_ID, SETTINGS_NAMESPACE, apply, inject, name } from '../lib/index.js'

/** Minimal provider stub that echoes its own id in the result. */
function stubProvider(id) {
  return {
    id,
    available: () => true,
    search: async () => ({ sources: [{ url: `https://${id}.example/` }], truncated: false }),
  }
}

/** Minimal cordis context: `effect`, `inject(['settings'])`, `web`, and a logger. */
function createHarness(options = {}) {
  const registered = []
  const warnings = []
  const sections = []
  const disposers = []
  const searchProviders = options.searchProviders ?? new Map()

  const web = {
    registerSearchProvider(provider) {
      if (registered.some((entry) => entry.id === provider.id)) {
        throw new Error(`duplicate provider ${provider.id}`)
      }
      registered.push(provider)
      return () => {
        const index = registered.indexOf(provider)
        if (index >= 0) registered.splice(index, 1)
      }
    },
  }
  if (options.registry !== 'missing') web.searchProviders = searchProviders

  const ctx = {
    web,
    logger: { warn: (message) => warnings.push(String(message)), info() {} },
    effect(callback) {
      const dispose = callback()
      disposers.push(dispose)
      return dispose
    },
    inject(names, callback) {
      if (!names.includes('settings')) return
      callback({
        settings: {
          installSection(owner, ns, schema, entry, hooks) {
            sections.push({ owner, ns, schema, entry, hooks })
          },
        },
      })
    },
  }

  return { ctx, registered, warnings, sections, disposers, searchProviders }
}

test('exports the loader contract', () => {
  assert.equal(name, 'web-search-order')
  assert.deepEqual([...inject], ['web'])
  assert.equal(PROVIDER_ID, 'auto-fallback')
  assert.equal(SETTINGS_NAMESPACE, 'web-search-order')
})

test('Config applies defaults and enforces bounds', () => {
  const resolved = Config({})
  assert.deepEqual(resolved.order, [])
  assert.deepEqual(resolved.exclude, [])
  assert.equal(resolved.timeoutSeconds, 20)
  assert.equal(resolved.fallbackOnEmpty, true)

  const explicit = Config({ order: ['exa'], timeoutSeconds: 5 })
  assert.deepEqual(explicit.order, ['exa'])
  assert.equal(explicit.timeoutSeconds, 5)

  assert.throws(() => Config({ timeoutSeconds: 0 }))
  // No upper bound: a large budget is the user's call, and the caller's own
  // budget still bounds the call.
  assert.equal(Config({ timeoutSeconds: 301 }).timeoutSeconds, 301)
  assert.throws(() => Config({ order: 'exa' }))
})

test('apply registers the router provider', () => {
  const { ctx, registered } = createHarness()
  apply(ctx, Config({ order: ['a'], timeoutSeconds: 5 }))
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, PROVIDER_ID)
  assert.equal(typeof registered[0].search, 'function')
  assert.equal(typeof registered[0].available, 'function')
})

test('apply installs the settings section over the row config', () => {
  const { ctx, sections } = createHarness()
  const rowConfig = Config({ order: ['b', 'a'], timeoutSeconds: 5 })
  apply(ctx, rowConfig)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].ns, SETTINGS_NAMESPACE)
  assert.equal(sections[0].schema, Config)
  assert.equal(sections[0].entry, rowConfig)
  assert.equal(typeof sections[0].hooks.setSource, 'function')
  assert.equal(typeof sections[0].hooks.onChange, 'function')
})

test('the settings source wins over the row config on the next search', async () => {
  const searchProviders = new Map([
    ['a', stubProvider('a')],
    ['b', stubProvider('b')],
  ])
  const { ctx, registered, sections } = createHarness({ searchProviders })
  apply(ctx, Config({ order: ['b', 'a'], timeoutSeconds: 5 }))

  const router = registered[0]
  const first = await router.search({ query: 'q' })
  assert.equal(first.sources[0].url, 'https://b.example/')

  sections[0].hooks.setSource(() => Config({ order: ['a', 'b'], timeoutSeconds: 5 }))
  const second = await router.search({ query: 'q' })
  assert.equal(second.sources[0].url, 'https://a.example/')
})

test('excluded providers are never tried through the plugin', async () => {
  const searchProviders = new Map([
    ['a', stubProvider('a')],
    ['b', stubProvider('b')],
  ])
  const { ctx, registered } = createHarness({ searchProviders })
  apply(ctx, Config({ order: ['a', 'b'], exclude: ['a'], timeoutSeconds: 5 }))
  const result = await registered[0].search({ query: 'q' })
  assert.equal(result.sources[0].url, 'https://b.example/')
})

test('available() is constantly true so the router owns failure reporting', () => {
  const unusable = {
    id: 'b',
    available: () => false,
    search: async () => ({ sources: [], truncated: false }),
  }
  const harness = createHarness({ searchProviders: new Map([['b', unusable]]) })
  apply(harness.ctx, Config({ order: ['b'], exclude: ['b'], timeoutSeconds: 5 }))
  assert.equal(harness.registered[0].available(), true)
})

test('an unregistered order id warns once per provider instance', async () => {
  const harness = createHarness({ searchProviders: new Map([['a', stubProvider('a')]]) })
  apply(harness.ctx, Config({ order: ['ghost', 'a'], timeoutSeconds: 5 }))
  const router = harness.registered[0]

  await router.search({ query: 'q' })
  await router.search({ query: 'q' })

  const ghostWarnings = harness.warnings.filter((message) => message.includes('"ghost"'))
  assert.equal(ghostWarnings.length, 1)
  assert.match(ghostWarnings[0], /not registered/)
})

test('apply registers the provider without adding an effect of its own', () => {
  // `registerSearchProvider` already scopes the registration to this plugin's
  // fiber — disposing that fiber unregisters the provider (test/contract.test.js).
  // Wrapping it in a second ctx.effect would dispose the same registration twice.
  const { ctx, registered, disposers } = createHarness()
  apply(ctx, Config({}))
  assert.equal(registered.length, 1)
  assert.deepEqual(disposers, [])
})

test('an unreadable registry warns at load and fails the search closed', async () => {
  const { ctx, registered, warnings } = createHarness({ registry: 'missing' })
  apply(ctx, Config({}))
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /search-provider registry/)

  assert.equal(registered[0].available(), true)
  await assert.rejects(
    registered[0].search({ query: 'q' }),
    (error) => error.code === 'WEB_PROVIDER_UNAVAILABLE' && /cannot enumerate providers/.test(error.message),
  )
})
