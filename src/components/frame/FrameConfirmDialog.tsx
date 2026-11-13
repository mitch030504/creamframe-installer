import Button from '@/components/buttons/Button'
import Dialog from '@/components/dialogs/Dialog'
import DialogHeader from '@/components/dialogs/DialogHeader'
import DialogBody from '@/components/dialogs/DialogBody'
import DialogFooter from '@/components/dialogs/DialogFooter'
import DialogActions from '@/components/dialogs/DialogActions'

interface FrameConfirmDialogProps {
  visible: boolean
  title: string
  message: string
  confirmLabel: string
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Shared confirmation for Frame actions that remove or replace files.
 * Cancel receives initial focus; the confirm button is the only danger action.
 */
const FrameConfirmDialog = ({
  visible,
  title,
  message,
  confirmLabel,
  busy,
  error,
  onCancel,
  onConfirm,
}: FrameConfirmDialogProps) => {
  return (
    <Dialog
      visible={visible}
      onClose={busy ? undefined : onCancel}
      preventBackdropClose={busy}
      size="small"
      role="alertdialog"
      ariaLabel={title}
    >
      <DialogHeader onClose={busy ? undefined : onCancel} hideCloseButton={busy}>
        <h3>{title}</h3>
      </DialogHeader>
      <DialogBody>
        <p className="frame-confirm-message">{message}</p>
        {error ? (
          <div className="frame-confirm-error" role="alert">
            {error}
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <DialogActions>
          <Button variant="secondary" onClick={onCancel} disabled={busy} autoFocus data-autofocus>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} isLoading={busy}>
            {confirmLabel}
          </Button>
        </DialogActions>
      </DialogFooter>
    </Dialog>
  )
}

export default FrameConfirmDialog
