import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { Config } from '@/types/Config'

interface FrameGame {
  appid: string
  name: string
  installdir: string
  game_dir: string
  library: string
  compatdata: string
  type: 'android' | 'native' | 'proton' | null
  apk_path: string | null
  apk_size: number
  apk_patched: boolean
  apk_backup: string | null
  patch_info: { dlc_count?: number; original_sha256?: string; patched_sha256?: string } | null
  native_lib: string | null
  proton_dll: string | null
}

interface FrameScan {
  steam: string
  libraries: string[]
  games: FrameGame[]
}

interface FramePrereqs {
  python: boolean
  ssh: boolean
  rsync: boolean
  bundled_java: boolean
  bundled_apksigner: boolean
  bundled_proxy: boolean
  android_ready: boolean
  remote_ready: boolean
}

const actionLabel: Record<string, string> = {
  android_patch: 'Patch APK',
  android_revert: 'Revert APK',
  android_status: 'Status',
  android_reset: 'Reset container',
  native_install: 'Install',
  native_uninstall: 'Uninstall',
  proton_install: 'Install SmokeAPI',
  proton_uninstall: 'Uninstall SmokeAPI',
}

function stateFor(game: FrameGame): string {
  if (game.type === 'android') {
    if (game.apk_patched) return 'patched'
    if (game.apk_backup) return 'backup present'
    return 'not patched'
  }
  return game.type ?? 'unsupported'
}

