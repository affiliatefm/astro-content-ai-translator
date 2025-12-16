/**
 * Core Translation Logic
 * =======================
 * Translation engine used by both integration and CLI.
 */
import type { ResolvedConfig } from "./integration.js";
export interface TranslateOptions {
    file?: string;
    dryRun?: boolean;
    force?: boolean;
}
export interface TranslationResult {
    source: string;
    target: string;
    locale: string;
    status: "created" | "skipped" | "error";
    error?: string;
}
interface SourceFile {
    path: string;
    relativePath: string;
    locale: string;
    frontmatter: Record<string, unknown>;
    content: string;
    raw: string;
    hash: string;
    translateTo: string[] | false;
}
/**
 * Scan content directory for source files.
 */
export declare function scanContent(config: ResolvedConfig): Promise<SourceFile[]>;
/**
 * Translate content files.
 */
export declare function translate(config: ResolvedConfig, options?: TranslateOptions): Promise<TranslationResult[]>;
/**
 * Show translation status.
 */
export declare function status(config: ResolvedConfig): Promise<void>;
export {};
