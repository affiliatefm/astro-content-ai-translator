/**
 * Core Translation Logic
 * =======================
 * Translation engine used by both integration and CLI.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, basename, relative } from "node:path";
import { createHash } from "node:crypto";
import { glob } from "glob";
import matter from "gray-matter";
import OpenAI from "openai";
import type { ResolvedConfig } from "./integration.js";

// =============================================================================
// TYPES
// =============================================================================

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

// =============================================================================
// PRICING (USD per 1M tokens)
// =============================================================================

interface ModelPricing {
  input: number;  // USD per 1M input tokens
  output: number; // USD per 1M output tokens
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // GPT-4.1 series (latest)
  "gpt-4.1": { input: 2.00, output: 8.00 },
  "gpt-4.1-mini": { input: 0.40, output: 1.60 },
  "gpt-4.1-nano": { input: 0.10, output: 0.40 },
  // GPT-4o series
  "gpt-4o": { input: 2.50, output: 10.00 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  // GPT-4 Turbo
  "gpt-4-turbo": { input: 10.00, output: 30.00 },
  "gpt-4-turbo-preview": { input: 10.00, output: 30.00 },
  // GPT-4
  "gpt-4": { input: 30.00, output: 60.00 },
  // GPT-3.5
  "gpt-3.5-turbo": { input: 0.50, output: 1.50 },
  // Default fallback
  "default": { input: 5.00, output: 15.00 },
};

function getModelPricing(model: string): ModelPricing {
  // Try exact match first
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  // Try prefix match (e.g., gpt-4o-2024-08-06 -> gpt-4o)
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key)) return pricing;
  }
  return MODEL_PRICING["default"];
}

/**
 * Estimate tokens from text. 
 * Rough approximation: ~4 chars per token for English, ~2-3 for other languages.
 * We use 3.5 as a conservative average.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
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

// =============================================================================
// SCANNER
// =============================================================================

/**
 * Scan content directory for source files.
 */
export async function scanContent(config: ResolvedConfig): Promise<SourceFile[]> {
  const contentDir = join(config.root, config.contentDir);
  const pattern = join(contentDir, "**/*.{md,mdx}");

  const files = await glob(pattern, { nodir: true });
  const sources: SourceFile[] = [];

  for (const filePath of files) {
    const relativePath = relative(contentDir, filePath);
    const raw = readFileSync(filePath, "utf-8");
    const { data: frontmatter, content } = matter(raw);

    // Determine locale from path
    const locale = getLocaleFromPath(relativePath, config);

    // Determine translateTo
    const translateTo = parseTranslateTo(frontmatter._translateTo, locale, config);

    sources.push({
      path: filePath,
      relativePath,
      locale,
      frontmatter,
      content: content.trim(),
      raw,
      hash: hashContent(raw),
      translateTo,
    });
  }

  return sources;
}

function getLocaleFromPath(relativePath: string, config: ResolvedConfig): string {
  const firstSegment = relativePath.split("/")[0];
  if (config.locales.includes(firstSegment) && firstSegment !== config.defaultLocale) {
    return firstSegment;
  }
  return config.defaultLocale;
}

function parseTranslateTo(
  value: unknown,
  sourceLocale: string,
  config: ResolvedConfig
): string[] | false {
  // No _translateTo field = don't translate
  if (value === undefined) return false;
  // Explicitly disabled
  if (value === false) return false;
  // Translate to specific locales
  if (Array.isArray(value)) return value.filter((l) => l !== sourceLocale);
  // Translate to all locales
  if (value === "all") {
    return config.locales.filter((l) => l !== sourceLocale);
  }
  // Single locale as string
  if (typeof value === "string") {
    return [value].filter((l) => l !== sourceLocale);
  }
  return false;
}

function getBasePath(relativePath: string, locale: string, config: ResolvedConfig): string {
  if (locale === config.defaultLocale) return relativePath;
  return relativePath.replace(new RegExp(`^${locale}/`), "");
}

