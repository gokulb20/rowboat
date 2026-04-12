/**
 * Artifact parser — finds completed ```html artifact / ```markdown artifact
 * fences in a streaming markdown message, extracts them into typed records,
 * and replaces the source with a reference fence that the markdown renderer
 * will turn into an inline chip.
 *
 * CONVENTION
 * ----------
 * Sudo (or any agent) produces artifacts by emitting a fenced code block
 * whose language is `html` or `markdown` followed by the literal keyword
 * `artifact` and (optionally) a title="..." attribute:
 *
 *   ```html artifact title="Weekly Planner"
 *   <!DOCTYPE html>
 *   ...
 *   ```
 *
 *   ```markdown artifact title="Meeting Agenda"
 *   # Meeting agenda
 *   ...
 *   ```
 *
 * STREAMING BEHAVIOR
 * ------------------
 * The regex only matches *complete* fences (both opening ``` and closing ```
 * present). While an artifact is still streaming in — the closing fence hasn't
 * arrived yet — it stays as raw text in the message and renders as a normal
 * code block. As soon as the closing fence lands, the next re-render finds a
 * complete match and promotes it to a chip. IDs are deterministic per message
 * so the chip is stable across re-renders once the artifact exists.
 */

export type ArtifactType = 'html' | 'markdown'

export interface ParsedArtifact {
  id: string
  type: ArtifactType
  title: string
  content: string
}

export interface ParseArtifactsResult {
  cleanedText: string
  artifacts: ParsedArtifact[]
}

// Matches a complete fenced artifact block, line-anchored. The order of
// captures: (1) type, (2) optional title, (3) body content.
const ARTIFACT_FENCE_REGEX = /^```(html|markdown)\s+artifact(?:\s+title="([^"]+)")?\n([\s\S]*?)\n```$/gm

export function parseArtifacts(text: string, messageId: string): ParseArtifactsResult {
  const artifacts: ParsedArtifact[] = []
  let index = 0
  const cleanedText = text.replace(ARTIFACT_FENCE_REGEX, (_match, type: string, rawTitle: string | undefined, content: string) => {
    const id = `${messageId}-artifact-${index}`
    const title = rawTitle?.trim() || `Untitled ${type === 'html' ? 'HTML' : 'Markdown'}`
    artifacts.push({
      id,
      type: type as ArtifactType,
      title,
      content,
    })
    index += 1
    // Leave a fenced reference block in the message text. The markdown
    // renderer's <pre> override recognizes `language-artifact-ref` and
    // replaces it with an <ArtifactChip> that looks up by ID.
    return '```artifact-ref\n' + id + '\n```'
  })
  return { cleanedText, artifacts }
}
