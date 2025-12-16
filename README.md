# astro-content-ai-translator

Astro integration for AI-powered content translation using OpenAI.

## Installation

```bash
npm install @affiliate.fm/astro-content-ai-translator
npx astro-ai-translator init
```

The setup wizard will:
- Add integration to your `astro.config.mjs`
- Set up your OpenAI API key in `.env`

Alternatively, use `npx astro add @affiliate.fm/astro-content-ai-translator`.

## Quick Start

### 1. Mark files for translation

In your content files, add `_translateTo` to frontmatter:

```yaml
---
title: About Us
description: Learn about our company
_translateTo: [ru, de]
---
```

Options:
- `_translateTo: [ru, de]` — translate to specific locales
- `_translateTo: all` — translate to all configured locales
- `_translateTo: false` — explicitly don't translate
- No field — file is not translated (must opt-in)

## Usage

### Translate missing content

```bash
npx astro-ai-translator
```

Before translation starts, you'll see:
- **Cost estimate** — approximate tokens and USD cost
- **File list** — what will be translated
- **Confirmation prompt** — approve before spending API credits

Example output:

```
┌─────────────────────────────────────────────────────────────┐
│                   📊 TRANSLATION ESTIMATE                   │
└─────────────────────────────────────────────────────────────┘

  📁 Files to translate:
     • index.mdx → ru (~807 tokens)
     • index.mdx → ja (~807 tokens)
     • about.mdx → ru (~658 tokens)

  ─────────────────────────────────────────────────────────────
  📈 Model:          gpt-4.1
  📝 Translations:   3
  🔤 Input tokens:   ~1.1K
  📤 Output tokens:  ~1.1K
  📦 Total tokens:   ~2.3K
  ─────────────────────────────────────────────────────────────
  💰 Estimated cost: $0.02
  ─────────────────────────────────────────────────────────────

  Proceed with translation? (3 file(s), ~$0.02) [Y/n]
```

During translation, a **live progress bar** shows current status.

### Translate specific file

```bash
npx astro-ai-translator about.mdx
```

### Check status

```bash
npx astro-ai-translator --status
```

### Preview (dry run)

```bash
npx astro-ai-translator --dry-run
```

Shows estimate without confirmation prompt. No API calls made.

### Force overwrite

```bash
npx astro-ai-translator --force
```

## Generated files

AI-translated files include metadata in frontmatter:

```yaml
---
title: О нас
description: Узнайте о нашей компании
_ai:
  source: about.mdx
  hash: a1b2c3d4e5f6
  model: gpt-4.1
  date: "2025-12-15"
---
```

This lets you:
- Identify AI translations vs manual
- Track source file changes
- Know which model was used

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | required | OpenAI API key |
| `AI_TRANSLATE_MODEL` | gpt-4.1 | Model override |
| `AI_TRANSLATE_CONTENT_DIR` | src/content/pages | Content directory |

## Supported models & pricing

Cost estimates use current OpenAI pricing (USD per 1M tokens):

| Model | Input | Output | Best for |
|-------|-------|--------|----------|
| `gpt-4.1` | $2.00 | $8.00 | Default, best quality |
| `gpt-4.1-mini` | $0.40 | $1.60 | Good balance |
| `gpt-4.1-nano` | $0.10 | $0.40 | Budget option |
| `gpt-4o` | $2.50 | $10.00 | High quality |
| `gpt-4o-mini` | $0.15 | $0.60 | Very cheap |
| `gpt-3.5-turbo` | $0.50 | $1.50 | Legacy, fast |

For high-volume translation, `gpt-4.1-mini` or `gpt-4o-mini` offer good quality at lower cost.

## File structure

The translator follows Astro i18n conventions:

```
src/content/pages/
├── index.mdx           # Default locale (en)
├── about.mdx           # Default locale (en)
├── ru/
│   ├── index.mdx       # Russian (ai or manual)
│   └── about.mdx       # Russian (ai or manual)
└── de/
    ├── index.mdx       # German
    └── about.mdx       # German
```

## Alternates support

If source file has `alternates`, translated files get correct `permalink`:

```yaml
# Source: about.mdx
alternates:
  ru: o-nas
  de: ueber-uns
```

Generated `ru/about.mdx` will have `permalink: o-nas`.

## Related

- [website-core-template](https://github.com/affiliatefm/website-core-template) — i18n-ready Astro starter template
- [astro-content-ai-enhancer](https://github.com/affiliatefm/astro-content-ai-enhancer) — AI assistant that enhances raw Markdown into structured, well-formatted pages

## Author

Built by [Affiliate.FM](https://affiliate.fm) — independent media and open-source tools for affiliate, performance, and digital marketing.

## License

MIT