function getTargetPath(source: SourceFile, targetLocale: string, config: ResolvedConfig): string {
  const basePath = getBasePath(source.relativePath, source.locale, config);
  if (targetLocale === config.defaultLocale) return basePath;
  return `${targetLocale}/${basePath}`;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

// =============================================================================
// TRANSLATOR
// =============================================================================

async function translateContent(
  source: SourceFile,
  targetLocale: string,
  config: ResolvedConfig,
  openai: OpenAI
): Promise<{ frontmatter: Record<string, string>; content: string }> {
  const systemPrompt = config.prompt || `You are a professional translator. Translate from ${source.locale} to ${targetLocale}.

Rules:
- Translate all text naturally and fluently
- Keep markdown formatting exactly as-is
- Keep code blocks, URLs, and component tags unchanged
- Only output the translation, no explanations`;

  const translatableFields = ["title", "description"];
  const fieldsToTranslate: Record<string, string> = {};

  for (const field of translatableFields) {
    if (typeof source.frontmatter[field] === "string") {
      fieldsToTranslate[field] = source.frontmatter[field] as string;
    }
  }

  let userPrompt = "";
  if (Object.keys(fieldsToTranslate).length > 0) {
    userPrompt += "FRONTMATTER:\n";
    for (const [key, value] of Object.entries(fieldsToTranslate)) {
      userPrompt += `${key}: ${value}\n`;
    }
    userPrompt += "\nCONTENT:\n";
  }
  userPrompt += source.content;

  const response = await openai.chat.completions.create({
    model: config.model,
    temperature: 0.3,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const result = response.choices[0]?.message?.content || "";
  return parseTranslationResponse(result, fieldsToTranslate);
}

function parseTranslationResponse(
  response: string,
  originalFields: Record<string, string>
): { frontmatter: Record<string, string>; content: string } {
  const frontmatter: Record<string, string> = {};
  let content = response.trim();
  const lines = content.split("\n");
  let contentStart = 0;

  if (lines[0]?.toUpperCase().includes("FRONTMATTER")) {
    contentStart = 1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.toUpperCase() === "CONTENT:" || line.startsWith("#")) {
        contentStart = line.toUpperCase() === "CONTENT:" ? i + 1 : i;
        break;
      }
      if (line.includes(":")) {
        const colonIdx = line.indexOf(":");
        const key = line.slice(0, colonIdx).trim().toLowerCase();
        const value = line.slice(colonIdx + 1).trim();
        if (key in originalFields) frontmatter[key] = value;
      }
    }
  } else {
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      const line = lines[i].trim();
      if (line.startsWith("#") || line === "") {
        contentStart = i;
        if (line === "" && i + 1 < lines.length && lines[i + 1].startsWith("#")) {
          contentStart = i + 1;
        }
        break;
      }
      if (line.includes(":") && !line.startsWith("#")) {
        const colonIdx = line.indexOf(":");
        const key = line.slice(0, colonIdx).trim().toLowerCase();
        const value = line.slice(colonIdx + 1).trim();
        if (key in originalFields) {
          frontmatter[key] = value;
          contentStart = i + 1;
        }
      }
    }
  }

  while (contentStart < lines.length && lines[contentStart].trim() === "") {
    contentStart++;
  }

  content = lines.slice(contentStart).join("\n").trim();
  return { frontmatter, content };
}

// =============================================================================
// ESTIMATE FUNCTION
// =============================================================================

/**
 * Estimate translation cost before running.
 */
