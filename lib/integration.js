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
// Store resolved config for CLI access
let resolvedConfig = null;
export function getResolvedConfig() {
    return resolvedConfig;
}
export function setResolvedConfig(config) {
    resolvedConfig = config;
}
/**
 * Astro integration for AI content translation.
 */
export default function aiTranslator(options = {}) {
    return {
        name: "astro-content-ai-translator",
        hooks: {
            "astro:config:done": ({ config }) => {
                // Extract i18n config from Astro
                const i18n = config.i18n;
                const locales = i18n?.locales?.map((l) => typeof l === "string" ? l : l.path) || [];
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
                });
                // Log setup info
                console.log(`[ai-translator] Configured with ${locales.length} locales`);
            },
        },
    };
}
