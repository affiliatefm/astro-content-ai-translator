#!/usr/bin/env node
/**
 * AI Translate CLI
 * =================
 * CLI for astro-content-astro-ai-translator integration.
 *
 * Usage:
 *   npx astro-ai-translator [file] [options]
 *   npx astro-ai-translator init
 *
 * Reads configuration from astro.config.mjs integration settings.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { translate, status, estimate } from "./core.js";
import type { ResolvedConfig } from "./integration.js";
import type { TranslationEstimate, TranslationProgress } from "./core.js";

// Load .env file
const projectRoot = process.cwd();
const envPath = join(projectRoot, ".env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
}

const args = process.argv.slice(2);

const showHelp = args.includes("--help") || args.includes("-h");
const showStatus = args.includes("--status") || args.includes("-s");
const showInit = args.includes("init");
const dryRun = args.includes("--dry-run") || args.includes("-n");
const force = args.includes("--force") || args.includes("-f");
const file = args.find((a) => !a.startsWith("-") && a !== "init");

// =============================================================================
// INTERACTIVE HELPERS
// =============================================================================

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await ask(`${question} ${suffix} `);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

// =============================================================================
// ESTIMATE DISPLAY
// =============================================================================

function formatNumber(num: number): string {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1) + "K";
  return num.toString();
}

function formatCost(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  if (usd < 1) return "$" + usd.toFixed(2);
  return "$" + usd.toFixed(2);
}

function displayEstimate(est: TranslationEstimate): void {
  const toTranslate = est.files.filter((f) => !f.skipped);
  const skipped = est.files.filter((f) => f.skipped);

  console.log("\n┌─────────────────────────────────────────────────────────────┐");
  console.log("│                   📊 TRANSLATION ESTIMATE                   │");
  console.log("└─────────────────────────────────────────────────────────────┘\n");

  if (toTranslate.length === 0) {
    console.log("  ✅ Nothing to translate! All files are up to date.\n");
    return;
  }

  // Files to translate
  console.log("  📁 Files to translate:");
  for (const file of toTranslate) {
    const tokens = formatNumber(file.inputTokens + file.outputTokens);
    console.log(`     • ${file.source} → ${file.targetLocale} (~${tokens} tokens)`);
  }

  if (skipped.length > 0) {
    console.log(`\n  ⏭️  Skipped: ${skipped.length} file(s) (already exist)`);
  }

  // Summary
  console.log("\n  ─────────────────────────────────────────────────────────────");
  console.log(`  📈 Model:          ${est.model}`);
  console.log(`  📝 Translations:   ${toTranslate.length}`);
  console.log(`  🔤 Input tokens:   ~${formatNumber(est.totalInputTokens)}`);
  console.log(`  📤 Output tokens:  ~${formatNumber(est.totalOutputTokens)}`);
  console.log(`  📦 Total tokens:   ~${formatNumber(est.totalTokens)}`);
  console.log("  ─────────────────────────────────────────────────────────────");
  console.log(`  💰 Estimated cost: ${formatCost(est.estimatedCostUSD)}`);
  console.log("  ─────────────────────────────────────────────────────────────\n");

  if (est.estimatedCostUSD > 1) {
    console.log("  ⚠️  Note: Cost estimates are approximate. Actual costs may vary.\n");
  }
}

// =============================================================================
// PROGRESS BAR
// =============================================================================

const PROGRESS_WIDTH = 30;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

class ProgressBar {
  private spinnerIdx = 0;
  private interval: NodeJS.Timeout | null = null;
  private lastLine = "";
  private startTime = Date.now();

  start(): void {
    this.startTime = Date.now();
    // Animate spinner
    this.interval = setInterval(() => {
      this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER_FRAMES.length;
      if (this.lastLine) {
        this.render(this.lastLine);
      }
    }, 80);
  }

  update(progress: TranslationProgress): void {
    const { current, total, currentFile, targetLocale, phase } = progress;
    const percent = Math.round((current / total) * 100);
    const filled = Math.round((current / total) * PROGRESS_WIDTH);
    const empty = PROGRESS_WIDTH - filled;

    const bar = "█".repeat(filled) + "░".repeat(empty);
    const spinner = SPINNER_FRAMES[this.spinnerIdx];

    let statusText = "";
    switch (phase) {
      case "translating":
        statusText = `${currentFile} → ${targetLocale}`;
        break;
      case "writing":
        statusText = `Writing ${currentFile}`;
        break;
      case "done":
        statusText = "Complete!";
        break;
      default:
        statusText = "Starting...";
    }

    // Truncate status if too long
    const maxStatusLen = 40;
    if (statusText.length > maxStatusLen) {
      statusText = "..." + statusText.slice(-(maxStatusLen - 3));
    }

    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    this.lastLine = `  ${spinner} [${bar}] ${percent}% (${current}/${total}) ${statusText} [${elapsed}s]`;
    this.render(this.lastLine);
  }

  private render(line: string): void {
    process.stdout.write(`\r${line}${" ".repeat(10)}`);
  }

  stop(success = true): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const icon = success ? "✅" : "❌";
    console.log(`\r  ${icon} Translation complete in ${elapsed}s${" ".repeat(40)}`);
  }
}

async function loadConfig(): Promise<ResolvedConfig> {
  // Try to load astro.config to get integration options
  const configPaths = ["astro.config.mjs", "astro.config.js", "astro.config.ts"];
  
  let astroConfig: any = null;
  
  for (const configFile of configPaths) {
    const configPath = join(projectRoot, configFile);
    if (existsSync(configPath)) {
      try {
        // Dynamic import of astro config
        const configUrl = pathToFileURL(configPath).href;
        const module = await import(configUrl);
        astroConfig = module.default;
        break;
      } catch (e) {
        // Config may have imports that don't resolve, try parsing manually
      }
    }
  }

  // Extract i18n from astro config
  let locales: string[] = [];
  let defaultLocale = "en";
  
  if (astroConfig?.i18n) {
    locales = astroConfig.i18n.locales?.map((l: string | { path: string }) =>
      typeof l === "string" ? l : l.path
    ) || [];
    defaultLocale = astroConfig.i18n.defaultLocale || locales[0] || "en";
  }

  // Try to read from site.ts if no astro i18n config
  if (locales.length === 0) {
    const siteConfigPaths = ["src/config/site.ts", "src/config/site.js"];
    
    for (const configFile of siteConfigPaths) {
      const configPath = join(projectRoot, configFile);
      if (existsSync(configPath)) {
        const content = readFileSync(configPath, "utf-8");
        
        const localesMatch = content.match(/export\s+const\s+locales\s*=\s*\[([^\]]+)\]/);
        const defaultMatch = content.match(/export\s+const\s+defaultLocale\s*=\s*["']([^"']+)["']/);
        
        if (localesMatch) {
          locales = localesMatch[1]
            .match(/["']([^"']+)["']/g)
            ?.map((s) => s.replace(/["']/g, "")) || [];
          defaultLocale = defaultMatch?.[1] || locales[0] || "en";
          break;
        }
      }
    }
  }

  if (locales.length === 0) {
    throw new Error(
      "No locales found.\n\n" +
      "Configure i18n in astro.config.mjs:\n" +
      "  i18n: {\n" +
      "    locales: ['en', 'ru', 'de'],\n" +
      "    defaultLocale: 'en',\n" +
      "  }\n"
    );
  }

  // Find integration options from astro config
  let integrationOptions: any = {};
  
  if (astroConfig?.integrations) {
    for (const integration of astroConfig.integrations) {
      if (integration?.name === "astro-content-astro-ai-translator") {
        // Integration was called, options are in closure - can't access directly
        // User should set options via environment or config file
        break;
      }
    }
  }

  // Check for options in environment or simple config
  const model = process.env.AI_TRANSLATE_MODEL || "gpt-4.1";
  const contentDir = process.env.AI_TRANSLATE_CONTENT_DIR || "src/content/pages";

  return {
    model,
    contentDir,
    prompt: undefined,
    locales,
    defaultLocale,
    root: projectRoot,
  };
}

// =============================================================================
// INIT COMMAND
// =============================================================================

async function init() {
  console.log("🚀 Astro AI Translate Setup\n");

  // Check for astro.config
  const configFiles = ["astro.config.mjs", "astro.config.js", "astro.config.ts"];
  let configFile = configFiles.find((f) => existsSync(join(projectRoot, f)));

  if (!configFile) {
    console.log("❌ No astro.config found. Run this in an Astro project.\n");
    process.exit(1);
  }

  console.log(`Found: ${configFile}\n`);

  // Check if integration already added
  const configContent = readFileSync(join(projectRoot, configFile), "utf-8");
  const hasIntegration = configContent.includes("astro-content-astro-ai-translator");

  if (hasIntegration) {
    console.log("✅ Integration already configured in astro.config\n");
  } else {
    const addIntegration = await confirm("Add integration to astro.config?");
    
    if (addIntegration) {
      // Add import
      let newContent = configContent;
      
      if (!newContent.includes('import aiTranslator')) {
        const importLine = 'import aiTranslator from "@affiliate.fm/astro-content-astro-ai-translator";';
        // Find last top-level import (starts at beginning of line)
        const lines = newContent.split("\n");
        let lastImportLine = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith("import ")) {
            lastImportLine = i;
          }
        }
        if (lastImportLine >= 0) {
          lines.splice(lastImportLine + 1, 0, importLine);
          newContent = lines.join("\n");
        }
      }

      // Add to integrations array
      const integrationsMatch = newContent.match(/integrations:\s*\[([^\]]*)\]/);
      if (integrationsMatch) {
        const existing = integrationsMatch[1].trim();
        const newIntegrations = existing
          ? `${existing}, aiTranslator()`
          : "aiTranslator()";
        newContent = newContent.replace(
          /integrations:\s*\[([^\]]*)\]/,
          `integrations: [${newIntegrations}]`
        );
      }

      writeFileSync(join(projectRoot, configFile), newContent);
      console.log("✅ Added integration to astro.config\n");
    }
  }

  // Check .env
  const envPath = join(projectRoot, ".env");
  const hasEnv = existsSync(envPath);
  const envContent = hasEnv ? readFileSync(envPath, "utf-8") : "";
  const hasApiKey = envContent.includes("OPENAI_API_KEY");

  if (hasApiKey) {
    console.log("✅ OPENAI_API_KEY found in .env\n");
  } else {
    const addKey = await confirm("Add OPENAI_API_KEY to .env?");
    
    if (addKey) {
      const apiKey = await ask("Enter your OpenAI API key: ");
      
      if (apiKey) {
        const envLine = `OPENAI_API_KEY=${apiKey}\n`;
        
        if (hasEnv) {
          appendFileSync(envPath, envLine);
        } else {
          writeFileSync(envPath, envLine);
        }
        
        // Add to .gitignore if not there
        const gitignorePath = join(projectRoot, ".gitignore");
        if (existsSync(gitignorePath)) {
          const gitignore = readFileSync(gitignorePath, "utf-8");
          if (!gitignore.includes(".env")) {
            appendFileSync(gitignorePath, "\n.env\n");
            console.log("✅ Added .env to .gitignore");
          }
        }
        
        console.log("✅ API key saved to .env\n");
      }
    }
  }

  // Done
  console.log(`
Setup complete! Next steps:

1. Add _translateTo to your content files:

   _translateTo: [ja, de]   # translate to specific locales
   _translateTo: all        # translate to all locales
   _translateTo: false      # don't translate

   Example:
   ---
   title: My Page
   _translateTo: [ja, de]
   ---

2. Check status:
   npx astro-ai-translator --status

3. Run translation:
   npx astro-ai-translator

4. Preview without translating:
   npx astro-ai-translator --dry-run
`);
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  if (showHelp) {
    console.log(`
Astro AI Translate - AI translation for content collections

Usage:
  npx astro-ai-translator [file] [options]
  npx astro-ai-translator init

Commands:
  init            Interactive setup wizard

Options:
  --status, -s    Show translation status
  --dry-run, -n   Preview what would be translated
  --force, -f     Overwrite existing translations
  --help, -h      Show this help

Environment:
  OPENAI_API_KEY           Required for translation
  AI_TRANSLATE_MODEL       Model to use (default: gpt-4.1)

In source files, add:
  _translateTo: [ru, de]   # Translate to these locales
  _translateTo: false      # Don't translate

Examples:
  npx astro-ai-translator init              # Setup wizard
  npx astro-ai-translator                   # Translate all missing
  npx astro-ai-translator about.mdx         # Translate specific file
  npx astro-ai-translator --status          # Show what's translated
`);
    return;
  }

  if (showInit) {
    await init();
    return;
  }

  console.log("Astro AI Translate\n");

  const config = await loadConfig();

  console.log(`Locales: ${config.locales.join(", ")}`);
  console.log(`Model: ${config.model}\n`);

  if (showStatus) {
    await status(config);
    return;
  }

  // Calculate estimate first
  console.log("Calculating translation estimate...\n");
  const est = await estimate(config, { file, force });
  displayEstimate(est);

  const toTranslate = est.files.filter((f) => !f.skipped);

  if (toTranslate.length === 0) {
    console.log("Nothing to do. Use --force to re-translate existing files.\n");
    return;
  }

  // Dry run - just show what would happen
  if (dryRun) {
    console.log("  🔍 Dry run mode - no files will be created.\n");
    console.log("  Files that would be created:");
    for (const file of toTranslate) {
      console.log(`     • ${file.source} → ${file.targetLocale}`);
    }
    console.log("\n  Run without --dry-run to proceed with translation.\n");
    return;
  }

  // Ask for confirmation
  const proceed = await confirm(
    `\n  Proceed with translation? (${toTranslate.length} file(s), ~${formatCost(est.estimatedCostUSD)})`,
    true
  );

  if (!proceed) {
    console.log("\n  ❌ Translation cancelled.\n");
    return;
  }

  // Run translation with progress
  console.log("\n  🚀 Starting translation...\n");

  const progressBar = new ProgressBar();
  progressBar.start();

  const results = await translate(config, { 
    file, 
    dryRun, 
    force,
    onProgress: (progress) => progressBar.update(progress),
  });

  progressBar.stop(results.every((r) => r.status !== "error"));

  // Summary
  const created = results.filter((r) => r.status === "created").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const errors = results.filter((r) => r.status === "error").length;

  console.log("\n  ─────────────────────────────────────────────────────────────");
  console.log("  📊 RESULTS");
  console.log("  ─────────────────────────────────────────────────────────────");
  console.log(`  ✅ Created:  ${created}`);
  console.log(`  ⏭️  Skipped:  ${skipped}`);
  if (errors > 0) {
    console.log(`  ❌ Errors:   ${errors}`);
    console.log("\n  Failed translations:");
    for (const r of results.filter((r) => r.status === "error")) {
      console.log(`     • ${r.source} → ${r.locale}: ${r.error}`);
    }
  }
  console.log("  ─────────────────────────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
