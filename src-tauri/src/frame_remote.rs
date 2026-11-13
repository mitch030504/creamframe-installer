// Steam Frame integration commands.
//
// The remote path deliberately delegates to the tested `tools/frame.py` CLI
// bundled with the installer. That keeps APK signing, backup, manifest and
// revert behaviour in one place instead of duplicating it in Rust/JS.

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter, Manager};

fn resource_candidates(app: &AppHandle, name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(name));
        candidates.push(resource_dir.join("resources").join(name));
    }
    // Development-only fallbacks. Release builds must only trust the bundle,
    // otherwise a `resources/` directory next to the AppImage could be used
    // to execute arbitrary helper code.
    #[cfg(debug_assertions)]
    {
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join("resources").join(name));
            candidates.push(cwd.join("src-tauri").join("resources").join(name));
        }
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join(name));
    }
    candidates
}

fn find_resource(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    for candidate in resource_candidates(app, name) {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "installer resource not found: {}. Reinstall CreamFrame Installer or run from a complete checkout.",
        name
    ))
}

fn python_bin() -> String {
    std::env::var("CREAMFRAME_PYTHON").unwrap_or_else(|_| "python3".to_string())
}

fn frame_script(app: &AppHandle) -> Result<PathBuf, String> {
    find_resource(app, "frame.py")
}

#[derive(Serialize)]
pub struct FramePrereqs {
    pub python: bool,
    pub ssh: bool,
    pub rsync: bool,
    pub bundled_java: bool,
    pub bundled_apksigner: bool,
    pub bundled_proxy: bool,
    pub android_ready: bool,
    pub remote_ready: bool,
}

fn command_exists(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths).any(|dir| {
                let candidate = dir.join(name);
                candidate.is_file()
            })
        })
        .unwrap_or(false)
}

#[tauri::command]
pub fn frame_prereqs(app: AppHandle) -> Result<FramePrereqs, String> {
    let python = command_exists("python3") || command_exists("python");
    let ssh = command_exists("ssh");
    let rsync = command_exists("rsync");
    let bundled_java = find_resource(&app, "jdk/bin/java").is_ok()
        || find_resource(&app, "java").is_ok();
    let bundled_apksigner = find_resource(&app, "apksigner.jar").is_ok();
    let bundled_proxy = find_resource(&app, "android/libsteam_api.so").is_ok();
    Ok(FramePrereqs {
        python,
        ssh,
        rsync,
        bundled_java,
        bundled_apksigner,
        bundled_proxy,
        android_ready: python && bundled_java && bundled_apksigner && bundled_proxy,
        remote_ready: python && ssh && rsync,
    })
}

/// Child tools must use the host's libraries. The AppImage sets
/// LD_LIBRARY_PATH/APPDIR for its own WebKit helpers, and leaking that into
/// system Python/ssh/rsync causes OpenSSL and glibc mismatches.
fn sanitize_child_env(command: &mut Command) {
    command.env_remove("LD_LIBRARY_PATH");
    command.env_remove("LD_PRELOAD");
}

#[tauri::command]
pub async fn frame_check(_app: AppHandle, remote: String, local: Option<bool>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = if local.unwrap_or(false) {
            let mut command = Command::new("bash");
            command.args(["-lc", "uname -m; hostname"]);
            command
        } else {
            let mut command = Command::new("ssh");
            command.args([
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=8",
                &remote,
                "uname -m; hostname",
            ]);
            command
        };
        sanitize_child_env(&mut command);
        let output = command
            .output()
            .map_err(|e| format!("failed to run connection check: {}", e))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    })
    .await
    .map_err(|e| format!("frame check task failed: {}", e))?
}

#[tauri::command]
pub async fn frame_scan(app: AppHandle, remote: String, local: Option<bool>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let script = frame_script(&app)?;
        let mut command = Command::new(python_bin());
        command.arg(&script);
        if local.unwrap_or(false) {
            command.args(["--local", "scan", "--json"]);
        } else {
            command.args(["--remote", &remote, "scan", "--json"]);
        }
        sanitize_child_env(&mut command);
        let output = command
            .output()
            .map_err(|e| format!("failed to run frame.py: {}", e))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        serde_json::from_slice(&output.stdout)
            .map_err(|e| format!("frame.py returned invalid JSON: {}", e))
    })
    .await
    .map_err(|e| format!("frame scan task failed: {}", e))?
}

fn emit_line(app: &AppHandle, line: &str) {
    let _ = app.emit("frame-progress", line.to_string());
}

fn apply_frame_env(app: &AppHandle, command: &mut Command) {
    sanitize_child_env(command);
    if let Ok(tools) = find_resource(app, "setup.py") {
        if let Some(dir) = tools.parent() {
            command.env("CREAMFRAME_TOOLS_DIR", dir);
        }
    }
    if let Ok(cream_sh) = find_resource(app, "cream.sh") {
        command.env("CREAMFRAME_CREAM_SH", cream_sh);
    }
    if let Ok(proxy) = find_resource(app, "android/libsteam_api.so") {
        command.env("CREAMFRAME_ANDROID_PROXY", proxy);
    }
    if let Ok(jar) = find_resource(app, "apksigner.jar") {
        command.env("CREAMFRAME_APKSIGNER_JAR", jar);
    }
    if let Ok(java) = find_resource(app, "jdk/bin/java") {
        if let Some(bin) = java.parent() {
            let mut paths = vec![bin.to_path_buf()];
            if let Some(existing) = std::env::var_os("PATH") {
                paths.extend(std::env::split_paths(&existing));
            }
            if let Ok(joined) = std::env::join_paths(paths) {
                command.env("PATH", joined);
            }
        }
        command.env("CREAMFRAME_JAVA", java);
        command.env("CREAMFRAME_NO_ZIPALIGN", "1");
    }
    if let Ok(keytool) = find_resource(app, "jdk/bin/keytool") {
        command.env("CREAMFRAME_KEYTOOL", keytool);
    }
}

