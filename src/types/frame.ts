export type FrameMode = 'remote' | 'local'

export type FrameAction =
  | 'android_patch'
  | 'android_revert'
  | 'android_status'
  | 'android_reset'
  | 'native_install'
  | 'native_uninstall'
  | 'proton_install'
  | 'proton_uninstall'

export interface FramePatchInfo {
  dlc_count?: number
  dlc_ids?: string[]
  original_sha256?: string
  patched_sha256?: string
  created?: string
  proxy?: string
}

export interface FrameGame {
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
  patch_info: FramePatchInfo | null
  native_lib: string | null
  proton_dll: string | null
  cream_installed?: boolean
  smoke_installed?: boolean
  smoke_overwritten?: boolean
}

export interface FrameScan {
  steam: string
  libraries: string[]
  games: FrameGame[]
}

export interface FramePrereqs {
  python: boolean
  ssh: boolean
  rsync: boolean
  bundled_java: boolean
  bundled_apksigner: boolean
  bundled_proxy: boolean
  android_ready: boolean
  remote_ready: boolean
}

export interface FrameScanSnapshot {
  scan: FrameScan
  mode: FrameMode
  remote: string
  at: number
}

export interface FrameDlc {
  appid: string
  name: string
}

export interface FramePendingAction {
  appid: string
  action: FrameAction
}
