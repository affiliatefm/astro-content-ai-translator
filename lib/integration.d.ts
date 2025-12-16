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
import type { AstroIntegration } from "astro";
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
}
export interface ResolvedConfig {
    model: string;
    contentDir: string;
    prompt?: string;
    locales: string[];
    defaultLocale: string;
    root: string;
}
export declare function getResolvedConfig(): ResolvedConfig | null;
export declare function setResolvedConfig(config: ResolvedConfig): void;
/**
 * Astro integration for AI content translation.
 */
export default function aiTranslator(options?: AiTranslatorOptions): AstroIntegration;
export type { AstroIntegration };
