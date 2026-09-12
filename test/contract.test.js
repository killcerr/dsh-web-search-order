import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { WebRuntime } from '@deepseek-ai/dsh-web'
import { Config, PROVIDER_ID, apply } from '../lib/index.js'

/**
 * Contracts of the shipped seam this plugin depends on but cannot control.
 *
 * These assertions are deliberately about the DEPENDENCY, not about our code:
 * they fail loudly on a DSH upgrade that changes the shape we read or the fiber
 * a registration belongs to, instead of degrading into a runtime symptom.
 */

test('the registry this plugin reads is still a Map on ctx.web', () => {
  const ctx = new Context()
  const web = new WebRuntime(ctx, {})
  assert.ok(
    web.searchProviders instanceof Map,
    'snapshotSearchProviders() reads ctx.web.searchProviders and fails closed when it is not a Map',
  )
})

test('the seam disposes a provider with the fiber that registered it', async () => {
  const ctx = new Context()
  const web = new WebRuntime(ctx, { searchProvider: PROVIDER_ID })

  const mount = () =>
    ctx.plugin({
      name: 'web-search-order',
      apply: (pluginCtx) => apply(pluginCtx, Config({ order: [], timeoutSeconds: 20 })),
    })

  const first = mount()
  await Promise.resolve()
  assert.ok(web.searchProviders.has(PROVIDER_ID), 'the plugin mounts its provider')

  await first.dispose()
  await Promise.resolve()
  assert.equal(
    web.searchProviders.has(PROVIDER_ID),
    false,
    'registerSearchProvider owns its registration on the CALLING fiber, so no extra ctx.effect wrapper is needed',
  )

  // The reload case the wrapper used to guard against.
  const second = mount()
  await Promise.resolve()
  assert.ok(web.searchProviders.has(PROVIDER_ID), 'a reload re-registers without WEB_DUPLICATE_PROVIDER')

  await second.dispose()
  await Promise.resolve()
  assert.equal(web.searchProviders.has(PROVIDER_ID), false)
})
