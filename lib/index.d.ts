/**
 * Public types for `dsh-web-search-order`.
 *
 * The plugin is authored in plain ESM JavaScript; this declaration is the
 * hand-written contract for consumers that type-check against it.
 *
 * @module dsh-web-search-order
 */
import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'

/** Stable provider id; this is the value `searchProvider` must name. */
export declare const PROVIDER_ID = 'auto-fallback'
/** Settings namespace holding the user-overridable router section. */
export declare const SETTINGS_NAMESPACE = 'web-search-order'
/** Cordis plugin name used by loader diagnostics. */
export declare const name: string
/** The web seam this router registers into. */
export declare const inject: readonly ['web']

/** Router configuration, resolved as schema defaults → row config → user settings. */
export interface AutoFallbackConfig {
  /** Provider ids, most preferred first; omitted providers follow in registry order. */
  order?: string[]
  /** Provider ids that must never be tried, including as a preferred candidate. */
  exclude?: string[]
  /** Per-attempt budget in seconds (>= 1, default 20); router policy, not a seam limit. */
  timeoutSeconds?: number
  /** Treat a result with no sources and no answer text as a miss (default true). */
  fallbackOnEmpty?: boolean
}

/** Router configuration schema. */
export declare const Config: z<AutoFallbackConfig>

/**
 * Register the router provider and its settings section.
 *
 * @param ctx - the plugin context; `web` is a hard dependency.
 * @param config - the composition row config, used as the settings base layer.
 */
export declare function apply(ctx: Context, config: AutoFallbackConfig): void
