/**
 * Astro Content AI Translator - Integration
 * ==========================================
 * Astro integration for AI-powered content translation.
 *
 * Usage in astro.config.mjs:
 *   import aiTranslator from "astro-content-ai-translator";
 *
 *   export default defineConfig({
 *     integrations: [
 *       aiTranslator({
 *         model: "gpt-4.1",
 *       })
 *     ],
 *   });
 */

import type { AstroIntegration, AstroConfig } from "astro";

export interface AiTranslatorOptions {
  /**
   * OpenAI model to use.
   * @default "gpt-4.1"
   */
  model?: string;

  /**
   * Content directory relative to project root.
   * @default Inferred from content collections or "src/content/pages"
   */
  contentDir?: string;

  /**
   * Custom translation prompt.
   */
  prompt?: string;

  /**
   * Update alternates in source and translated files.
   * When true, adds hreflang links between original and translated pages.
   * @default true
   */
  updateAlternates?: boolean;
}

export interface ResolvedConfig {
  model: string;
  contentDir: string;
  prompt?: string;
  locales: string[];
  defaultLocale: string;
  root: string;
  updateAlternates: boolean;
}

// Store resolved config for CLI access
let resolvedConfig: ResolvedConfig | null = null;

export function getResolvedConfig(): ResolvedConfig | null {
  return resolvedConfig;
}

export function setResolvedConfig(config: ResolvedConfig): void {
  resolvedConfig = config;
}

/**
 * Astro integration for AI content translation.
 */
export default function aiTranslator(options: AiTranslatorOptions = {}): AstroIntegration {
  return {
    name: "astro-content-ai-translator",
    hooks: {
      "astro:config:done": ({ config }) => {
        // Extract i18n config from Astro
        const i18n = config.i18n;
        const locales = i18n?.locales?.map((l) =>
          typeof l === "string" ? l : l.path
        ) || [];
        const defaultLocale = i18n?.defaultLocale || locales[0] || "en";

        // Resolve content directory
        const contentDir = options.contentDir || "src/content/pages";

        // Store resolved config
        setResolvedConfig({
          model: options.model || "gpt-4.1",
          contentDir,
          prompt: options.prompt,
          locales,
          defaultLocale,
          root: config.root.pathname,
          updateAlternates: options.updateAlternates !== false,
        });

        // Log setup info
        console.log(`[ai-translator] Configured with ${locales.length} locales`);
      },
    },
  };
}

// Re-export types
export type { AstroIntegration };