fn run_frame_stream(app: &AppHandle, args: &[String]) -> Result<(), String> {
    let script = frame_script(app)?;
    let mut command = Command::new(python_bin());
    command.arg(&script).args(args);
    apply_frame_env(app, &mut command);
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run frame.py: {}", e))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app_out = app.clone();
    let app_err = app.clone();
    let out_thread = stdout.map(|stream| {
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                emit_line(&app_out, &line);
            }
        })
    });
    let err_thread = stderr.map(|stream| {
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                emit_line(&app_err, &line);
            }
        })
    });

    let status = child.wait().map_err(|e| format!("frame.py wait failed: {}", e))?;
    if let Some(thread) = out_thread {
        let _ = thread.join();
    }
    if let Some(thread) = err_thread {
        let _ = thread.join();
    }
    if !status.success() {
        return Err("frame.py exited with an error; see the log for details".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn frame_action(
    app: AppHandle,
    remote: String,
    local: Option<bool>,
    appid: String,
    action: String,
    smokeapi_mode: Option<String>,
    ini_path: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut args = if local.unwrap_or(false) {
            vec!["--local".to_string()]
        } else {
            vec!["--remote".to_string(), remote]
        };
        match action.as_str() {
            "android_patch" => {
                args.extend(["android".into(), "patch".into(), appid]);
                if let Some(ini) = ini_path {
                    args.push("--ini".into());
                    args.push(ini);
                }
            }
            "android_revert" => args.extend(["android".into(), "revert".into(), appid]),
            "android_status" => args.extend(["android".into(), "status".into(), appid]),
            "android_reset" => args.extend(["android".into(), "reset".into(), appid]),
            "native_install" => args.extend(["native".into(), "install".into(), appid]),
            "native_uninstall" => args.extend(["native".into(), "uninstall".into(), appid]),
            "proton_install" => {
                args.extend(["proton".into(), "install".into(), appid]);
                args.push("--smokeapi-mode".into());
                args.push(smokeapi_mode.unwrap_or_else(|| "proxy".to_string()));
            }
            "proton_uninstall" => args.extend(["proton".into(), "uninstall".into(), appid]),
            other => return Err(format!("unknown Frame action: {}", other)),
        }
        run_frame_stream(&app, &args)
    })
    .await
    .map_err(|e| format!("frame action task failed: {}", e))?
}

/// Run the APK patcher locally on the Frame/PC using the bundled JRE and
/// apksigner.jar. The caller has already resolved the game's APK path.
#[tauri::command]
pub async fn frame_android_patch_local(
    app: AppHandle,
    apk_path: String,
    ini_path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let script = find_resource(&app, "apk_patch.py")?;
        let proxy = find_resource(&app, "android/libsteam_api.so")?;
        let jar = find_resource(&app, "apksigner.jar")?;
        let java = find_resource(&app, "jdk/bin/java")?;
        let keytool = find_resource(&app, "jdk/bin/keytool")?;
        let out = format!("{}.cream-new", apk_path);

        let mut command = Command::new(python_bin());
        command
            .arg(&script)
            .args([
                &apk_path,
                "--proxy", proxy.to_string_lossy().as_ref(),
                "--ini", &ini_path,
                "--output", &out,
                "--skip-zipalign",
                "--apksigner-jar", jar.to_string_lossy().as_ref(),
                "--java", java.to_string_lossy().as_ref(),
                "--keytool", keytool.to_string_lossy().as_ref(),
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        sanitize_child_env(&mut command);
        let output = command
            .output()
            .map_err(|e| format!("failed to run apk_patch.py: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("local Android patch failed: {}", e))?
}

#[tauri::command]
pub fn frame_write_ini(
    appid: String,
    dlcs: Vec<(String, String)>,
) -> Result<String, String> {
    let mut text = String::from(
        "[config]\nunlockall = false\nlogging = true\n\n[methods]\ndisable_steamapps_issubscribedapp = false\n\n[dlc]\n",
    );
    for (id, name) in dlcs {
        text.push_str(&format!("{} = {}\n", id, name));
    }
    let path = std::env::temp_dir().join(format!("creamframe-{}.ini", appid));
    std::fs::write(&path, text).map_err(|e| format!("failed to write ini: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

pub fn _resource_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    find_resource(app, name)
}

pub fn _path_exists(path: &Path) -> bool {
    path.exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_env_drops_appimage_library_paths() {
        let mut command = Command::new("sh");
        command.args(["-c", "printf %s \"${LD_LIBRARY_PATH:-unset}\""]);
        command.env("LD_LIBRARY_PATH", "/tmp/appimage/usr/lib");
        command.env("LD_PRELOAD", "/tmp/appimage/usr/lib/libpreload.so");
        sanitize_child_env(&mut command);
        let output = command.output().expect("run sh");
        assert_eq!(String::from_utf8_lossy(&output.stdout), "unset");
    }
}
