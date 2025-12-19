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
    onProgress?: (progress: TranslationProgress) => void;
}
export interface TranslationResult {
    source: string;
    target: string;
    locale: string;
    status: "created" | "skipped" | "error";
    error?: string;
    /** Files that had their alternates updated */
    alternatesUpdated?: string[];
}
export interface TranslationProgress {
    current: number;
    total: number;
    currentFile: string;
    targetLocale: string;
    phase: "starting" | "translating" | "writing" | "done";
}
export interface TranslationEstimate {
    files: EstimateFile[];
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    estimatedCostUSD: number;
    model: string;
}
export interface EstimateFile {
    source: string;
    targetLocale: string;
    inputTokens: number;
    outputTokens: number;
    skipped: boolean;
    skipReason?: string;
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
 * Estimate translation cost before running.
 */
export declare function estimate(config: ResolvedConfig, options?: Pick<TranslateOptions, "file" | "force">): Promise<TranslationEstimate>;
/**
 * Translate content files.
 */
export declare function translate(config: ResolvedConfig, options?: TranslateOptions): Promise<TranslationResult[]>;
/**
 * Show translation status.
 */
export declare function status(config: ResolvedConfig): Promise<void>;
export {};
