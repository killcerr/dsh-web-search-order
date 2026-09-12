/**
 * Guarded read of the live `ctx.web` search-provider registry.
 *
 * `@deepseek-ai/dsh-web` deliberately exposes no provider-enumeration API: the
 * seam owns selection, and callers reach providers only through `ctx.web.search`.
 * A router therefore has to read the registry the service already keeps. That
 * field is an implementation detail, so this module is the single place that
 * depends on it and it fails closed — `undefined` — when the shape is not the
 * one this plugin supports, instead of throwing deep inside a search.
 *
 * @module dsh-web-search-order/registry
 */

/**
 * Snapshot the registered search providers in registry order.
 *
 * @param web - the `ctx.web` service instance.
 * @returns `{ id, provider }` entries in insertion order, or `undefined` when
 *   this DSH version does not expose a readable provider `Map`.
 */
export function snapshotSearchProviders(web) {
  if (web === null || typeof web !== 'object') return undefined
  const registry = web.searchProviders
  if (!(registry instanceof Map)) return undefined
  const providers = []
  for (const provider of registry.values()) {
    if (provider === null || typeof provider !== 'object') continue
    const { id } = provider
    if (typeof id !== 'string' || id.length === 0) continue
    providers.push({ id, provider })
  }
  return providers
}
