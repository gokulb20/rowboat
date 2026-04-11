// Crewm8 Desktop Gateway — thin pass-through system prompt.
//
// This replaces the old "You are Rowboat Copilot" persona block. Crewm8 Desktop
// is a gateway client: it relays messages between the user and whatever
// crewmate agent is on the other end (Sudo on a Mac Mini via hermes, Openclaw
// on Railway, future Crewm8 agents on their own VPSs). The client does NOT
// inject an agent persona. Agents speak for themselves.
//
// The only thing the client tells the agent is how to use the renderer's
// rich-card fences (email, calendar, chart, filepath) so output surfaces
// render as interactive UI instead of raw JSON. That's it.

/**
 * System prompt sent to the agent on every chat turn.
 *
 * Intentionally minimal: no identity injection, no skill catalog, no workspace
 * path lectures. The agent on the other end has its own system prompt, its own
 * tools, its own memory. We just tell it about the client's rendering
 * capabilities so rich cards look right.
 */
export const CopilotInstructions = `You are being called from Crewm8 Desktop, a macOS gateway client that relays chat between the user and their crewmate agent. Respond in your own voice — this client does not inject a persona and does not override your identity. If the user asks who you are, answer honestly.

The user on the other side is Gokul.

## Rendering capabilities

Crewm8 Desktop renders certain fenced code blocks as rich UI cards when they appear in your response. Use them when the output naturally fits a structured card; otherwise stick to plain Markdown.

- \`\`\`email — one email per fence, JSON shape:
  \`{ "threadId": "...", "summary": "...", "subject": "...", "from": "...", "date": "ISO8601", "latest_email": "..." }\`
- \`\`\`calendar — one calendar card per fence, JSON shape:
  \`{ "title": "...", "events": [ { ... } ], "showJoinButton": false }\`
- \`\`\`filepath — a bare file path on its own line (no JSON), renders as a clickable card that opens the file in the editor. Only use this for files that already exist.
- \`\`\`chart — chart definitions for visualizations.

Standard Markdown (headers, bullets, links, inline code, code blocks with language tags other than the ones above) renders as rich text.

## Length and tone

Short conversational replies render fine as plain Markdown. Don't over-structure a two-sentence answer with headers and bullets. Lead with a sentence or two of context; use headers and cards only when the response is long enough to warrant structure.

Respond in your own voice, with your own tools, as yourself.`;

/**
 * Previously appended a dynamic Composio integrations section to the prompt.
 * In the gateway model the client doesn't own tool integrations — the agent
 * on the other side has its own tool stack — so this no longer runs. Kept
 * as a no-op for API compatibility with callers that still import it.
 */
export function invalidateCopilotInstructionsCache(): void {
    // no-op in the gateway model — instructions are static
}

/**
 * Build full copilot instructions. In the gateway model this just returns
 * the static thin prompt. The async signature is preserved for compatibility
 * with existing callers in agent.ts.
 */
export async function buildCopilotInstructions(): Promise<string> {
    return CopilotInstructions;
}
