# Astro Content AI Translator

AI-powered translation tool for Astro websites with content collections. Translate your site to multiple locales while preserving structure, frontmatter, and formatting.

## Features

- **Content Collection Aware** — Works with Astro's `src/content/` directory structure
- **Batch Translation** — Translate a single page or an entire multi-page site
- **i18n Compatible** — Designed for locale-based folder organization
- **Frontmatter Preservation** — Keeps metadata intact, translates only what matters
- **Smart Caching** — Avoid re-translating unchanged content

## How It Works

The translator reads your content files, identifies translatable text (body content and specified frontmatter fields), sends them to an AI translation service, and outputs properly structured locale variants.

```
src/content/blog/
├── en/
│   └── getting-started.md    # Original
├── es/
│   └── getting-started.md    # Generated
└── de/
    └── getting-started.md    # Generated
```

## Usage

> **Note:** Implementation details are being finalized. This may ship as:
> - A standalone CLI tool
> - An npm package
> - A native Astro integration

```bash
# Example (API subject to change)
npx astro-content-ai-translator translate --source en --target es,de,fr
```

## Configuration

```ts
// translator.config.ts (proposed)
export default {
  contentDir: 'src/content',
  sourceLocale: 'en',
  targetLocales: ['es', 'de', 'fr', 'ja'],
  translateFields: ['title', 'description', 'excerpt'],
  exclude: ['drafts/**'],
}
```

## Requirements

- Astro project with content collections
- Content organized by locale folders (or adaptable structure)
- AI provider API key (OpenAI, Anthropic, etc.)

## Roadmap

- [ ] Core translation engine
- [ ] CLI interface
- [ ] Astro integration
- [ ] Multiple AI provider support
- [ ] Incremental translation (only changed files)
- [ ] Translation memory / glossary support

## Related

- [website-starter](https://github.com/affiliatefm/website-starter) — i18n-ready Astro starter template

## License

MIT


