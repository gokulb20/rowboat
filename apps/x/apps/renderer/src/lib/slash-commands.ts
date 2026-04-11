/**
 * Slash command registry for Crewm8 Desktop.
 *
 * Commands are either:
 *  - "intercept": handled client-side before any message reaches hermes
 *  - "passthrough": sent as-is to hermes (the message text is forwarded verbatim)
 *
 * To add a new command, add an entry to SLASH_COMMANDS. The rest is automatic.
 */

export type SlashCommandKind = 'intercept' | 'passthrough'

export interface SlashCommand {
  /** The token after the slash, lowercase, no spaces (e.g. "model", "new") */
  name: string
  /** One-line description shown in the autocomplete popover */
  description: string
  /** Sub-commands shown as secondary hints in the popover (optional) */
  subcommands?: string[]
  kind: SlashCommandKind
}

/**
 * Context object provided by the renderer to the interceptor.
 */
export interface SlashCommandContext {
  /** Opens the model picker dropdown */
  openModelPicker: () => void
  /** Lists available model names for inline display */
  listModels: () => Promise<string[]>
  /** Clears the current chat tab — equivalent to pressing "New Chat" */
  clearCurrentTab: () => void
  /** Opens the Settings dialog */
  openSettings: () => void
  /** Displays a synthetic assistant message inline (not sent to hermes) */
  showInlineReply: (text: string) => void
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  // Client-side intercepts
  {
    name: 'model',
    description: 'Switch the active LLM model',
    subcommands: ['list'],
    kind: 'intercept',
  },
  {
    name: 'new',
    description: 'Start a fresh conversation in this tab',
    kind: 'intercept',
  },
  {
    name: 'clear',
    description: 'Clear the current conversation (alias for /new)',
    kind: 'intercept',
  },
  {
    name: 'settings',
    description: 'Open the Settings dialog',
    kind: 'intercept',
  },
  {
    name: 'help',
    description: 'Show available slash commands',
    kind: 'intercept',
  },
  // Passthrough to hermes — hermes already handles these for its other channels
  {
    name: 'retry',
    description: 'Ask hermes to retry the last response',
    kind: 'passthrough',
  },
  {
    name: 'status',
    description: 'Ask hermes to report the current session status',
    kind: 'passthrough',
  },
  {
    name: 'voice',
    description: 'Toggle hermes voice mode (on | off)',
    subcommands: ['on', 'off'],
    kind: 'passthrough',
  },
] as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parses a raw input string into the matching command and its trailing args.
 * Returns null when the input does not start with `/` or does not match any
 * registered command name (unknown commands should fall through to hermes).
 */
export function parseSlashCommand(
  input: string,
): { command: SlashCommand; args: string } | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null

  const withoutSlash = trimmed.slice(1)
  const spaceIdx = withoutSlash.indexOf(' ')
  const name = (spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx)).toLowerCase()
  const args = spaceIdx === -1 ? '' : withoutSlash.slice(spaceIdx + 1).trim()

  const command = SLASH_COMMANDS.find((c) => c.name === name)
  if (!command) return null

  return { command, args }
}

/**
 * Attempts to handle the input as a client-side slash command.
 *
 * Returns true  → the command was handled; the caller must NOT send the message to hermes.
 * Returns false → not handled (either not a slash command, an unknown one, or a passthrough);
 *                 the caller should proceed with normal submission.
 */
export async function maybeInterceptSlashCommand(
  input: string,
  context: SlashCommandContext,
): Promise<boolean> {
  const parsed = parseSlashCommand(input)

  // Not a slash command at all, or not in the registry → passthrough
  if (!parsed) return false

  const { command, args } = parsed

  // Passthrough commands are sent as-is to hermes
  if (command.kind === 'passthrough') return false

  switch (command.name) {
    case 'model': {
      if (args === 'list') {
        const models = await context.listModels()
        if (models.length === 0) {
          context.showInlineReply('No models configured. Open Settings → Models to add one.')
        } else {
          context.showInlineReply(
            `Available models:\n${models.map((m) => `  • ${m}`).join('\n')}`,
          )
        }
      } else {
        context.openModelPicker()
      }
      return true
    }

    case 'new':
    case 'clear': {
      context.clearCurrentTab()
      return true
    }

    case 'settings': {
      context.openSettings()
      return true
    }

    case 'help': {
      const lines = SLASH_COMMANDS.map((c) => {
        const subs = c.subcommands?.length
          ? ` [${c.subcommands.join(' | ')}]`
          : ''
        const badge = c.kind === 'passthrough' ? ' (hermes)' : ''
        return `  /${c.name}${subs} — ${c.description}${badge}`
      })
      context.showInlineReply(`Slash commands:\n${lines.join('\n')}`)
      return true
    }

    default:
      return false
  }
}
