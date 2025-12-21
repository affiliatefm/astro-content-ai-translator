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
  /** Raw frontmatter string (including --- delimiters) for structure preservation */
  rawFrontmatter: string;
  content: string;
  raw: string;
  hash: string;
  translateTo: string[] | false;
}

// =============================================================================
// FRONTMATTER STRUCTURE PRESERVATION
// =============================================================================

interface FrontmatterLine {
  type: "comment" | "field" | "empty" | "continuation";
  raw: string;
  key?: string;
  value?: string;
  indent?: number;
}

/**
 * Parse frontmatter preserving structure (comments, order, formatting).
 * Only top-level (non-indented) key: value pairs are recognized as fields.
 * Indented lines are continuations (nested objects, arrays, multiline values).
 */
function parseFrontmatterStructure(raw: string): FrontmatterLine[] {
  const lines: FrontmatterLine[] = [];
  const rawLines = raw.split("\n");
  
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const trimmed = line.trim();
    
    if (trimmed === "") {
      lines.push({ type: "empty", raw: line });
    } else if (trimmed.startsWith("#")) {
      lines.push({ type: "comment", raw: line });
    } else {
      // Check if it's a TOP-LEVEL key: value (no leading whitespace)
      const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)/);
      if (match) {
        const [, key, value] = match;
        lines.push({
          type: "field",
          raw: line,
          key,
          value: value.trim(),
          indent: 0,
        });
      } else {
        // Continuation line (indented content: nested objects, arrays, multiline values)
        lines.push({
          type: "continuation",
          raw: line,
          indent: line.length - line.trimStart().length,
        });
      }
    }
  }
  
  return lines;
}

/**
 * Extract raw frontmatter string from file (including --- delimiters).
 */
function extractRawFrontmatter(raw: string): string {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : "";
}

/**
 * Build translated frontmatter preserving source structure.
 * 
 * - Keeps all comments and field order from source
 * - Replaces translatable fields (title, description) with translations
 * - Removes private fields (starting with _)
 * - Adds _ai-translator metadata where _translateTo was (same position)
 * 
 * @param sourceRawFm - Raw frontmatter from source file
 * @param sourceFm - Parsed frontmatter object from source
 * @param translatedFields - Translated field values (title, description)
 * @param aiMetadata - AI metadata to add
 */
function buildTranslatedFrontmatter(
  sourceRawFm: string,
  sourceFm: Record<string, unknown>,
  translatedFields: Record<string, string>,
  aiMetadata: Record<string, unknown>,
): string {
  const lines = parseFrontmatterStructure(sourceRawFm);
  const result: string[] = [];
  
  let aiMetadataAdded = false;
  let i = 0;
  
  while (i < lines.length) {
    const line = lines[i];
    
    if (line.type === "comment") {
      result.push(line.raw);
      i++;
      continue;
    }
    
    if (line.type === "empty") {
      result.push(line.raw);
      i++;
      continue;
    }
    
    if (line.type === "field" && line.key) {
      const key = line.key;
      
      // Private fields (starting with _) - skip but add _ai-translator in place of _translateTo
      if (key.startsWith("_")) {
        // If this is _translateTo, add _ai-translator in its place
        if (key === "_translateTo" && !aiMetadataAdded) {
          aiMetadataAdded = true;
          result.push(`_ai-translator:`);
          for (const [k, v] of Object.entries(aiMetadata)) {
            result.push(`  ${k}: ${v}`);
          }
        }
        // Skip this field and its continuations
        i++;
        while (i < lines.length && lines[i].type === "continuation") {
          i++;
        }
        continue;
      }
      
      // Check if this field should be replaced with translation
      if (key in translatedFields && translatedFields[key]) {
        // Output translated value
        const translatedValue = translatedFields[key];
        // Simple single-line values
        if (!translatedValue.includes("\n")) {
          result.push(`${key}: ${translatedValue}`);
        } else {
          // Multiline value - use >-
          result.push(`${key}: >-`);
          for (const valueLine of translatedValue.split("\n")) {
            result.push(`  ${valueLine}`);
          }
        }
        // Skip original continuations
        i++;
        while (i < lines.length && lines[i].type === "continuation") {
          i++;
        }
      } else {
        // Keep original field as-is
        result.push(line.raw);
        i++;
        // Include continuation lines
        while (i < lines.length && lines[i].type === "continuation") {
          result.push(lines[i].raw);
          i++;
        }
      }
    } else if (line.type === "continuation") {
      // Orphan continuation (shouldn't happen normally)
      result.push(line.raw);
      i++;
    } else {
      i++;
    }
  }
  
  // If _translateTo wasn't found, add _ai-translator at the end
  if (!aiMetadataAdded) {
    result.push(`_ai-translator:`);
    for (const [k, v] of Object.entries(aiMetadata)) {
      result.push(`  ${k}: ${v}`);
    }
  }
  
  return result.join("\n");
}

