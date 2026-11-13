import { useState } from 'react'
import Button from '@/components/buttons/Button'
import type { FrameAction, FrameGame, FramePendingAction } from '@/types/frame'

interface FrameGameRowProps {
  game: FrameGame
  pendingAction: FramePendingAction | null
  stale: boolean
  onPatch: (game: FrameGame) => void
  onAction: (game: FrameGame, action: FrameAction) => void
  onConfirm: (game: FrameGame, action: FrameAction) => void
}

interface FrameState {
  label: string
  tone: 'success' | 'warning' | 'neutral'
  note?: string
}

function stateFor(game: FrameGame): FrameState {
  if (game.type === 'android') {
    if (game.apk_patched) return { label: 'Patched', tone: 'success' }
    if (game.apk_backup) {
      return { label: 'Backup available', tone: 'warning' }
    }
    return { label: 'Not patched', tone: 'neutral' }
  }
  if (game.type === 'native') {
    return game.cream_installed
      ? { label: 'Installed', tone: 'success', note: 'Launch options required.' }
      : { label: 'Not installed', tone: 'neutral' }
  }
  if (game.type === 'proton') {
    if (game.smoke_installed) return { label: 'Installed', tone: 'success' }
    if (game.smoke_overwritten) {
      return {
        label: 'Overwritten',
        tone: 'warning',
        note: 'The game update replaced SmokeAPI. Reinstall it.',
      }
    }
    return { label: 'Not installed', tone: 'neutral' }
  }
  return { label: 'Unsupported', tone: 'neutral' }
}

function typeLabel(game: FrameGame): string {
  if (game.type === 'android') return 'Android'
  if (game.type === 'native') return 'Native'
  if (game.type === 'proton') return 'Proton'
  return 'Unknown'
}

