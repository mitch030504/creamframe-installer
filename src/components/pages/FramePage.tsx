import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import Button from '@/components/buttons/Button'
import Spinner from '@/components/common/Spinner'
import {
  FrameConfirmDialog,
  FrameDlcDialog,
  FrameGameRow,
  FrameLogPanel,
} from '@/components/frame'
import { useAppContext } from '@/contexts/useAppContext'
import type { Config } from '@/types/Config'
import type {
  FrameAction,
  FrameDlc,
  FrameGame,
  FrameMode,
  FramePendingAction,
  FramePrereqs,
  FrameScan,
  FrameScanSnapshot,
} from '@/types/frame'

const DEFAULT_REMOTE = 'steamos@frame'

interface DlcDialogState {
  game: FrameGame
  dlcs: FrameDlc[] | null
  loading: boolean
  error: string | null
  patching: boolean
  patchError: string | null
}

interface ConfirmState {
  game: FrameGame
  action: FrameAction
  title: string
  message: string
  confirmLabel: string
}

const ACTION_DONE: Record<FrameAction, string> = {
  android_patch: 'Patched',
  android_revert: 'Restored the original APK for',
  android_status: 'Checked the patch status for',
  android_reset: 'Reset the container for',
  native_install: 'Installed CreamFrame for',
  native_uninstall: 'Removed CreamFrame from',
  proton_install: 'Installed SmokeAPI for',
  proton_uninstall: 'Removed SmokeAPI from',
}

function messageFor(error: unknown): string {
  const text = String(error)
  return text.length > 600 ? `${text.slice(0, 600)}...` : text
}

function checkLabel(value: boolean): string {
  return value ? 'Available' : 'Missing'
}

function confirmCopy(game: FrameGame, action: FrameAction): Omit<ConfirmState, 'game' | 'action'> {
  switch (action) {
    case 'android_revert':
      return {
        title: 'Restore the original APK?',
        message: `This replaces the patched APK for ${game.name} with its .cream-backup and deletes the backup and patch record. DLC unlocks stop working.`,
        confirmLabel: 'Restore original',
      }
    case 'android_reset':
      return {
        title: 'Reset the Lepton container?',
        message: `This deletes Lepton's baked container for ${game.name}. The APK and backup are untouched, but local app data inside the container may be reset. The next launch will reinstall the APK.`,
        confirmLabel: 'Reset container',
      }
    case 'native_uninstall':
      return {
        title: 'Remove CreamFrame?',
        message: `This removes cream.sh, cream_api.ini and the CreamFrame library from ${game.name}. Launch options that point at cream.sh should be cleared in Steam.`,
        confirmLabel: 'Remove CreamFrame',
      }
    case 'proton_uninstall':
      return {
        title: 'Remove SmokeAPI?',
        message: `This restores the original Steam API DLL for ${game.name} and removes the CreamFrame config. DLC unlocks stop working.`,
        confirmLabel: 'Remove SmokeAPI',
      }
    default:
      return {
        title: 'Continue?',
        message: `Run this action for ${game.name}?`,
        confirmLabel: 'Continue',
      }
  }
}

