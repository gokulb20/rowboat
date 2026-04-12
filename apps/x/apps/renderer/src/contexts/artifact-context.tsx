import * as React from "react"
import type { ParsedArtifact } from "@/lib/parse-artifacts"

/**
 * Artifact store — holds every artifact the chat stream has produced, keyed
 * by a stable per-message ID (`<messageId>-artifact-<index>`). Also tracks
 * which artifact (if any) is currently open in the side panel.
 *
 * Writes come from the parseArtifacts preprocessor running during message
 * render. The preprocessor calls setArtifact(id, data) via a useEffect so
 * we never setState during render. Each call is idempotent: re-rendering
 * the same message with the same content re-writes the same record.
 *
 * Reads come from two places:
 *   - ArtifactChip (inside messages) — reads one artifact by ID to render
 *     its title + type badge.
 *   - ArtifactPanel (app root) — reads `openArtifactId` + the full record
 *     for rendering.
 */

export interface ArtifactContextValue {
  artifacts: Map<string, ParsedArtifact>
  openArtifactId: string | null
  setArtifact: (artifact: ParsedArtifact) => void
  openArtifact: (id: string) => void
  closeArtifact: () => void
}

const ArtifactContext = React.createContext<ArtifactContextValue | null>(null)

export function useArtifactStore(): ArtifactContextValue {
  const ctx = React.useContext(ArtifactContext)
  if (!ctx) {
    throw new Error("useArtifactStore must be used within an ArtifactProvider")
  }
  return ctx
}

/**
 * Lightweight read-one hook so components don't have to pluck from the Map
 * themselves. Returns undefined if the artifact doesn't exist yet (e.g.
 * a chip was rendered before its register effect fired — rare, but possible
 * on the very first render).
 */
export function useArtifact(id: string): ParsedArtifact | undefined {
  const { artifacts } = useArtifactStore()
  return artifacts.get(id)
}

export function ArtifactProvider({ children }: { children: React.ReactNode }) {
  // Map is held in a ref + mirrored to a version counter so updates trigger
  // re-renders for consumers. A plain Map inside state would work but every
  // setArtifact call would clone the whole Map. The ref + version pattern is
  // O(1) per write with exactly one re-render.
  const artifactsRef = React.useRef<Map<string, ParsedArtifact>>(new Map())
  const [, setVersion] = React.useState(0)
  const [openArtifactId, setOpenArtifactId] = React.useState<string | null>(null)

  const setArtifact = React.useCallback((artifact: ParsedArtifact) => {
    const existing = artifactsRef.current.get(artifact.id)
    // Skip no-op writes so we don't spam re-renders for identical content
    // (the parseArtifacts effect runs on every message re-render).
    if (
      existing &&
      existing.type === artifact.type &&
      existing.title === artifact.title &&
      existing.content === artifact.content
    ) {
      return
    }
    artifactsRef.current.set(artifact.id, artifact)
    setVersion((v) => v + 1)
  }, [])

  const openArtifact = React.useCallback((id: string) => {
    setOpenArtifactId(id)
  }, [])

  const closeArtifact = React.useCallback(() => {
    setOpenArtifactId(null)
  }, [])

  const value = React.useMemo<ArtifactContextValue>(
    () => ({
      artifacts: artifactsRef.current,
      openArtifactId,
      setArtifact,
      openArtifact,
      closeArtifact,
    }),
    [openArtifactId, setArtifact, openArtifact, closeArtifact],
  )

  return <ArtifactContext.Provider value={value}>{children}</ArtifactContext.Provider>
}
