# astro-content-ai-translator

Astro integration for AI-powered content translation using OpenAI.

## Installation

```bash
npx astro add astro-content-ai-translator
```

Or manually:

```bash
npm install astro-content-ai-translator
npx astro-ai-translate init
```

## Quick Start

### 1. Run setup wizard

```bash
npx astro-ai-translate init
```

This will:
- Add integration to your `astro.config.mjs`
- Set up your OpenAI API key in `.env`

### 2. Mark files for translation

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
- `_translateTo: false` — don't translate this file
- Omit field — defaults to translating to all non-default locales

## Usage

### Translate missing content

```bash
npx astro-ai-translate
```

### Translate specific file

```bash
npx astro-ai-translate about.mdx
```

### Check status

```bash
npx astro-ai-translate --status
```

### Preview (dry run)

```bash
npx astro-ai-translate --dry-run
```

### Force overwrite

```bash
npx astro-ai-translate --force
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

## Author

Built by [Affiliate.FM](https://affiliate.fm) — independent media and open-source tools for affiliate, performance, and digital marketing.

## License

MIT
