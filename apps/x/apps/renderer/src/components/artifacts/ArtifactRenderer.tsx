import type { ParsedArtifact } from "@/lib/parse-artifacts"
import { MessageResponse } from "@/components/ai-elements/message"
import { MarkdownPreOverride } from "@/components/ai-elements/markdown-code-override"

/**
 * Renders the *body* of an artifact. Switches on type:
 *   - 'markdown' → reuses the same Streamdown/MessageResponse pipeline the
 *                  chat uses, so formatting, syntax highlighting, and wiki
 *                  links look consistent with chat messages.
 *   - 'html'     → renders inside a sandboxed iframe via srcdoc. The sandbox
 *                  attribute grants scripts-only: `allow-scripts` means JS
 *                  runs (so small interactive demos work), but we DO NOT
 *                  grant `allow-same-origin`, so the iframe can't reach the
 *                  parent window, can't touch localStorage, can't set cookies,
 *                  and in practice can't make network calls to Crewm8's own
 *                  origin. This is the same sandbox Claude.ai uses for HTML
 *                  artifacts.
 */
export function ArtifactRenderer({ artifact }: { artifact: ParsedArtifact }) {
  if (artifact.type === 'markdown') {
    return (
      <div className="prose prose-sm dark:prose-invert max-w-none p-4">
        <MessageResponse components={{ pre: MarkdownPreOverride }}>
          {artifact.content}
        </MessageResponse>
      </div>
    )
  }

  if (artifact.type === 'html') {
    return (
      <iframe
        title={artifact.title}
        srcDoc={artifact.content}
        sandbox="allow-scripts"
        className="h-full w-full border-0 bg-white"
      />
    )
  }

  return (
    <div className="p-4 text-sm text-muted-foreground">
      Unknown artifact type: {(artifact as ParsedArtifact).type}
    </div>
  )
}
