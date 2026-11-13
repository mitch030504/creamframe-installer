import { useEffect, useRef, useState } from 'react'
import Button from '@/components/buttons/Button'

interface FrameLogPanelProps {
  lines: string[]
  running: boolean
  onClear: () => void
}

/**
 * Reserved activity row at the bottom of the Frame page. It starts as a quiet
 * one-line strip and expands without overlaying the game list.
 */
const FrameLogPanel = ({ lines, running, onClear }: FrameLogPanelProps) => {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState('')
  const logRef = useRef<HTMLPreElement>(null)
  const pinnedRef = useRef(true)

  useEffect(() => {
    if (!expanded || !logRef.current || !pinnedRef.current) return
    logRef.current.scrollTop = logRef.current.scrollHeight
  }, [lines, expanded])

  const lastLine = lines[lines.length - 1]
  const summary = lastLine ?? (running ? 'Working...' : 'No activity yet')

  const handleScroll = () => {
    const element = logRef.current
    if (!element) return
    pinnedRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 24
  }

  const copyLog = async () => {
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopied('Copied')
    } catch {
      setCopied('Copy failed')
    }
    window.setTimeout(() => setCopied(''), 2000)
  }

  return (
    <section className="frame-activity" aria-label="Activity log">
      <button
        type="button"
        className="frame-activity-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="frame-activity-label">Activity</span>
        <span className="frame-activity-summary" title={summary}>
          {summary}
        </span>
        {running ? <span className="frame-activity-running">Running</span> : null}
        <span className="frame-activity-chevron" aria-hidden="true">
          {expanded ? '−' : '+'}
        </span>
      </button>

      {expanded ? (
        <div className="frame-activity-body">
          <pre
            ref={logRef}
            className="frame-activity-log"
            role="log"
            aria-live="polite"
            tabIndex={0}
            onScroll={handleScroll}
          >
            {lines.length > 0 ? lines.join('\n') : 'No activity yet.'}
          </pre>
          <div className="frame-activity-actions">
            <span className="frame-copy-status" role="status" aria-live="polite">
              {copied}
            </span>
            <Button
              size="small"
              variant="secondary"
              onClick={copyLog}
              disabled={lines.length === 0}
            >
              Copy
            </Button>
            <Button
              size="small"
              variant="secondary"
              onClick={onClear}
              disabled={lines.length === 0 || running}
            >
              Clear
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  )
}

export default FrameLogPanel
