/**
 * The `auto-fallback` search provider: an ordered chain over the providers the
 * deployment already registered with `ctx.web`.
 *
 * The provider is intentionally thin — it snapshots configuration and the live
 * registry once per operation, then delegates ordering and the fallback walk to
 * the pure `order.js` module. It adds no HTTP client and no credential handling
 * of its own, so a provider that is added, removed, or reconfigured elsewhere in
 * the tree is picked up on the next search without re-registering anything.
 *
 * @module dsh-web-search-order/provider
 */
import { createWebError } from './errors.js'
import { resolveCandidates, runSearchChain, timeoutSecondsToMs } from './order.js'
import { snapshotSearchProviders } from './registry.js'

/** Diagnostic for a DSH version whose registry this plugin cannot read. */
const REGISTRY_HELP =
  'this DSH version does not expose a readable ctx.web search-provider registry ' +
  '(expected a Map at ctx.web.searchProviders); the plugin supports @deepseek-ai/dsh-web 0.1.5-alpha.1'

/**
 * The router provider.
 *
 * `available()` is constantly true so the router's own per-provider diagnostic
 * always reaches the caller (see its JSDoc). `search()` performs the ordered
 * walk and returns the first usable result unchanged, so the seam still
 * enforces `maxResults`.
 */
export class AutoFallbackSearchProvider {
  /**
   * @param options - the provider id, the web service to read, a logger, and a
   *   thunk resolving the currently authoritative configuration section (the
   *   settings layer when attached, otherwise the composition row config).
   */
  constructor(options) {
    /** Stable id this router registers under; also the value `searchProvider` must name. */
    this.id = options.id
    this.web = options.web
    this.logger = options.logger
    this.resolveConfig = options.resolveConfig
    this.registryWarned = false
    /** Order ids already reported as unregistered, so a global mount stays quiet. */
    this.warnedUnknownOrderIds = new Set()
  }

  /**
   * Always true: this is a meta-provider whose execution path owns every
   * failure report.
   *
   * The seam calls `available()` before `search()` and, on false, replaces the
   * outcome with its generic `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` message. A
   * router that returned false whenever its candidate list was empty (all
   * excluded, empty registry, unreadable registry) would therefore hide the
   * one thing the user needs: which providers exist and why none could run.
   * Returning true lets `search()` raise the per-provider diagnostic instead.
   *
   * This mirrors the shipped `dsh-web-search-deepseek` provider, whose
   * `resolveApiKey` is always defined and which therefore also reports missing
   * credentials at search time rather than through `available()`.
   *
   * @returns true; `search()` owns selection and failure detail.
   */
  available() {
    return true
  }

  /**
   * Run one search down the ordered chain.
   *
   * @param request - the seam's search request, forwarded unchanged.
   * @param signal - the caller's cancellation signal, honored immediately.
   * @returns the first usable provider result.
   * @throws {import('@deepseek-ai/dsh-web').WebError} `WEB_ABORTED` on caller
   *   cancellation, `WEB_PROVIDER_UNAVAILABLE` when no candidate could be tried,
   *   or `WEB_PROVIDER_ERROR` when every attempt failed.
   */
  async search(request, signal) {
    const config = this.resolveConfig()
    const providers = snapshotSearchProviders(this.web)
    if (providers === undefined) {
      this.warnRegistryOnce()
      throw createWebError(
        `web search router "${this.id}" cannot enumerate providers: ${REGISTRY_HELP}`,
        'WEB_PROVIDER_UNAVAILABLE',
      )
    }

    const { candidates, skipped, unknownOrderIds } = resolveCandidates(providers, {
      order: config.order,
      exclude: config.exclude,
      selfId: this.id,
    })
    for (const id of unknownOrderIds) {
      if (this.warnedUnknownOrderIds.has(id)) continue
      this.warnedUnknownOrderIds.add(id)
      this.logger?.warn?.(
        `${this.id}: order names "${id}", which is not registered; it is ignored until that provider is mounted`,
      )
    }

    return runSearchChain({
      candidates,
      skipped,
      unknownOrderIds,
      request,
      signal,
      timeoutMs: timeoutSecondsToMs(config.timeoutSeconds),
      fallbackOnEmpty: config.fallbackOnEmpty !== false,
      createError: createWebError,
      logger: this.logger,
      providerId: this.id,
      order: config.order,
      exclude: config.exclude,
      registryCount: providers.length,
    })
  }

  /** Warn once per provider instance about an unreadable registry. */
  warnRegistryOnce() {
    if (this.registryWarned) return
    this.registryWarned = true
    this.logger?.warn?.(`${this.id}: ${REGISTRY_HELP}`)
  }
}
