import * as React from "react"
import { XIcon, CopyIcon, CheckIcon } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { useArtifactStore } from "@/contexts/artifact-context"
import { ArtifactRenderer } from "./ArtifactRenderer"

/**
 * Right-side slide-in panel that shows the currently-open artifact. Mounted
 * at the App root so it overlays the main content. When no artifact is open,
 * the panel is translated fully off-screen to the right (transform-based so
 * the CSS transition is GPU-accelerated and we don't re-mount the iframe
 * every time the panel closes).
 *
 * Width is fixed at 40% of viewport (min 420px, max 720px) — wide enough for
 * an HTML prototype or a long markdown doc without eating the whole screen.
 */
export function ArtifactPanel() {
  const { openArtifactId, artifacts, closeArtifact } = useArtifactStore()
  const artifact = openArtifactId ? artifacts.get(openArtifactId) : null
  const isOpen = !!artifact
  const [copied, setCopied] = React.useState(false)

  // ESC closes the panel
  React.useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeArtifact()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen, closeArtifact])

  const handleCopy = React.useCallback(async () => {
    if (!artifact) return
    try {
      await navigator.clipboard.writeText(artifact.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.error('[ArtifactPanel] copy failed:', err)
      toast.error('Copy failed')
    }
  }, [artifact])

  return (
    <div
      aria-hidden={!isOpen}
      className={cn(
        "fixed right-0 top-0 z-40 flex h-full flex-col border-l border-border bg-background shadow-2xl transition-transform duration-200 ease-out",
        "w-[40vw] min-w-[420px] max-w-[720px]",
        isOpen ? "translate-x-0" : "translate-x-full pointer-events-none",
      )}
    >
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">
            {artifact?.title || 'Artifact'}
          </span>
          {artifact && (
            <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {artifact.type}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleCopy}
            disabled={!artifact}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            aria-label="Copy artifact"
          >
            {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
          </button>
          <button
            type="button"
            onClick={closeArtifact}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Close artifact"
          >
            <XIcon className="size-4" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto">
        {artifact && <ArtifactRenderer artifact={artifact} />}
      </div>
    </div>
  )
}