export async function estimate(
  config: ResolvedConfig,
  options: Pick<TranslateOptions, "file" | "force"> = {}
): Promise<TranslationEstimate> {
  const sources = await scanContent(config);
  const pricing = getModelPricing(config.model);

  // Filter files to process
  let filesToProcess = sources.filter((s) => s.translateTo !== false);
  if (options.file) {
    filesToProcess = filesToProcess.filter(
      (s) => s.relativePath.includes(options.file!) || basename(s.path).includes(options.file!)
    );
  }

  const files: EstimateFile[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const source of filesToProcess) {
    if (!source.translateTo || source.translateTo.length === 0) continue;

    for (const targetLocale of source.translateTo) {
      const targetRelPath = getTargetPath(source, targetLocale, config);
      const targetPath = join(config.root, config.contentDir, targetRelPath);

      // Check if exists
      if (existsSync(targetPath) && !options.force) {
        files.push({
          source: source.relativePath,
          targetLocale,
          inputTokens: 0,
          outputTokens: 0,
          skipped: true,
          skipReason: "exists",
        });
        continue;
      }

      // Check by permalink
      const alternates = source.frontmatter.alternates as Record<string, string> | undefined;
      if (alternates?.[targetLocale] && !alternates[targetLocale].startsWith("http")) {
        const existing = await findFileByPermalink(
          join(config.root, config.contentDir),
          targetLocale,
          alternates[targetLocale],
          config
        );
        if (existing && !options.force) {
          files.push({
            source: source.relativePath,
            targetLocale,
            inputTokens: 0,
            outputTokens: 0,
            skipped: true,
            skipReason: "permalink exists",
          });
          continue;
        }
      }

      // Calculate tokens for this translation
      const systemPrompt = config.prompt || `You are a professional translator. Translate from ${source.locale} to ${targetLocale}.

Rules:
- Translate all text naturally and fluently
- Keep markdown formatting exactly as-is
- Keep code blocks, URLs, and component tags unchanged
- Only output the translation, no explanations`;

      const translatableFields = ["title", "description"];
      let userPrompt = "";
      
      for (const field of translatableFields) {
        if (typeof source.frontmatter[field] === "string") {
          userPrompt += `${field}: ${source.frontmatter[field]}\n`;
        }
      }
      if (userPrompt) {
        userPrompt = "FRONTMATTER:\n" + userPrompt + "\nCONTENT:\n";
      }
      userPrompt += source.content;

      const inputTokens = estimateTokens(systemPrompt + userPrompt);
      // Output is typically similar size to content (slightly more for some languages)
      const outputTokens = Math.ceil(estimateTokens(userPrompt) * 1.2);

      files.push({
        source: source.relativePath,
        targetLocale,
        inputTokens,
        outputTokens,
        skipped: false,
      });

      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;
    }
  }

  const inputCost = (totalInputTokens / 1_000_000) * pricing.input;
  const outputCost = (totalOutputTokens / 1_000_000) * pricing.output;
  const estimatedCostUSD = inputCost + outputCost;

  return {
    files,
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    estimatedCostUSD,
    model: config.model,
  };
}

// =============================================================================
// MAIN FUNCTIONS
// =============================================================================

/**
 * Translate content files.
 */