export function FramePage() {
  const [config, setConfig] = useState<Config | null>(null)
  const [remote, setRemote] = useState('steamos@frame')
  const [mode, setMode] = useState<'remote' | 'local'>('remote')
  const [prereqs, setPrereqs] = useState<FramePrereqs | null>(null)
  const [connection, setConnection] = useState('')
  const [scan, setScan] = useState<FrameScan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [log, setLog] = useState<string[]>([])
  const [dlcDialog, setDlcDialog] = useState<{
    game: FrameGame
    dlcs: { appid: string; name: string; enabled: boolean }[]
  } | null>(null)
  const logRef = useRef<HTMLPreElement | null>(null)

  useEffect(() => {
    invoke<Config>('load_config')
      .then((cfg) => {
        setConfig(cfg)
        setRemote(cfg.frame_remote || 'steamos@frame')
      })
      .catch((err) => setError(String(err)))
    invoke<FramePrereqs>('frame_prereqs')
      .then(setPrereqs)
      .catch((err) => setError(String(err)))
  }, [])

  useEffect(() => {
    const unlisten = listen<string>('frame-progress', (event) => {
      setLog((previous) => [...previous.slice(-199), event.payload])
    })
    return () => {
      unlisten.then((fn) => fn()).catch(() => {})
    }
  }, [])

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [log])

  const saveRemote = useCallback(
    async (value: string) => {
      if (!config) return
      const next = { ...config, frame_remote: value }
      setConfig(next)
      try {
        await invoke('update_config', { configData: next })
      } catch (err) {
        setError(String(err))
      }
    },
    [config]
  )

  const check = async () => {
    setError('')
    setConnection('')
    try {
      const result = await invoke<string>('frame_check', { remote, local: mode === 'local' })
      setConnection(result)
      await saveRemote(remote)
    } catch (err) {
      setError(String(err))
    }
  }

  const refresh = async () => {
    setError('')
    setBusy(true)
    try {
      const result = await invoke<FrameScan>('frame_scan', { remote, local: mode === 'local' })
      setScan(result)
      await saveRemote(remote)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const runAction = async (game: FrameGame, action: string, iniPath?: string) => {
    setError('')
    setBusy(true)
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
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const openPatch = async (game: FrameGame) => {
    setError('')
    setBusy(true)
    try {
      const dlcs = await invoke<{ appid: string; name: string }[]>(
        'fetch_game_dlcs',
        { gameId: game.appid }
      )
      setDlcDialog({
        game,
        dlcs: dlcs.map((dlc) => ({ ...dlc, enabled: true })),
      })
    } catch (err) {
      // DLC fetch failure should not block patching; fall back to all DLCs.
      console.warn('DLC fetch failed, patching with all DLCs', err)
      await runAction(game, 'android_patch')
    } finally {
      setBusy(false)
    }
  }

  const confirmPatch = async () => {
    if (!dlcDialog) return
    const selected = dlcDialog.dlcs
      .filter((dlc) => dlc.enabled)
      .map((dlc) => [dlc.appid, dlc.name])
    setDlcDialog(null)
    setBusy(true)
    try {
      const iniPath = await invoke<string>('frame_write_ini', {
        appid: dlcDialog.game.appid,
        dlcs: selected,
      })
      await runAction(dlcDialog.game, 'android_patch', iniPath)
    } catch (err) {
      setError(String(err))
      setBusy(false)
    }
  }

  const games = scan?.games ?? []
  const frameGames = games.filter((game) =>
    mode === 'local' ? game.type === 'android' : game.type !== null
  )

  return (
    <div className="frame-page" style={{ padding: '1.5rem', overflow: 'auto' }}>
      <div className="frame-header">
        <div>
          <h2 style={{ margin: 0 }}>Steam Frame</h2>
          <p style={{ opacity: 0.7, marginTop: '0.35rem' }}>
            Manage Android/Lepton APKs and remote CreamFrame installs on the
            Frame over SSH, or patch this device's local Android games. Native
            and Proton installs for this device remain in the Library tab.
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '1rem 0' }}>
        <button
          onClick={() => setMode('remote')}
          style={{ opacity: mode === 'remote' ? 1 : 0.6 }}
        >
          Remote Frame
        </button>
        <button
          onClick={() => setMode('local')}
          style={{ opacity: mode === 'local' ? 1 : 0.6 }}
        >
          This device
        </button>
        <input
          value={remote}
          onChange={(event) => setRemote(event.target.value)}
          onBlur={() => saveRemote(remote)}
          placeholder="steamos@frame"
          disabled={mode === 'local'}
          style={{ minWidth: '18rem', padding: '0.55rem', borderRadius: '6px' }}
        />
        <button onClick={check} disabled={busy}>Test connection</button>
        <button onClick={refresh} disabled={busy}>{busy ? 'Working...' : 'Scan Frame'}</button>
        {connection && <span style={{ color: '#64d28b' }}>✓ {connection}</span>}
      </div>

      {prereqs && (
        <div className="frame-prereqs" style={{ fontSize: '0.85rem', opacity: 0.8, marginBottom: '0.75rem' }}>
          Host: python {prereqs.python ? '✓' : '✗'} · ssh {prereqs.ssh ? '✓' : '✗'} · rsync{' '}
          {prereqs.rsync ? '✓' : '✗'} · bundled Java {prereqs.bundled_java ? '✓' : '✗'} · apksigner{' '}
          {prereqs.bundled_apksigner ? '✓' : '✗'}
        </div>
      )}

      {error && (
        <div style={{ color: '#ff8a8a', whiteSpace: 'pre-wrap', margin: '0.75rem 0' }}>
          {error}
        </div>
      )}

      {scan && (
        <>
          <div style={{ opacity: 0.7, marginBottom: '0.5rem' }}>
            {frameGames.length} supported games in {scan.libraries.length} library folders
          </div>
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            {frameGames.map((game) => (
              <div
                key={game.appid}
                style={{
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: '8px',
                  padding: '0.75rem',
                  display: 'flex',
                  gap: '1rem',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <strong>{game.name}</strong>
                  <span style={{ opacity: 0.6, marginLeft: '0.5rem' }}>{game.appid}</span>
                  <div style={{ fontSize: '0.8rem', opacity: 0.7 }}>
                    {game.type} · {stateFor(game)}
                    {game.patch_info?.dlc_count ? ` · ${game.patch_info.dlc_count} DLC` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                  {game.type === 'android' && (
                    <>
                      <button onClick={() => openPatch(game)} disabled={busy}>
                        {actionLabel.android_patch}
                      </button>
                      <button onClick={() => runAction(game, 'android_status')} disabled={busy}>
                        Status
                      </button>
                      <button onClick={() => runAction(game, 'android_revert')} disabled={busy}>
                        Revert
                      </button>
                      <button onClick={() => runAction(game, 'android_reset')} disabled={busy}>
                        Reset
                      </button>
                    </>
                  )}
                  {game.type === 'native' && (
                    <>
                      <button onClick={() => runAction(game, 'native_install')} disabled={busy}>
                        {actionLabel.native_install}
                      </button>
                      <button onClick={() => runAction(game, 'native_uninstall')} disabled={busy}>
                        Uninstall
                      </button>
                    </>
                  )}
                  {game.type === 'proton' && (
                    <>
                      <button onClick={() => runAction(game, 'proton_install')} disabled={busy}>
                        {actionLabel.proton_install}
                      </button>
                      <button onClick={() => runAction(game, 'proton_uninstall')} disabled={busy}>
                        Uninstall
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {dlcDialog && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: '#1c1f26',
              padding: '1.25rem',
              borderRadius: '10px',
              width: 'min(42rem, 90vw)',
              maxHeight: '80vh',
              overflow: 'auto',
            }}
          >
            <h3 style={{ marginTop: 0 }}>
              DLCs for {dlcDialog.game.name}
            </h3>
            <p style={{ opacity: 0.7 }}>
              Only selected DLCs are enabled in the patched APK.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
              <button
                onClick={() =>
                  setDlcDialog({
                    ...dlcDialog,
                    dlcs: dlcDialog.dlcs.map((dlc) => ({ ...dlc, enabled: true })),
                  })
                }
              >
                Select all
              </button>
              <button
                onClick={() =>
                  setDlcDialog({
                    ...dlcDialog,
                    dlcs: dlcDialog.dlcs.map((dlc) => ({ ...dlc, enabled: false })),
                  })
                }
              >
                Clear
              </button>
            </div>
            <div style={{ display: 'grid', gap: '0.35rem' }}>
              {dlcDialog.dlcs.map((dlc) => (
                <label key={dlc.appid} style={{ display: 'flex', gap: '0.5rem' }}>
                  <input
                    type="checkbox"
                    checked={dlc.enabled}
                    onChange={(event) =>
                      setDlcDialog({
                        ...dlcDialog,
                        dlcs: dlcDialog.dlcs.map((item) =>
                          item.appid === dlc.appid
                            ? { ...item, enabled: event.target.checked }
                            : item
                        ),
                      })
                    }
                  />
                  <span>{dlc.name}</span>
                  <span style={{ opacity: 0.5 }}>{dlc.appid}</span>
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
              <button onClick={() => setDlcDialog(null)}>Cancel</button>
              <button onClick={confirmPatch} disabled={busy}>
                Patch with {dlcDialog.dlcs.filter((dlc) => dlc.enabled).length} DLCs
              </button>
            </div>
          </div>
        </div>
      )}

      {log.length > 0 && (
        <pre
          ref={logRef}
          style={{
            marginTop: '1rem',
            maxHeight: '18rem',
            overflow: 'auto',
            background: 'rgba(0,0,0,0.35)',
            padding: '0.75rem',
            borderRadius: '8px',
            fontSize: '0.78rem',
            whiteSpace: 'pre-wrap',
          }}
        >
          {log.join('\n')}
        </pre>
      )}
    </div>
  )
}
