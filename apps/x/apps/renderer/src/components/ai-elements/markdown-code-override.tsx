import { isValidElement, type JSX } from 'react'
import { FilePathCard } from './file-path-card'
import { ArtifactChip } from '@/components/artifacts/ArtifactChip'

export function MarkdownPreOverride(props: JSX.IntrinsicElements['pre']) {
  const { children, ...rest } = props

  // Inspect the child <code>'s language class to decide what (if anything)
  // to render in place of the default <pre>.
  if (isValidElement(children)) {
    const childProps = children.props as { className?: string; children?: unknown }
    const className = typeof childProps.className === 'string' ? childProps.className : ''

    // language-filepath → FilePathCard
    if (className.includes('language-filepath')) {
      const text = typeof childProps.children === 'string'
        ? childProps.children.trim()
        : ''
      if (text) {
        return <FilePathCard filePath={text} />
      }
    }

    // language-artifact-ref → ArtifactChip. The code body is the artifact ID
    // injected by parseArtifacts(). The chip component looks up the full
    // artifact record from the ArtifactProvider by ID.
    if (className.includes('language-artifact-ref')) {
      const id = typeof childProps.children === 'string'
        ? childProps.children.trim()
        : ''
      if (id) {
        return <ArtifactChip id={id} />
      }
    }
  }

  // Passthrough for all other code blocks - return children directly
  // so Streamdown's own rendering (syntax highlighting, etc.) is preserved
  return <pre {...rest}>{children}</pre>
}
