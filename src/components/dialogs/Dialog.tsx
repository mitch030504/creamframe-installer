import { ReactNode, useEffect, useRef, useState } from 'react'

export interface DialogProps {
  visible: boolean
  onClose?: () => void
  className?: string
  preventBackdropClose?: boolean
  children: ReactNode
  size?: 'small' | 'medium' | 'large'
  showAnimationOnUnmount?: boolean
  role?: 'dialog' | 'alertdialog'
  ariaLabel?: string
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => element.offsetParent !== null || element === document.activeElement)
}

/**
 * Base Dialog component that serves as a container for dialog content
 * Used with DialogHeader, DialogBody, and DialogFooter components
 */
const Dialog = ({
  visible,
  onClose,
  className = '',
  preventBackdropClose = false,
  children,
  size = 'medium',
  showAnimationOnUnmount = true,
  role = 'dialog',
  ariaLabel,
}: DialogProps) => {
  const [showContent, setShowContent] = useState(false)
  const [shouldRender, setShouldRender] = useState(visible)
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  // Handle visibility changes with animations
  useEffect(() => {
    if (visible) {
      setShouldRender(true)
      // Small delay to trigger entrance animation after component is mounted
      const timer = setTimeout(() => {
        setShowContent(true)
      }, 50)
      return () => clearTimeout(timer)
    } else if (showAnimationOnUnmount) {
      // First hide content with animation
      setShowContent(false)
      // Then unmount after animation completes
      const timer = setTimeout(() => {
        setShouldRender(false)
      }, 300) // Match this with your CSS transition duration
      return () => clearTimeout(timer)
    } else {
      // Immediately unmount without animation
      setShowContent(false)
      setShouldRender(false)
    }
  }, [visible, showAnimationOnUnmount])

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !preventBackdropClose && onClose) {
      onClose()
    }
  }

  // Move focus into the dialog, keep Tab inside it, and return focus to the
  // control that opened it. Escape closes the topmost dialog only.
  useEffect(() => {
    if (!showContent) return
    previousFocusRef.current = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    if (!dialog) return
    const preferred = dialog.querySelector<HTMLElement>('[data-autofocus]')
    const [first] = focusableElements(dialog)
    ;(preferred ?? first ?? dialog).focus()
    return () => {
      const previous = previousFocusRef.current
      previousFocusRef.current = null
      if (previous && document.contains(previous)) previous.focus()
    }
  }, [showContent])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && onClose && !preventBackdropClose) {
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = focusableElements(dialog)
    if (focusable.length === 0) {
      event.preventDefault()
      event.stopPropagation()
      dialog.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault()
      event.stopPropagation()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      event.stopPropagation()
      first.focus()
    }
  }

  // Don't render anything if dialog shouldn't be shown
  if (!shouldRender) return null

  const sizeClass = {
    small: 'dialog-small',
    medium: 'dialog-medium',
    large: 'dialog-large',
  }[size]

  return (
    <div className={`dialog-overlay ${showContent ? 'visible' : ''}`} onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className={`dialog ${sizeClass} ${className} ${showContent ? 'dialog-visible' : ''}`}
        role={role}
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </div>
  )
}

export default Dialog
