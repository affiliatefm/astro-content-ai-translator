/**
 * Astro Content AI Translator
 * ============================
 * AI-powered translation for Astro content collections.
 *
 * Usage:
 *   // astro.config.mjs
 *   import aiTranslator from "astro-content-ai-translator";
 *
 *   export default defineConfig({
 *     integrations: [aiTranslator({ model: "gpt-4.1" })],
 *   });
 *
 * CLI:
 *   npx astro-ai-translate [file] [options]
 */
export { default } from "./integration.js";
export type { AiTranslatorOptions, ResolvedConfig } from "./integration.js";
export { translate, status, type TranslateOptions, type TranslationResult } from "./core.js";