export function FramePage() {
  const { showToast } = useAppContext()
  const [config, setConfig] = useState<Config | null>(null)
  const [remote, setRemote] = useState(DEFAULT_REMOTE)
  const [mode, setMode] = useState<FrameMode>('remote')
  const [prereqs, setPrereqs] = useState<FramePrereqs | null>(null)
  const [connection, setConnection] = useState('')
  const [scanSnapshot, setScanSnapshot] = useState<FrameScanSnapshot | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState('')
  const [actionError, setActionError] = useState('')
  const [pendingAction, setPendingAction] = useState<FramePendingAction | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [dlcDialog, setDlcDialog] = useState<DlcDialogState | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const requestRef = useRef(0)

  useEffect(() => {
    invoke<Config>('load_config')
      .then((cfg) => {
        setConfig(cfg)
        setRemote(cfg.frame_remote || DEFAULT_REMOTE)
      })
      .catch((err) => setActionError(messageFor(err)))
    invoke<FramePrereqs>('frame_prereqs')
      .then(setPrereqs)
      .catch((err) => setActionError(messageFor(err)))
  }, [])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    listen<string>('frame-progress', (event) => {
      if (disposed) return
      setLog((previous) => [...previous.slice(-199), event.payload])
    })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
      .catch((err) => console.error('Failed to listen for Frame progress:', err))
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  const saveRemote = useCallback(
    async (value: string) => {
      if (!config || config.frame_remote === value) return
      const next = { ...config, frame_remote: value }
      setConfig(next)
      try {
        await invoke('update_config', { configData: next })
      } catch (err) {
        setActionError(`Could not save the SSH target: ${messageFor(err)}`)
      }
    },
    [config]
  )

  const isStale =
    !!scanSnapshot &&
    (scanSnapshot.mode !== mode || scanSnapshot.remote !== remote)

  const ready = !!prereqs && (mode === 'remote'
    ? prereqs.remote_ready && prereqs.android_ready
    : prereqs.android_ready)

  const refresh = useCallback(async () => {
    const request = ++requestRef.current
    setScanning(true)
    setScanError('')
    setActionError('')
    setConnection('')
    try {
      const check = await invoke<string>('frame_check', {
        remote,
        local: mode === 'local',
      })
      if (request !== requestRef.current) return
      setConnection(check.trim())

      const result = await invoke<FrameScan>('frame_scan', {
        remote,
        local: mode === 'local',
      })
      if (request !== requestRef.current) return
      setScanSnapshot({ scan: result, mode, remote, at: Date.now() })
      await saveRemote(remote)
    } catch (err) {
      if (request === requestRef.current) setScanError(messageFor(err))
    } finally {
      if (request === requestRef.current) setScanning(false)
    }
  }, [mode, remote, saveRemote])

  const performAction = useCallback(
    async (game: FrameGame, action: FrameAction, iniPath?: string) => {
      setPendingAction({ appid: game.appid, action })
      setActionError('')
      setLog([])
      try {
        await invoke('frame_action', {
          remote,
          local: mode === 'local',
          appid: game.appid,
          action,
          smokeapiMode: action.startsWith('proton') ? 'proxy' : null,
          iniPath: iniPath ?? null,
        })
        await refresh()
      } finally {
        setPendingAction(null)
      }
    },
    [mode, refresh, remote]
  )

  const runAction = async (game: FrameGame, action: FrameAction) => {
    try {
      await performAction(game, action)
      showToast(`${ACTION_DONE[action]} ${game.name}`, 'success')
    } catch (err) {
      const message = messageFor(err)
      setActionError(message)
      showToast(message, 'error')
    }
  }

  const loadDlcs = async (game: FrameGame) => {
    setDlcDialog({
      game,
      dlcs: null,
      loading: true,
      error: null,
      patching: false,
      patchError: null,
    })
    try {
      const dlcs = await invoke<FrameDlc[]>('fetch_game_dlcs', { gameId: game.appid })
      setDlcDialog((previous) =>
        previous && previous.game.appid === game.appid
          ? { ...previous, dlcs, loading: false }
          : previous
      )
    } catch (err) {
      setDlcDialog((previous) =>
        previous && previous.game.appid === game.appid
          ? { ...previous, loading: false, error: messageFor(err) }
          : previous
      )
    }
  }

  const openDlc = (game: FrameGame) => {
    setActionError('')
    void loadDlcs(game)
  }

  const confirmDlc = async (selectedIds: string[]) => {
    const dialog = dlcDialog
    if (!dialog?.dlcs) return
    setDlcDialog((previous) => previous && { ...previous, patching: true, patchError: null })
    try {
      const names = new Map(dialog.dlcs.map((dlc) => [dlc.appid, dlc.name]))
      const selected: [string, string][] = selectedIds.map((id) => [
        id,
        names.get(id) ?? `DLC ${id}`,
      ])
      const iniPath = await invoke<string>('frame_write_ini', {
        appid: dialog.game.appid,
        dlcs: selected,
      })
      await performAction(dialog.game, 'android_patch', iniPath)
      setDlcDialog(null)
      showToast(
        `Patched ${dialog.game.name} with ${selectedIds.length} DLC${selectedIds.length === 1 ? '' : 's'}`,
        'success'
      )
    } catch (err) {
      const message = messageFor(err)
      setDlcDialog((previous) =>
        previous ? { ...previous, patching: false, patchError: message } : previous
      )
    }
  }

  const patchWithoutList = async () => {
    const dialog = dlcDialog
    if (!dialog) return
    setDlcDialog((previous) => previous && { ...previous, patching: true, patchError: null })
    try {
      await performAction(dialog.game, 'android_patch')
      setDlcDialog(null)
      showToast(`Patched ${dialog.game.name}`, 'success')
    } catch (err) {
      setDlcDialog((previous) =>
        previous ? { ...previous, patching: false, patchError: messageFor(err) } : previous
      )
    }
  }

  const askConfirm = (game: FrameGame, action: FrameAction) => {
    setConfirmError(null)
    setConfirm({ game, action, ...confirmCopy(game, action) })
  }

  const runConfirmedAction = async () => {
    if (!confirm) return
    setConfirmBusy(true)
    setConfirmError(null)
    try {
      await performAction(confirm.game, confirm.action)
      showToast(`${ACTION_DONE[confirm.action]} ${confirm.game.name}`, 'success')
      setConfirm(null)
    } catch (err) {
      setConfirmError(messageFor(err))
    } finally {
      setConfirmBusy(false)
    }
  }

  const changeMode = (next: FrameMode) => {
    if (next === mode || scanning || pendingAction) return
    setMode(next)
    setConnection('')
    setScanSnapshot(null)
    setScanError('')
    setActionError('')
    setLog([])
    setDlcDialog(null)
    setConfirm(null)
  }

  const frameGames =
    scanSnapshot?.scan.games.filter((game) =>
      mode === 'local' ? game.type === 'android' : game.type !== null
    ) ?? []

  const busy = scanning || !!pendingAction
  const targetName = mode === 'remote' ? remote : 'this device'

  return (
    <div className="frame-page">
      <div className="frame-page-scroll">
        <h2>Steam Frame</h2>
        <p className="frame-page-intro">
          Manage Android, native and Proton games on the remote Frame, or patch
          Android games on this device in Desktop Mode.
        </p>

        <section className="page-section page-section--wide frame-target-card">
          <div className="frame-target-heading">
            <div>
              <h3 className="frame-section-title">Target</h3>
              <p className="frame-target-name">
                {mode === 'remote' ? remote : 'This device'}
                {connection ? <span className="frame-target-connection"> · {connection}</span> : null}
              </p>
            </div>
            <span
              className={`frame-ready-chip ${
                !prereqs ? '' : ready ? 'ready' : 'warning'
              }`}
            >
              {!prereqs ? 'Checking tools...' : ready ? 'Installer tools ready' : 'Setup required'}
            </span>
          </div>

          <fieldset className="frame-mode-switch">
            <legend className="frame-visually-hidden">Choose a target</legend>
            <label className={mode === 'remote' ? 'selected' : ''}>
              <input
                type="radio"
                name="frame-target"
                checked={mode === 'remote'}
                onChange={() => changeMode('remote')}
                disabled={busy}
              />
              <span>Remote Frame</span>
            </label>
            <label className={mode === 'local' ? 'selected' : ''}>
              <input
                type="radio"
                name="frame-target"
                checked={mode === 'local'}
                onChange={() => changeMode('local')}
                disabled={busy}
              />
              <span>This device</span>
            </label>
          </fieldset>

          <p className="frame-mode-help">
            {mode === 'remote'
              ? 'Actions run on the Frame over SSH. The default target is steamos@frame.'
              : 'Android/Lepton games installed on this machine. On a Frame, run the installer in Desktop Mode.'}
          </p>

          {mode === 'remote' ? (
            <div className="frame-field">
              <label htmlFor="frame-remote-target">SSH target</label>
              <input
                id="frame-remote-target"
                className="frame-input"
                value={remote}
                onChange={(event) => {
                  setRemote(event.target.value)
                  setConnection('')
                  setScanError('')
                }}
                placeholder="steamos@frame"
                disabled={busy}
                spellCheck={false}
              />
            </div>
          ) : null}

          {mode === 'remote' && !scanSnapshot && !scanning && !scanError ? (
            <p className="frame-first-run-hint">
              Enable Developer Mode and set a user password on the Frame, then scan.
            </p>
          ) : null}

          <div className="frame-target-actions">
            <Button
              variant="primary"
              onClick={refresh}
              isLoading={scanning}
              disabled={!!pendingAction}
            >
              {scanning
                ? 'Scanning...'
                : mode === 'remote'
                  ? 'Scan Steam Frame'
                  : 'Scan this device'}
            </Button>
            <span className="frame-target-status" role="status">
              {connection
                ? 'Connected'
                : scanSnapshot
                  ? `Last scanned ${new Date(scanSnapshot.at).toLocaleTimeString()}`
                  : 'Not scanned yet'}
            </span>
          </div>

          {prereqs ? (
            <details className="frame-readiness">
              <summary>
                {ready ? 'Installer tools are ready' : 'Some installer tools are missing'}
              </summary>
              <ul>
                <li><span>Python</span><span>{checkLabel(prereqs.python)}</span></li>
                {mode === 'remote' ? (
                  <>
                    <li><span>SSH</span><span>{checkLabel(prereqs.ssh)}</span></li>
                    <li><span>rsync</span><span>{checkLabel(prereqs.rsync)}</span></li>
                  </>
                ) : null}
                <li><span>Bundled Java</span><span>{checkLabel(prereqs.bundled_java)}</span></li>
                <li><span>apksigner</span><span>{checkLabel(prereqs.bundled_apksigner)}</span></li>
                <li><span>Android proxy</span><span>{checkLabel(prereqs.bundled_proxy)}</span></li>
              </ul>
            </details>
          ) : null}
        </section>

        {scanError ? (
          <div className="frame-alert" role="alert">
            <div>
              <strong>Couldn&apos;t scan {targetName}</strong>
              <p>{scanError}</p>
            </div>
            <Button size="small" variant="secondary" onClick={refresh} disabled={busy}>
              Retry
            </Button>
          </div>
        ) : null}

        {actionError ? (
          <div className="frame-alert" role="alert">
            <div>
              <strong>Action failed</strong>
              <p>{actionError}</p>
            </div>
            <Button size="small" variant="secondary" onClick={() => setActionError('')}>
              Dismiss
            </Button>
          </div>
        ) : null}

        {isStale ? (
          <div className="frame-stale" role="status">
            <span>The target changed. Rescan to refresh the game list.</span>
            <Button size="small" variant="secondary" onClick={refresh} disabled={busy}>
              Rescan
            </Button>
          </div>
        ) : null}

        {scanning && !scanSnapshot ? (
          <section className="page-section page-section--wide frame-state-card frame-scanning">
            <Spinner />
            <p>Scanning {targetName}...</p>
          </section>
        ) : null}

        {scanSnapshot && frameGames.length === 0 ? (
          <section className="page-section page-section--wide frame-state-card">
            <h3 className="frame-section-title">No supported games found</h3>
            <p>
              {mode === 'local'
                ? 'This machine has no Android/Lepton games. Run the installer on the Frame in Desktop Mode, or switch to Remote Frame.'
                : `No Android, native or Proton games were found in the libraries on ${targetName}.`}
            </p>
            <Button size="small" variant="secondary" onClick={refresh} disabled={busy}>
              Rescan
            </Button>
          </section>
        ) : null}

        {scanSnapshot && frameGames.length > 0 ? (
          <section className="page-section page-section--wide frame-games-card">
            <div className="frame-games-header">
              <div>
                <h3 className="frame-section-title">Frame games</h3>
                <p className="frame-games-count">
                  {frameGames.length} game{frameGames.length === 1 ? '' : 's'} ·{' '}
                  {scanSnapshot.scan.libraries.length} librar
                  {scanSnapshot.scan.libraries.length === 1 ? 'y' : 'ies'}
                </p>
              </div>
              <Button size="small" variant="secondary" onClick={refresh} disabled={busy}>
                Rescan
              </Button>
            </div>

            {frameGames.some((game) => game.apk_backup && !game.apk_patched) ? (
              <p className="frame-list-note">
                A backup is present for at least one game. Steam may have replaced a
                patch; use Status or Steam&apos;s Verify integrity before restoring.
              </p>
            ) : null}

            <ul className="frame-game-list">
              {frameGames.map((game) => (
                <FrameGameRow
                  key={game.appid}
                  game={game}
                  pendingAction={pendingAction}
                  stale={isStale}
                  onPatch={openDlc}
                  onAction={runAction}
                  onConfirm={askConfirm}
                />
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <FrameLogPanel
        lines={log}
        running={scanning || !!pendingAction}
        onClear={() => setLog([])}
      />

      <FrameDlcDialog
        game={dlcDialog?.game ?? null}
        dlcs={dlcDialog?.dlcs ?? null}
        loading={dlcDialog?.loading ?? false}
        error={dlcDialog?.error ?? null}
        patching={dlcDialog?.patching ?? false}
        patchError={dlcDialog?.patchError ?? null}
        onClose={() => setDlcDialog(null)}
        onRetry={() => {
          if (dlcDialog) void loadDlcs(dlcDialog.game)
        }}
        onPatchWithoutList={patchWithoutList}
        onConfirm={confirmDlc}
      />

      <FrameConfirmDialog
        visible={!!confirm}
        title={confirm?.title ?? ''}
        message={confirm?.message ?? ''}
        confirmLabel={confirm?.confirmLabel ?? ''}
        busy={confirmBusy}
        error={confirmError}
        onCancel={() => {
          if (!confirmBusy) setConfirm(null)
        }}
        onConfirm={runConfirmedAction}
      />
    </div>
  )
}
