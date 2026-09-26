/**
 * `dsh-web-search-order` — ordered, self-healing web search for DSH.
 *
 * Registers one `ctx.web` search provider (`auto-fallback`) that walks a
 * configured provider order and falls through on missing configuration,
 * provider errors, per-attempt timeouts, and (by default) empty results. It
 * composes with whatever search providers the deployment already mounts, so it
 * changes neither the model-facing `web_search` tool nor any provider adapter.
 *
 * The seam selects exactly one provider, so a deployment opts in by pinning
 * `searchProvider: auto-fallback` on the `web` row (or exporting
 * `DSH_WEB_SEARCH_PROVIDER=auto-fallback`).
 *
 * @module dsh-web-search-order
 */
import z from '@deepseek-ai/schemastery'
import { DEFAULT_TIMEOUT_SECONDS } from './order.js'
import { AutoFallbackSearchProvider } from './provider.js'
import { snapshotSearchProviders } from './registry.js'

/** Stable provider id; this is the value `searchProvider` must name. */
export const PROVIDER_ID = 'auto-fallback'
/** Settings namespace holding the user-overridable router section. */
export const SETTINGS_NAMESPACE = 'web-search-order'
/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-order'
/** The web seam this router registers into. */
export const inject = ['web']

/**
 * Router configuration.
 *
 * Every field is optional and resolves in the seam's usual order: schema
 * defaults, then the composition row config, then the `web-search-order:`
 * section of `$DSH_HOME/settings.yaml` (hot-reloaded).
 */
export const Config = z.object({
  order: z
    .array(z.string())
    .default([])
    .description(
      'Search provider ids, most preferred first. Providers omitted here follow in registry order; an empty list keeps registry order. Unknown ids are ignored.',
    ),
  exclude: z
    .array(z.string())
    .default([])
    .description('Provider ids that must never be tried, including as a preferred candidate.'),
  timeoutSeconds: z
    .number()
    .min(1)
    .default(DEFAULT_TIMEOUT_SECONDS)
    .description(
      'Per-attempt budget, in seconds. This is router policy (the seam has no per-provider timeout); keep it well under tool-web searchTimeoutMs so a slow provider cannot consume the whole call.',
    ),
  fallbackOnEmpty: z
    .boolean()
    .default(true)
    .description('Treat a result with no sources and no answer text as a miss and try the next provider.'),
})

/**
 * Whether this harness still exposes the namespace-registration settings API.
 *
 * DSH `0.1.7-alpha.1` deleted `@deepseek-ai/dsh-settings-file` and inverted the
 * `ctx.settings` contract: `installSection` is gone, and `ctx.settings` is now
 * `SettingsForms`, which projects each Loader entry's own `runtime.Config` into
 * the Settings page and persists edits on the profile patch. Registering a
 * namespace there is a `TypeError`, not a no-op, so this has to be a feature
 * test rather than a version comparison.
 *
 * @param settings - the `ctx.settings` service, when the composition mounts it.
 * @returns whether the legacy namespace-registration call is available.
 */
export function supportsSettingsSection(settings) {
  return settings !== null && typeof settings === 'object' && typeof settings.installSection === 'function'
}

/**
 * Register the router with `ctx.web` and its settings section with
 * `ctx.settings` when that service is mounted.
 *
 * @param ctx - the plugin context; `web` is a hard dependency, `settings` is optional.
 * @param config - the composition row config, used as the settings base layer.
 */
export function apply(ctx, config) {
  let current = () => config

  ctx.inject(['settings'], (settingsCtx) => {
    // On 0.1.6+ the row's own `Config` is the settings surface: the host derives
    // the form from it and writes edits back into its `Volatile` fields, so the
    // resolved config keeps flowing in through `config` above and there is
    // nothing to register. Only the older API needs this call.
    if (!supportsSettingsSection(settingsCtx.settings)) return
    settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, config, {
      setSource: (source) => {
        current = source
      },
      onChange: () => {},
    })
  })

  // Reported through `snapshotSearchProviders` so `registry.js` stays the only
  // module that knows how the seam stores its providers.
  if (snapshotSearchProviders(ctx.web) === undefined) {
    ctx.logger.warn(
      `${name}: ctx.web does not expose a readable search-provider registry ` +
        `(expected a Map at ctx.web.searchProviders); ${PROVIDER_ID} will report WEB_PROVIDER_UNAVAILABLE`,
    )
  }

  // `WebRuntime.registerProvider` scopes its effect to the CALLING fiber — the
  // seam's own doc comment says "disposed with the calling fiber", and disposing
  // this plugin's fiber unregisters its provider (see test/reload.test.js). No
  // extra wrapper is needed, which is also how the shipped provider plugins
  // mount theirs.
  ctx.web.registerSearchProvider(
    new AutoFallbackSearchProvider({
      id: PROVIDER_ID,
      web: ctx.web,
      logger: ctx.logger,
      resolveConfig: () => current(),
    }),
  )
}
