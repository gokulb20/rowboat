# Crewm8 Desktop

**Open-source AI coworker that turns work into a knowledge graph and acts on it**

Forked from [Rowboat](https://github.com/rowboatlabs/rowboat).

Crewm8 connects to your email and calendar, builds a long-lived knowledge graph, and uses that context to help you get work done — privately, on your machine.

## What it does

- **Remember** important context you don't want to re-explain (people, projects, decisions, commitments)
- **Understand** what's relevant right now (before a meeting, while replying to an email, when writing a doc)
- **Help you act** by drafting, summarizing, planning, and producing real artifacts (briefs, emails, docs, PDF slides)

Under the hood, Crewm8 maintains an **Obsidian-compatible vault** of plain Markdown notes with backlinks — a transparent "working memory" you can inspect and edit.

## Getting Started

### Prerequisites

- Node.js 22+
- pnpm 9+

### Install & Run

```bash
cd apps/desktop
pnpm install
npm run deps    # Build workspace packages (shared → core → preload)
npm run dev     # Start development mode
```

### Build for Production

```bash
cd apps/desktop/apps/main
npm run package   # Create .app bundle
npm run make      # Create DMG distributable
```

## Configuration

### LLM Models

Config file: `~/.crewm8/config/models.json`

```json
{
  "provider": { "flavor": "openai", "apiKey": "sk-..." },
  "model": "gpt-4o"
}
```

Supports local models via Ollama, or any OpenAI-compatible provider.

### Integrations (via Composio)

Add a Composio API key in `~/.crewm8/config/composio.json`:

```json
{
  "apiKey": "<your-composio-key>"
}
```

This enables Gmail, Google Calendar, Slack, GitHub, and 250+ other integrations.

### Web Search (Exa)

Optional: Add an Exa API key in `~/.crewm8/config/exa-search.json`

### MCP Servers

Connect external tools and services via **Model Context Protocol (MCP)** in the app settings.

## Architecture

```
apps/desktop/
├── apps/
│   ├── main/              # Electron main process
│   ├── renderer/          # React UI (Vite)
│   └── preload/           # Electron preload scripts
└── packages/
    ├── shared/            # @crewm8/shared - Types, IPC schema, validators
    └── core/              # @crewm8/core - AI, knowledge graph, Composio
```

Build order: `shared → core → preload → renderer/main`

## Key Differences from Rowboat

- **No cloud service**: All integrations route through [Composio](https://composio.dev) — no Rowboat cloud, Stripe, Auth0, or direct Google OAuth
- **No voice mode**: Deepgram and ElevenLabs integrations removed (may return in future versions)
- **Custom protocol**: `crewm8://` instead of `rowboat://`
- **Data directory**: `~/.crewm8/` instead of `~/.rowboat/`
- **Brand**: Crewm8 (ai.crewm8.app bundle ID)

## License

MIT
