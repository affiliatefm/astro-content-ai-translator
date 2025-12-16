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
// Main integration export
export { default } from "./integration.js";
// Core functionality exports
export { translate, status, estimate, } from "./core.js";
