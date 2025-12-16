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

  console.log(`\nFound ${filesToProcess.length} file(s) to process\n`);

  for (const source of filesToProcess) {
    if (!source.translateTo || source.translateTo.length === 0) continue;

    for (const targetLocale of source.translateTo) {
      const targetRelPath = getTargetPath(source, targetLocale, config);
      const targetPath = join(config.root, config.contentDir, targetRelPath);

      // Check existing
      if (existsSync(targetPath) && !options.force) {
        console.log(`  Skip: ${targetRelPath} (exists)`);
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
          console.log(`  Skip: ${targetRelPath} (${alternates[targetLocale]} exists)`);
          results.push({ source: source.relativePath, target: targetRelPath, locale: targetLocale, status: "skipped" });
          continue;
        }
      }

      if (options.dryRun) {
        console.log(`  Would create: ${targetRelPath}`);
        results.push({ source: source.relativePath, target: targetRelPath, locale: targetLocale, status: "created" });
        continue;
      }

      console.log(`  Translating: ${source.relativePath} → ${targetLocale}...`);

      try {
        const translated = await translateContent(source, targetLocale, config, openai!);

        // Build output frontmatter
        const outputFrontmatter: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(source.frontmatter)) {
          if (key.startsWith("_")) continue;
          if (key === "title" || key === "description") continue;
          outputFrontmatter[key] = value;
        }

        // Add permalink from alternates
        if (alternates?.[targetLocale] && !alternates[targetLocale].startsWith("http")) {
          outputFrontmatter.permalink = alternates[targetLocale];
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

        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, output);

        console.log(`  Created: ${targetRelPath}`);
        results.push({ source: source.relativePath, target: targetRelPath, locale: targetLocale, status: "created" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  Error: ${message}`);
        results.push({ source: source.relativePath, target: targetRelPath, locale: targetLocale, status: "error", error: message });
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
