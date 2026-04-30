# CLAUDE.md - AI Coding Agent Context

This file provides context for AI coding agents working on the Crewm8 desktop app (forked from Rowboat).

## Quick Reference Commands

```bash
# Electron App (apps/desktop)
cd apps/desktop && pnpm install          # Install dependencies
cd apps/desktop && npm run deps          # Build workspace packages (shared → core → preload)
cd apps/desktop && npm run dev           # Development mode (builds deps, runs app)
cd apps/desktop && npm run lint          # Lint check
cd apps/desktop/apps/main && npm run package   # Production build (.app)
cd apps/desktop/apps/main && npm run make      # Create DMG distributable
```

## Monorepo Structure

```
crewm8-desktop/
├── apps/desktop/          # Electron desktop app (the only app)
├── CLAUDE.md              # This file
└── README.md              # User-facing readme
```

The other Rowboat apps (dashboard, frontend, CLI, python-sdk, docs) have been removed. This repo is now solely the Crewm8 desktop app.

## Electron App Architecture (`apps/desktop`)

The Electron app is a **nested pnpm workspace** with its own package management.

```
apps/desktop/
├── package.json           # Workspace root, dev scripts
├── pnpm-workspace.yaml    # Defines workspace packages
├── pnpm-lock.yaml         # Lockfile
├── apps/
│   ├── main/              # Electron main process
│   │   ├── src/           # Main process source
│   │   ├── forge.config.cjs   # Electron Forge config
│   │   └── bundle.mjs     # esbuild bundler
│   ├── renderer/          # React UI (Vite)
│   │   ├── src/           # React components
│   │   └── vite.config.ts
│   └── preload/           # Electron preload scripts
│       └── src/
└── packages/
    ├── shared/            # @crewm8/shared - Types, utilities, validators
    └── core/              # @crewm8/core - Business logic, AI, MCP, Composio
```

### Build Order (Dependencies)

```
shared (no deps)
   ↓
core (depends on shared)
   ↓
preload (depends on shared)
   ↓
renderer (depends on shared)
main (depends on shared, core)
```

**The `npm run deps` command builds:** shared → core → preload

### Key Entry Points

| Component | Entry | Output |
|-----------|-------|--------|
| main | `apps/main/src/main.ts` | `.package/dist/main.cjs` |
| renderer | `apps/renderer/src/main.tsx` | `apps/renderer/dist/` |
| preload | `apps/preload/src/preload.ts` | `apps/preload/dist/preload.js` |

## Build System

- **Package manager:** pnpm (required for `workspace:*` protocol)
- **Main bundler:** esbuild (bundles to single CommonJS file)
- **Renderer bundler:** Vite
- **Packaging:** Electron Forge
- **TypeScript:** ES2022 target

### Why esbuild bundling?

pnpm uses symlinks for workspace packages. Electron Forge's dependency walker can't follow these symlinks. esbuild bundles everything into a single file, eliminating the need for node_modules in the packaged app.

## Key Files Reference

| Purpose | File |
|---------|------|
| Electron main entry | `apps/desktop/apps/main/src/main.ts` |
| React app entry | `apps/desktop/apps/renderer/src/main.tsx` |
| Forge config (packaging) | `apps/desktop/apps/main/forge.config.cjs` |
| Main process bundler | `apps/desktop/apps/main/bundle.mjs` |
| Vite config | `apps/desktop/apps/renderer/vite.config.ts` |
| Shared types | `apps/desktop/packages/shared/src/` |
| Core business logic | `apps/desktop/packages/core/src/` |
| Workspace config | `apps/desktop/pnpm-workspace.yaml` |
| Root scripts | `apps/desktop/package.json` |

## Feature Deep-Dives

Long-form docs for specific features. Read the relevant file before making changes in that area — it has the full product flow, technical flows, and (where applicable) a catalog of the LLM prompts involved with exact file:line pointers.

| Feature | Doc |
|---------|-----|
| Track Blocks — auto-updating note content (scheduled / event-driven / manual), Copilot skill, prompts catalog | `apps/desktop/TRACKS.md` |

## Common Tasks

### LLM configuration (single provider)
- Config file: `~/.crewm8/config/models.json`
- Schema: `{ provider: { flavor, apiKey?, baseURL?, headers? }, model: string }`
- Models catalog cache: `~/.crewm8/config/models.dev.json` (OpenAI/Anthropic/Google only)

### Add a new shared type
1. Edit `apps/desktop/packages/shared/src/`
2. Run `cd apps/desktop && npm run deps` to rebuild

### Modify main process
1. Edit `apps/desktop/apps/main/src/`
2. Restart dev server (main doesn't hot-reload)

### Modify renderer (React UI)
1. Edit `apps/desktop/apps/renderer/src/`
2. Changes hot-reload automatically in dev mode

### Add a new dependency to main
1. `cd apps/desktop/apps/main && pnpm add <package>`
2. Import in source - esbuild will bundle it

### Verify compilation
```bash
cd apps/desktop && npm run deps && npm run lint
```

## Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop | Electron 39.x |
| UI | React 19, Vite 7 |
| Styling | TailwindCSS, Radix UI |
| State | React hooks |
| AI | Vercel AI SDK, OpenAI/Anthropic/Google/OpenRouter providers, Vercel AI Gateway, Ollama, models.dev catalog |
| IPC | Electron contextBridge |
| Build | TypeScript 5.9, esbuild, Electron Forge |

## Environment Variables (for packaging)

For production builds with code signing:
- `APPLE_ID` - Apple Developer ID
- `APPLE_PASSWORD` - App-specific password
- `APPLE_TEAM_ID` - Team ID

Not required for local development.