export async function translate(
  config: ResolvedConfig,
  options: TranslateOptions = {}
): Promise<TranslationResult[]> {
  const results: TranslationResult[] = [];

  // Check API key
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey && !options.dryRun) {
    throw new Error(
      "OPENAI_API_KEY not found.\n\n" +
      "Add to .env file:\n" +
      "  OPENAI_API_KEY=sk-...\n\n" +
      "Or set environment variable."
    );
  }

  const openai = apiKey ? new OpenAI({ apiKey }) : null;
  const sources = await scanContent(config);

  // Filter
  let filesToProcess = sources.filter((s) => s.translateTo !== false);
  if (options.file) {
    filesToProcess = filesToProcess.filter(
      (s) => s.relativePath.includes(options.file!) || basename(s.path).includes(options.file!)
    );
  }

  // Build list of translations to perform
  const translations: Array<{ source: SourceFile; targetLocale: string; targetRelPath: string; targetPath: string }> = [];

  for (const source of filesToProcess) {
    if (!source.translateTo || source.translateTo.length === 0) continue;

    for (const targetLocale of source.translateTo) {
      const targetRelPath = getTargetPath(source, targetLocale, config);
      const targetPath = join(config.root, config.contentDir, targetRelPath);

      // Check existing
      if (existsSync(targetPath) && !options.force) {
        results.push({ source: source.relativePath, target: targetRelPath, locale: targetLocale, status: "skipped" });
        continue;
      }

      // Check by permalink
      const alternates = source.frontmatter.alternates as Record<string, string> | undefined;
      if (alternates?.[targetLocale] && !alternates[targetLocale].startsWith("http")) {
        const existing = await findFileByPermalink(
          join(config.root, config.contentDir),
          targetLocale,
          alternates[targetLocale],
          config
        );
        if (existing && !options.force) {
          results.push({ source: source.relativePath, target: targetRelPath, locale: targetLocale, status: "skipped" });
          continue;
        }
      }

      if (options.dryRun) {
        results.push({ source: source.relativePath, target: targetRelPath, locale: targetLocale, status: "created" });
        continue;
      }

      translations.push({ source, targetLocale, targetRelPath, targetPath });
    }
  }

  // Process translations with progress
  const total = translations.length;
  let current = 0;

  for (const { source, targetLocale, targetRelPath, targetPath } of translations) {
    current++;
    const alternates = source.frontmatter.alternates as Record<string, string> | undefined;

    // Report progress: starting
    options.onProgress?.({
      current,
      total,
      currentFile: source.relativePath,
      targetLocale,
      phase: "translating",
    });

    try {
      const translated = await translateContent(source, targetLocale, config, openai!);

        // Build output frontmatter
        const outputFrontmatter: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(source.frontmatter)) {
          if (key.startsWith("_")) continue;
          if (key === "title" || key === "description") continue;
          // Skip alternates - we'll rebuild it
          if (key === "alternates") continue;
          outputFrontmatter[key] = value;
        }

        // Get permalink for translated file
        const sourcePermalink = getPermalink(source);
        let targetPermalink = sourcePermalink;
        
        // Use alternate permalink if specified in source
        if (alternates?.[targetLocale] && !alternates[targetLocale].startsWith("http")) {
          targetPermalink = alternates[targetLocale];
        }
        outputFrontmatter.permalink = targetPermalink;

        // Build alternates for translated file
        if (config.updateAlternates) {
          const newAlternates: Record<string, string> = {};
          
          // Copy existing alternates from source (except external URLs)
          if (alternates) {
            for (const [loc, link] of Object.entries(alternates)) {
              if (!link.startsWith("http")) {
                newAlternates[loc] = link;
              }
            }
          }
          
          // Add source locale if not present
          if (!newAlternates[source.locale]) {
            newAlternates[source.locale] = sourcePermalink;
          }
          
          // Add target locale
          newAlternates[targetLocale] = targetPermalink;
          
          outputFrontmatter.alternates = newAlternates;
        }

        // Add translated fields
        for (const [key, value] of Object.entries(translated.frontmatter)) {
          if (value) outputFrontmatter[key] = value;
        }

        // Fallback
        if (!outputFrontmatter.title && source.frontmatter.title) {
          outputFrontmatter.title = source.frontmatter.title;
        }

        // Add AI metadata
        outputFrontmatter._ai = {
          source: source.relativePath,
          hash: source.hash,
          model: config.model,
          date: new Date().toISOString().split("T")[0],
        };

        const output = matter.stringify(translated.content, outputFrontmatter);

        // Report progress: writing
        options.onProgress?.({
          current,
          total,
          currentFile: source.relativePath,
          targetLocale,
          phase: "writing",
        });

        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, output);

        // Update alternates in source file
        const alternatesUpdated: string[] = [];
        if (config.updateAlternates) {
          const sourceUpdated = updateFileAlternates(source.path, targetLocale, targetPermalink);
          if (sourceUpdated) {
            alternatesUpdated.push(source.relativePath);
          }
        }

        results.push({ 
          source: source.relativePath, 
          target: targetRelPath, 
          locale: targetLocale, 
          status: "created",
          alternatesUpdated: alternatesUpdated.length > 0 ? alternatesUpdated : undefined,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ source: source.relativePath, target: targetRelPath, locale: targetLocale, status: "error", error: message });
      }
    }

  // Report progress: done
  if (total > 0) {
    options.onProgress?.({
      current: total,
      total,
      currentFile: "",
      targetLocale: "",
      phase: "done",
    });
  }

  return results;
}