function formatBytes(bytes: number): string {
  if (!bytes) return 'unknown size'
  const mb = bytes / 1_000_000
  return mb >= 1000 ? `${(mb / 1000).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
}


/**
 * One Steam Frame game. Identity and state stay on the left; actions stay on a
 * single rail where there is room and wrap underneath on narrow windows. File
 * paths and recovery actions live in a full-width disclosure so they never
 * crowd the action rail.
 */
const FrameGameRow = ({
  game,
  pendingAction,
  stale,
  onPatch,
  onAction,
  onConfirm,
}: FrameGameRowProps) => {
  const [copied, setCopied] = useState('')
  const state = stateFor(game)
  const rowBusy = pendingAction?.appid === game.appid
  const disabled = stale || !!pendingAction
  const launchCommand = 'sh ./cream.sh %command%'

  const copyLaunchCommand = async () => {
    try {
      await navigator.clipboard.writeText(launchCommand)
      setCopied('Copied')
    } catch {
      setCopied('Copy failed')
    }
    window.setTimeout(() => setCopied(''), 2000)
  }

  const primaryButton = (() => {
    if (game.type === 'android') {
      return (
        <Button
          size="small"
          variant="primary"
          onClick={() => onPatch(game)}
          disabled={disabled}
          isLoading={rowBusy && pendingAction?.action === 'android_patch'}
          aria-label={`${game.apk_patched ? 'Manage DLCs for' : 'Patch APK for'} ${game.name}`}
        >
          {game.apk_patched ? 'Manage DLCs' : 'Patch APK'}
        </Button>
      )
    }
    if (game.type === 'native') {
      return (
        <Button
          size="small"
          variant="primary"
          onClick={() => onAction(game, 'native_install')}
          disabled={disabled}
          isLoading={rowBusy && pendingAction?.action === 'native_install'}
          aria-label={`${game.cream_installed ? 'Reinstall CreamFrame for' : 'Install CreamFrame for'} ${game.name}`}
        >
          {game.cream_installed ? 'Reinstall' : 'Install'}
        </Button>
      )
    }
    if (game.type === 'proton') {
      return (
        <Button
          size="small"
          variant="primary"
          onClick={() => onAction(game, 'proton_install')}
          disabled={disabled}
          isLoading={rowBusy && pendingAction?.action === 'proton_install'}
          aria-label={`${game.smoke_installed ? 'Reinstall SmokeAPI for' : 'Install SmokeAPI for'} ${game.name}`}
        >
          {game.smoke_installed ? 'Reinstall SmokeAPI' : 'Install SmokeAPI'}
        </Button>
      )
    }
    return null
  })()

  return (
    <li className="frame-game-row" aria-label={`${game.name}, ${state.label}`}>
      <div className="frame-game-main">
        <div className="frame-game-identity">
          <div className="frame-game-title-line">
            <h3 className="frame-game-title" title={game.name}>
              {game.name}
            </h3>
            <span className="frame-game-appid">{game.appid}</span>
          </div>

          <div className="frame-game-meta">
            <span className={`frame-type-badge frame-type-${game.type ?? 'unknown'}`}>
              {typeLabel(game)}
            </span>
            <span className={`frame-state-badge frame-state-${state.tone}`}>
              {state.label}
            </span>
            {game.type === 'android' && game.patch_info?.dlc_count ? (
              <span className="frame-game-fact">{game.patch_info.dlc_count} DLC</span>
            ) : null}
            {game.type === 'android' && game.apk_size ? (
              <span className="frame-game-fact">{formatBytes(game.apk_size)}</span>
            ) : null}
            {state.note ? <span className="frame-game-note">{state.note}</span> : null}
          </div>
        </div>

        <div className="frame-game-actions">
          {primaryButton}
          {game.type === 'android' && (
            <Button
              size="small"
              variant="secondary"
              onClick={() => onAction(game, 'android_status')}
              disabled={disabled}
              isLoading={rowBusy && pendingAction?.action === 'android_status'}
              aria-label={`Check patch status for ${game.name}`}
            >
              Status
            </Button>
          )}
          {game.type === 'android' && game.apk_patched && (
            <Button
              size="small"
              variant="danger"
              onClick={() => onConfirm(game, 'android_revert')}
              disabled={disabled}
              aria-label={`Restore the original APK for ${game.name}`}
            >
              Revert
            </Button>
          )}
          {(game.type === 'native' && game.cream_installed) ||
          (game.type === 'proton' && game.smoke_installed) ? (
            <Button
              size="small"
              variant="danger"
              onClick={() =>
                onConfirm(
                  game,
                  game.type === 'native' ? 'native_uninstall' : 'proton_uninstall'
                )
              }
              disabled={disabled}
              aria-label={`Uninstall ${game.type === 'proton' ? 'SmokeAPI' : 'CreamFrame'} from ${game.name}`}
            >
              Uninstall
            </Button>
          ) : null}
        </div>
      </div>

      <details className="frame-game-details">
        <summary>Details &amp; recovery</summary>
        <div className="frame-game-details-body">
          <dl className="frame-game-paths">
            <div>
              <dt>Library</dt>
              <dd title={game.library}>{game.library}</dd>
            </div>
            <div>
              <dt>Game folder</dt>
              <dd title={game.game_dir}>{game.game_dir}</dd>
            </div>
            {game.type === 'android' && game.apk_path ? (
              <div>
                <dt>APK</dt>
                <dd title={game.apk_path}>{game.apk_path}</dd>
              </div>
            ) : null}
            {game.type === 'android' && game.patch_info?.created ? (
              <div>
                <dt>Last patch</dt>
                <dd>{new Date(game.patch_info.created).toLocaleString()}</dd>
              </div>
            ) : null}
          </dl>

          {game.type === 'android' ? (
            <div className="frame-game-recovery">
              <p>
                Resetting Lepton&apos;s container can recover a game that no longer
                launches. The APK and the backup are left untouched, but local app
                data inside the container may be reset.
              </p>
              <Button
                size="small"
                variant="danger"
                onClick={() => onConfirm(game, 'android_reset')}
                disabled={disabled}
                aria-label={`Reset the Lepton container for ${game.name}`}
              >
                Reset container...
              </Button>
            </div>
          ) : null}

          {game.type === 'native' && game.cream_installed ? (
            <div className="frame-launch-step">
              <p>
                CreamFrame is installed. Set this as the game&apos;s Steam launch
                options:
              </p>
              <div className="frame-launch-command">
                <code>{launchCommand}</code>
                <Button
                  size="small"
                  variant="secondary"
                  onClick={copyLaunchCommand}
                  aria-label={`Copy launch options for ${game.name}`}
                >
                  Copy
                </Button>
              </div>
              <span className="frame-copy-status" role="status" aria-live="polite">
                {copied}
              </span>
            </div>
          ) : null}

          {game.type === 'proton' && game.smoke_installed ? (
            <p className="frame-game-recovery">
              SmokeAPI is active. If a game update replaces the Steam DLL, the row
              changes to <strong>Overwritten</strong> and you can reinstall it here.
            </p>
          ) : null}
        </div>
      </details>
    </li>
  )
}

export default FrameGameRow