/**
 * Update a specific field in frontmatter while preserving structure.
 * - If field exists, updates it in place
 * - If field doesn't exist, adds it at the end
 * Returns the new file content or null if no change needed.
 */
function updateFrontmatterField(
  raw: string,
  fieldName: string,
  newValue: unknown,
): string | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  
  const rawFm = fmMatch[1];
  const content = raw.slice(fmMatch[0].length);
  const lines = parseFrontmatterStructure(rawFm);
  const result: string[] = [];
  
  let fieldUpdated = false;
  
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    
    if (line.type === "field" && line.key === fieldName) {
      // Replace this field in place
      fieldUpdated = true;
      if (typeof newValue === "object" && newValue !== null) {
        result.push(`${fieldName}:`);
        for (const [k, v] of Object.entries(newValue)) {
          if (typeof v === "string") {
            result.push(`  ${k}: ${v.startsWith("http") ? `'${v}'` : v}`);
          } else {
            result.push(`  ${k}: ${JSON.stringify(v)}`);
          }
        }
      } else {
        result.push(`${fieldName}: ${newValue}`);
      }
      // Skip original continuations
      i++;
      while (i < lines.length && lines[i].type === "continuation") {
        i++;
      }
    } else {
      result.push(line.raw);
      i++;
    }
  }
  
  // If field wasn't found, add it at the end
  if (!fieldUpdated) {
    if (typeof newValue === "object" && newValue !== null) {
      result.push(`${fieldName}:`);
      for (const [k, v] of Object.entries(newValue)) {
        if (typeof v === "string") {
          result.push(`  ${k}: ${v.startsWith("http") ? `'${v}'` : v}`);
        } else {
          result.push(`  ${k}: ${JSON.stringify(v)}`);
        }
      }
    } else {
      result.push(`${fieldName}: ${newValue}`);
    }
  }
  
  return `---\n${result.join("\n")}\n---${content}`;
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

    // Extract raw frontmatter for structure preservation
    const rawFrontmatter = extractRawFrontmatter(raw);

    sources.push({
      path: filePath,
      relativePath,
      locale,
      frontmatter,
      rawFrontmatter,
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

        // Build AI metadata
        const aiMetadata = {
          source: source.relativePath,
          hash: source.hash,
          model: config.model,
          date: new Date().toISOString().split("T")[0],
        };

        // Build translated frontmatter preserving source structure
        const translatedFm = buildTranslatedFrontmatter(
          source.rawFrontmatter,
          source.frontmatter,
          {
            ...translated.frontmatter,
            // Fallback to source title if not translated
            title: translated.frontmatter.title || (source.frontmatter.title as string) || "",
          },
          aiMetadata,
        );

        const output = `---\n${translatedFm}\n---\n\n${translated.content}`;

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
          // Calculate target permalink for alternates update
          const sourcePermalink = getPermalink(source);
          let targetPermalink = sourcePermalink;
          if (alternates?.[targetLocale] && !alternates[targetLocale].startsWith("http")) {
            targetPermalink = alternates[targetLocale];
          }
          
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

  // Sync alternates across all locale versions
  if (config.updateAlternates && results.some(r => r.status === "created")) {
    const syncedFiles = await syncAlternatesAcrossLocales(config, results);
    
    // Add synced files to the last result's alternatesUpdated
    if (syncedFiles.length > 0 && results.length > 0) {
      const lastCreated = results.filter(r => r.status === "created").pop();
      if (lastCreated) {
        lastCreated.alternatesUpdated = [
          ...(lastCreated.alternatesUpdated || []),
          ...syncedFiles.filter(f => !lastCreated.alternatesUpdated?.includes(f))
        ];
      }
    }
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
        isAi = !!data["_ai-translator"];
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
          isAi = !!data["_ai-translator"];
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
 * Only updates if the file ALREADY HAS alternates field.
 * Returns true if file was modified.
 */
function updateFileAlternates(
  filePath: string,
  locale: string,
  permalink: string
): boolean {
  if (!existsSync(filePath)) return false;

  const raw = readFileSync(filePath, "utf-8");
  const { data: frontmatter } = matter(raw);

  // Only update if alternates already exist - don't create new ones
  if (!frontmatter.alternates) {
    return false;
  }

  const alternates = frontmatter.alternates as Record<string, string>;

  // Check if already has this locale
  if (alternates[locale] === permalink) {
    return false;
  }

  // Add the new alternate
  const newAlternates = { ...alternates, [locale]: permalink };

  // Use structure-preserving update
  const updated = updateFrontmatterField(raw, "alternates", newAlternates);
  
  if (updated) {
    writeFileSync(filePath, updated);
    return true;
  }

  return false;
}

/**
 * Sync alternates across all locale versions of a page.
 * Only syncs files that ALREADY HAVE alternates in their frontmatter.
 * After translations, each locale version should know about all others.
 */
async function syncAlternatesAcrossLocales(
  config: ResolvedConfig,
  results: TranslationResult[]
): Promise<string[]> {
  const updatedFiles: string[] = [];
  const contentDir = join(config.root, config.contentDir);
  
  // Group results by source file (base path)
  const sourceGroups = new Map<string, Set<string>>();
  
  for (const result of results) {
    if (result.status !== "created") continue;
    
    // Get the base source path (without locale prefix)
    const sourcePath = result.source;
    if (!sourceGroups.has(sourcePath)) {
      sourceGroups.set(sourcePath, new Set());
    }
    sourceGroups.get(sourcePath)!.add(result.locale);
  }
  
  // For each source that had translations created
  for (const [sourcePath, newLocales] of sourceGroups) {
    // Read source file to get its alternates
    const sourceFullPath = join(contentDir, sourcePath);
    if (!existsSync(sourceFullPath)) continue;
    
    const sourceRaw = readFileSync(sourceFullPath, "utf-8");
    const { data: sourceFm } = matter(sourceRaw);
    
    // Only sync if source file HAS alternates - don't create new ones
    if (!sourceFm.alternates) continue;
    
    const sourceAlternates = sourceFm.alternates as Record<string, string>;
    
    // Collect all known alternates (from source)
    const allAlternates: Record<string, string> = { ...sourceAlternates };
    
    // Find all locale versions of this page and collect their alternates
    const sourceLocale = getLocaleFromPath(sourcePath, config);
    const baseFileName = sourcePath.replace(new RegExp(`^${sourceLocale}/`), "");
    
    for (const locale of config.locales) {
      const localePath = locale === config.defaultLocale 
        ? baseFileName 
        : `${locale}/${baseFileName}`;
      const fullPath = join(contentDir, localePath);
      
      if (existsSync(fullPath)) {
        const raw = readFileSync(fullPath, "utf-8");
        const { data: fm } = matter(raw);
        
        // Only collect from files that have alternates
        if (fm.alternates) {
          const alts = fm.alternates as Record<string, string>;
          // Merge alternates
          for (const [loc, link] of Object.entries(alts)) {
            if (!allAlternates[loc] && !link.startsWith("http")) {
              allAlternates[loc] = link;
            }
          }
        }
      }
    }
    
    // Now update locale versions that ALREADY HAVE alternates
    for (const locale of config.locales) {
      const localePath = locale === config.defaultLocale 
        ? baseFileName 
        : `${locale}/${baseFileName}`;
      const fullPath = join(contentDir, localePath);
      
      if (!existsSync(fullPath)) continue;
      
      const raw = readFileSync(fullPath, "utf-8");
      const { data: fm } = matter(raw);
      
      // Only update files that already have alternates
      if (!fm.alternates) continue;
      
      const currentAlts = fm.alternates as Record<string, string>;
      
      // Check if we need to update
      let needsUpdate = false;
      for (const [loc, link] of Object.entries(allAlternates)) {
        if (currentAlts[loc] !== link) {
          needsUpdate = true;
          break;
        }
      }
      
      if (needsUpdate) {
        const newAlternates = { ...currentAlts, ...allAlternates };
        const updated = updateFrontmatterField(raw, "alternates", newAlternates);
        if (updated) {
          writeFileSync(fullPath, updated);
          updatedFiles.push(localePath);
        }
      }
    }
  }
  
  return updatedFiles;
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
