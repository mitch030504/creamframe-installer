import { useEffect, useMemo, useRef, useState } from 'react'
import Button from '@/components/buttons/Button'
import AnimatedCheckbox from '@/components/buttons/AnimatedCheckbox'
import Spinner from '@/components/common/Spinner'
import Dialog from '@/components/dialogs/Dialog'
import DialogHeader from '@/components/dialogs/DialogHeader'
import DialogBody from '@/components/dialogs/DialogBody'
import DialogFooter from '@/components/dialogs/DialogFooter'
import DialogActions from '@/components/dialogs/DialogActions'
import type { FrameDlc, FrameGame } from '@/types/frame'

interface FrameDlcDialogProps {
  game: FrameGame | null
  dlcs: FrameDlc[] | null
  loading: boolean
  error: string | null
  patching: boolean
  patchError: string | null
  onClose: () => void
  onRetry: () => void
  onPatchWithoutList: () => void
  onConfirm: (selectedIds: string[]) => void
}

/**
 * DLC picker for a Steam Frame APK patch. The header and footer stay fixed;
 * only the DLC list scrolls. A previous patch's selection is restored from the
 * APK manifest when it is available.
 */
const FrameDlcDialog = ({
  game,
  dlcs,
  loading,
  error,
  patching,
  patchError,
  onClose,
  onRetry,
  onPatchWithoutList,
  onConfirm,
}: FrameDlcDialogProps) => {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const available = useMemo(() => dlcs ?? [], [dlcs])

  useEffect(() => {
    if (dlcs && !loading && !error) searchRef.current?.focus()
  }, [dlcs, loading, error])
  const restoredIds = useMemo(() => {
    const ids = new Set(available.map((dlc) => dlc.appid))
    return (game?.patch_info?.dlc_ids ?? []).filter((id) => ids.has(id))
  }, [game, available])

  useEffect(() => {
    if (!game) {
      setSelected(new Set())
      setSearch('')
      return
    }
    if (!dlcs) return

    setSelected(
      new Set(
        restoredIds.length > 0
          ? restoredIds
          : dlcs.map((dlc) => dlc.appid)
      )
    )
    setSearch('')
  }, [game, dlcs, restoredIds])
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return available
    return available.filter(
      (dlc) =>
        dlc.name.toLowerCase().includes(query) || dlc.appid.includes(query)
    )
  }, [available, search])

  const selectedCount = selected.size
  const allSelected = available.length > 0 && selectedCount === available.length
  const savedIds = game?.patch_info?.dlc_ids ?? []
  const selectionUnavailable =
    !!game?.apk_patched &&
    restoredIds.length === 0 &&
    (game?.patch_info?.dlc_count ?? 0) > 0
  const selectionPartiallyRestored =
    restoredIds.length > 0 && restoredIds.length < savedIds.length
  const canConfirm = !loading && !error && !patching && selectedCount > 0
  const actionLabel = game?.apk_patched ? 'Re-patch' : 'Patch'

  const toggleDlc = (appid: string) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(appid)) next.delete(appid)
      else next.add(appid)
      return next
    })
  }

  const toggleAll = () => {
    setSelected(
      allSelected ? new Set() : new Set(available.map((dlc) => dlc.appid))
    )
  }

  return (
    <Dialog
      visible={!!game}
      onClose={patching ? undefined : onClose}
      preventBackdropClose={patching}
      size="large"
      role="dialog"
      ariaLabel={`DLC selection for ${game?.name ?? 'game'}`}
    >
      <DialogHeader onClose={patching ? undefined : onClose} hideCloseButton={patching}>
        <h3>{game?.apk_patched ? 'Manage DLCs' : 'Select DLCs'}</h3>
        <div className="dlc-game-info">
          <span className="game-title">{game?.name}</span>
          <span className="dlc-count">
            {selectedCount} of {available.length} selected
          </span>
        </div>
      </DialogHeader>

      <DialogBody className="frame-dlc-body">
        {loading ? (
          <div className="frame-dlc-loading">
            <Spinner />
            <p>Fetching the DLC list from the Steam Store...</p>
          </div>
        ) : error ? (
          <div className="frame-dlc-error" role="alert">
            <strong>Couldn&apos;t load the DLC list</strong>
            <p>{error}</p>
            <div className="frame-dlc-error-actions">
              <Button size="small" variant="secondary" onClick={onRetry}>
                Retry
              </Button>
              <Button
                size="small"
                variant="secondary"
                onClick={onPatchWithoutList}
                disabled={patching}
              >
                Patch without a DLC list
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="frame-dlc-toolbar">
              <input
                className="frame-dlc-search"
                type="search"
                ref={searchRef}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search DLCs..."
                aria-label="Search DLCs"
                data-autofocus
              />
              <AnimatedCheckbox
                checked={allSelected}
                onChange={toggleAll}
                label="Select all"
              />
            </div>

            {selectionUnavailable ? (
              <p className="frame-dlc-notice" role="status">
                The previous selection isn&apos;t stored for this older patch. All
                current DLCs are selected; clear any you don&apos;t want.
              </p>
            ) : (
              <p className="frame-dlc-notice">
                {game?.apk_patched && restoredIds.length > 0
                  ? selectionPartiallyRestored
                    ? 'The last patched selection is restored where it still exists in the Store list.'
                    : 'The last patched selection is restored.'
                  : 'All DLCs are selected by default.'}
              </p>
            )}

            <details className="frame-dlc-warning">
              <summary>Before you patch</summary>
              <ul>
                <li>Patching changes the APK signature and keeps the original as <code>.cream-backup</code>.</li>
                <li>The first launch may rebuild Lepton&apos;s container. Back up local saves or use Steam Cloud.</li>
                <li>DLC content is not downloaded; only client-side entitlement checks change.</li>
              </ul>
            </details>

            <ul className="frame-dlc-list">
              {filtered.map((dlc) => (
                <li key={dlc.appid} className="frame-dlc-item">
                  <AnimatedCheckbox
                    checked={selected.has(dlc.appid)}
                    onChange={() => toggleDlc(dlc.appid)}
                    label={dlc.name}
                    sublabel={`ID: ${dlc.appid}`}
                  />
                </li>
              ))}
              {filtered.length === 0 && (
                <li className="frame-dlc-empty">No DLCs match that search.</li>
              )}
            </ul>
          </>
        )}

        {patchError ? (
          <div className="frame-dlc-patch-error" role="alert">
            {patchError}
          </div>
        ) : null}
      </DialogBody>

      <DialogFooter>
        <DialogActions>
          {selectedCount === 0 && !loading && !error ? (
            <span className="frame-dlc-required" role="status">
              Select at least one DLC
            </span>
          ) : null}
          <Button variant="secondary" onClick={onClose} disabled={patching}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => onConfirm(Array.from(selected))}
            disabled={!canConfirm}
            isLoading={patching}
          >
            {actionLabel} with {selectedCount} DLC{selectedCount === 1 ? '' : 's'}
          </Button>
        </DialogActions>
      </DialogFooter>
    </Dialog>
  )
}

export default FrameDlcDialog