/**
 * Show translation status.
 */
export async function status(config: ResolvedConfig): Promise<void> {
  const sources = await scanContent(config);

  console.log(`\nLocales: ${config.locales.join(", ")}`);
  console.log(`Default: ${config.defaultLocale}\n`);

  // Only show files with explicit _translateTo
  const filesToTranslate = sources.filter(
    (s) => s.translateTo !== false && Array.isArray(s.translateTo) && s.translateTo.length > 0
  );

  if (filesToTranslate.length === 0) {
    console.log("No files marked for translation.");
    console.log("\nTo translate a file, add _translateTo to its frontmatter:");
    console.log("  _translateTo: [ja, de]");
    return;
  }

  for (const source of filesToTranslate) {
    const targets = source.translateTo as string[];
    const statuses: string[] = [];

    for (const locale of targets) {
      const targetPath = getTargetPath(source, locale, config);
      const fullPath = join(config.root, config.contentDir, targetPath);

      // Also check by permalink from alternates
      const alternates = source.frontmatter.alternates as Record<string, string> | undefined;
      let found = false;
      let isAi = false;

      if (existsSync(fullPath)) {
        found = true;
        const raw = readFileSync(fullPath, "utf-8");
        const { data } = matter(raw);
        isAi = !!data._ai;
      } else if (alternates?.[locale] && !alternates[locale].startsWith("http")) {
        // Check if translation exists with different filename (via permalink)
        const existing = await findFileByPermalink(
          join(config.root, config.contentDir),
          locale,
          alternates[locale],
          config
        );
        if (existing) {
          found = true;
          const raw = readFileSync(join(config.root, config.contentDir, existing), "utf-8");
          const { data } = matter(raw);
          isAi = !!data._ai;
        }
      }

      if (found) {
        statuses.push(`${locale}:${isAi ? "ai" : "exists"}`);
      } else {
        statuses.push(`${locale}:pending`);
      }
    }

    console.log(`${source.relativePath} → ${statuses.join(", ")}`);
  }
}

/**
 * Get the permalink for a file (from frontmatter or filename).
 */
function getPermalink(source: SourceFile): string {
  if (typeof source.frontmatter.permalink === "string") {
    return source.frontmatter.permalink;
  }
  // Use filename without extension, but index files get empty permalink (homepage)
  const filename = basename(source.path).replace(/\.(mdx?|md)$/, "");
  return filename === "index" ? "" : filename;
}

/**
 * Update alternates in a file's frontmatter.
 * Returns true if file was modified.
 */
function updateFileAlternates(
  filePath: string,
  locale: string,
  permalink: string
): boolean {
  if (!existsSync(filePath)) return false;

  const raw = readFileSync(filePath, "utf-8");
  const { data: frontmatter, content } = matter(raw);

  // Get or create alternates object
  const alternates = (frontmatter.alternates || {}) as Record<string, string>;

  // Check if already has this locale
  if (alternates[locale] === permalink) {
    return false;
  }

  // Add the new alternate
  alternates[locale] = permalink;
  frontmatter.alternates = alternates;

  // Write back
  const output = matter.stringify(content, frontmatter);
  writeFileSync(filePath, output);

  return true;
}

async function findFileByPermalink(
  contentDir: string,
  locale: string,
  permalink: string,
  config: ResolvedConfig
): Promise<string | null> {
  const localeDir = locale === config.defaultLocale ? contentDir : join(contentDir, locale);
  if (!existsSync(localeDir)) return null;

  const pattern = join(localeDir, "**/*.{md,mdx}");
  const files = await glob(pattern, { nodir: true });

  for (const filePath of files) {
    const raw = readFileSync(filePath, "utf-8");
    const { data } = matter(raw);

    if (data.permalink === permalink) return relative(contentDir, filePath);

    const fileName = basename(filePath).replace(/\.(mdx?|md)$/, "");
    if (fileName === permalink) return relative(contentDir, filePath);
  }

  return null;
}
