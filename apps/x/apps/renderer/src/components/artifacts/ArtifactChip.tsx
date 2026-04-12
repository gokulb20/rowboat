import { CodeIcon, FileTextIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { useArtifactStore } from "@/contexts/artifact-context"

/**
 * Inline chip shown inside an assistant message in place of a fenced
 * artifact block. Clicking it opens the side panel with the full
 * rendered content. Keeps the chat scroll compact even when the
 * artifact itself is a 200-line HTML prototype.
 */
export function ArtifactChip({ id }: { id: string }) {
  const { artifacts, openArtifact } = useArtifactStore()
  const artifact = artifacts.get(id)

  // Defensive: if the chip renders before the parse effect has registered
  // the artifact (first render of a just-arrived message), show a dim
  // placeholder rather than throwing.
  if (!artifact) {
    return (
      <span className="my-2 inline-flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
        Loading artifact…
      </span>
    )
  }

  const Icon = artifact.type === 'html' ? CodeIcon : FileTextIcon
  const typeLabel = artifact.type === 'html' ? 'HTML' : 'Markdown'

  return (
    <button
      type="button"
      onClick={() => openArtifact(id)}
      className={cn(
        "my-2 flex w-full max-w-md items-center gap-3 rounded-lg border border-border bg-card p-3 text-left shadow-sm transition-all hover:border-accent-foreground/20 hover:shadow-md",
      )}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{artifact.title}</span>
        <span className="text-xs text-muted-foreground">
          {typeLabel} artifact · click to open
        </span>
      </div>
    </button>
  )
}
