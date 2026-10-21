$ErrorActionPreference = 'Stop'
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$installer = (Resolve-Path "dist/Codex-Usage-Overlay-Setup-$version.exe").Path
$directory = Join-Path $env:RUNNER_TEMP "usage-installed"
$runtime = Join-Path $env:RUNNER_TEMP "usage-installer-smoke"
$actualUserData = Join-Path $env:APPDATA 'codex-usage-overlay'
$autostartDirectory = Join-Path $actualUserData 'autostart'
$runValue = 'CodexUsageOverlayChatGPTLauncher'
$registryPaths = @(
    'Software\Microsoft\Windows\CurrentVersion\Run',
    'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run',
    'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32'
)
$registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
function Test-OwnStartupRegistration {
    foreach ($path in $registryPaths) {
        $key = $registry.OpenSubKey($path)
        try { if ($key -and $key.GetValueNames() -contains $runValue) { return $true } }
        finally { if ($key) { $key.Dispose() } }
    }
    return $false
}
function Assert-GuiExecutable([string]$path) {
    $bytes = [IO.File]::ReadAllBytes($path)
    $header = [BitConverter]::ToInt32($bytes, 0x3c)
    if ([BitConverter]::ToUInt16($bytes, $header + 24 + 68) -ne 2) { throw "Unexpected console executable: $path" }
}
# Refuse to replace a user's existing startup data if this CI script is run elsewhere.
if ((Test-Path $autostartDirectory) -or (Test-OwnStartupRegistration)) { throw 'Autostart test requires no existing watcher registration' }
New-Item -ItemType Directory -Force $runtime | Out-Null
$process = Start-Process $installer -ArgumentList @('/S', "/D=$directory") -PassThru
if (-not $process.WaitForExit(120000)) { $process.Kill(); throw 'Installer timeout' }
if ($process.ExitCode -ne 0) { throw 'Installer failed' }
$executable = Join-Path $directory 'Codex Usage Overlay.exe'
if (-not (Test-Path $executable)) { throw 'Installed executable missing' }
$env:CODEX_USAGE_RUNTIME_DIR = $runtime
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$process = Start-Process $executable -ArgumentList @('--demo', '--smoke') -PassThru
if (-not $process.WaitForExit(60000)) { $process.Kill(); throw 'Installed app timeout' }
$result = Get-Content (Join-Path $runtime 'smoke-result.json') -Raw | ConvertFrom-Json
if ($process.ExitCode -ne 0 -or -not $result.passed -or $result.version -ne $version) { throw 'Installed renderer smoke failed' }
if ((Test-Path $autostartDirectory) -or (Test-OwnStartupRegistration)) { throw 'Demo/smoke unexpectedly enabled autostart' }
$codex = Get-ChildItem $directory -Filter codex.exe -Recurse | Select-Object -First 1
if (-not $codex) { throw 'Bundled native Codex executable missing' }
& $codex.FullName --version
if ($LASTEXITCODE -ne 0) { throw 'Bundled Codex executable failed' }
$shortcut = Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs/Codex Usage Overlay.lnk'
if (-not (Test-Path $shortcut)) { throw 'Start menu shortcut missing' }
Assert-GuiExecutable $executable
$bundledWatcher = Join-Path $directory 'resources/chatgpt-launch-watcher.exe'
if (-not (Test-Path $bundledWatcher)) { throw 'Bundled ChatGPT launcher missing' }
Assert-GuiExecutable $bundledWatcher
Write-Output 'NSIS installation, GUI launch, menu shortcut and bundled native executables passed'

# NSIS uses the real per-user APPDATA, independent of the Electron smoke override.
# Seed only this test's startup files and preserve unrelated settings/history.
$createdAutostart = $false
$createdSettings = $false
$preserveSettings = Join-Path $actualUserData 'settings.json'
$preserveHistoryDirectory = Join-Path $actualUserData ('history/installer-preserve-' + [guid]::NewGuid().ToString('N'))
$preserveHistory = Join-Path $preserveHistoryDirectory '2026-10-21.json'
$sentinel = [guid]::NewGuid().ToString('N')
$liveWatcher = $null
try {
    New-Item -ItemType Directory -Force $autostartDirectory | Out-Null
    $createdAutostart = $true
    $copiedWatcher = Join-Path $autostartDirectory 'watcher-0123456789abcdef.exe'
    Copy-Item $bundledWatcher $copiedWatcher
    $watcherConfig = Join-Path $autostartDirectory 'config.json'
    @{ schema = 1; enabled = $false; appPath = $executable; args = @() } | ConvertTo-Json -Compress | Set-Content $watcherConfig -Encoding utf8NoBOM
    $watcherProcess = Start-Process $copiedWatcher -ArgumentList @('--config', ('"{0}"' -f $watcherConfig)) -PassThru
    if (-not $watcherProcess.WaitForExit(15000)) { $watcherProcess.Kill(); throw 'Disabled watcher did not exit' }
    if ($watcherProcess.ExitCode -ne 0) { throw 'Disabled watcher failed' }
    $watcherProcess = Start-Process $copiedWatcher -ArgumentList '--stop' -PassThru
    if (-not $watcherProcess.WaitForExit(15000)) { $watcherProcess.Kill(); throw 'Watcher stop timed out' }
    if ($watcherProcess.ExitCode -ne 0) { throw 'Watcher stop failed' }

    foreach ($path in $registryPaths) {
        $key = $registry.CreateSubKey($path)
        try {
            if ($path -eq $registryPaths[0]) {
                $key.SetValue($runValue, ('"{0}" --config "{1}"' -f $copiedWatcher, $watcherConfig), [Microsoft.Win32.RegistryValueKind]::String)
            } else {
                $key.SetValue($runValue, [byte[]]@(2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), [Microsoft.Win32.RegistryValueKind]::Binary)
            }
        } finally { $key.Dispose() }
    }
    if (-not (Test-Path $preserveSettings)) {
        @{ installerPreserve = $sentinel } | ConvertTo-Json -Compress | Set-Content $preserveSettings -Encoding utf8NoBOM
        $createdSettings = $true
    }
    $settingsHash = (Get-FileHash $preserveSettings -Algorithm SHA256).Hash
    New-Item -ItemType Directory $preserveHistoryDirectory | Out-Null
    Set-Content $preserveHistory $sentinel -Encoding utf8NoBOM
    $historyHash = (Get-FileHash $preserveHistory -Algorithm SHA256).Hash

    # Exercise the same silent, non-restarting path used by updates on normal
    # quit. No ChatGPT fixture remains, so the watcher cannot launch an account.
    $sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    if (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object SessionId -eq $sessionId) { throw 'Update fixture must not run beside ChatGPT' }
    @{ schema = 1; enabled = $true; appPath = $executable } | ConvertTo-Json -Compress | Set-Content $watcherConfig -Encoding utf8NoBOM
    $configHash = (Get-FileHash $watcherConfig -Algorithm SHA256).Hash
    $registrationBeforeUpdate = @{}
    foreach ($path in $registryPaths) {
        $key = $registry.OpenSubKey($path)
        try { $registrationBeforeUpdate[$path] = $key.GetValue($runValue) | ConvertTo-Json -Compress }
        finally { $key.Dispose() }
    }
    $liveWatcher = Start-Process $copiedWatcher -ArgumentList @('--config', ('"{0}"' -f $watcherConfig)) -PassThru
    Start-Sleep -Milliseconds 1200
    if ($liveWatcher.HasExited) { throw 'Update fixture watcher did not remain running' }

    # The assisted NSIS installer starts Electron in silent mode only with
    # --force-run. Deliberately omit that flag to avoid any live Codex services.
    $process = Start-Process $installer -ArgumentList @('/S', '--updated', "/D=$directory") -PassThru
    $updateDeadline = [DateTime]::UtcNow.AddSeconds(120)
    while (-not $process.WaitForExit(1000)) {
        if ([DateTime]::UtcNow -gt $updateDeadline) { $process.Kill(); throw 'Silent update timeout' }
    }
    if ($process.ExitCode -ne 0) { throw 'Silent update failed' }
    if (-not (Test-Path $executable)) { throw 'Silent update removed the installed application' }
    if ($liveWatcher.HasExited) { throw 'Silent update stopped the independently staged watcher' }
    if (-not (Test-Path $watcherConfig) -or (Get-FileHash $watcherConfig -Algorithm SHA256).Hash -ne $configHash) { throw 'Silent update changed the watcher configuration' }
    foreach ($path in $registryPaths) {
        $key = $registry.OpenSubKey($path)
        try {
            if (-not $key -or $key.GetValueNames() -notcontains $runValue) { throw 'Silent update removed startup registration' }
            if (($key.GetValue($runValue) | ConvertTo-Json -Compress) -ne $registrationBeforeUpdate[$path]) { throw 'Silent update changed startup registration' }
        } finally { if ($key) { $key.Dispose() } }
    }
    if ((Get-FileHash $preserveSettings -Algorithm SHA256).Hash -ne $settingsHash -or (Get-FileHash $preserveHistory -Algorithm SHA256).Hash -ne $historyHash) { throw 'Silent update changed saved settings/history' }
    $unexpectedOverlay = Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($executable)) -ErrorAction SilentlyContinue | Where-Object {
        try { [StringComparer]::OrdinalIgnoreCase.Equals($_.Path, $executable) } catch { $false }
    }
    if ($unexpectedOverlay) { throw 'Silent update unexpectedly launched the real application' }
    Write-Output 'Silent NSIS update preserved the running watcher, startup registration, settings and history without launching Electron'

    $uninstaller = Get-ChildItem $directory -Filter 'Uninstall*.exe' | Select-Object -First 1
    $process = Start-Process $uninstaller.FullName -ArgumentList '/S' -PassThru
    if (-not $process.WaitForExit(60000)) { throw 'Uninstall timeout' }
    if ($process.ExitCode -ne 0) { throw 'Uninstaller failed' }
    # NSIS can run its actual uninstaller from a temporary child executable.
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ((Test-Path $executable) -or (Test-Path $autostartDirectory) -or (Test-OwnStartupRegistration)) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Uninstall did not remove application and startup files/registration' }
        Start-Sleep -Milliseconds 100
    }
    if (-not $liveWatcher.WaitForExit(5000)) { throw 'Full uninstall left the copied watcher running' }
    if (-not (Test-Path (Join-Path $runtime 'settings.json'))) { throw 'Uninstall removed smoke user settings' }
    if (-not (Test-Path $preserveSettings) -or (Get-FileHash $preserveSettings -Algorithm SHA256).Hash -ne $settingsHash) { throw 'Uninstall changed saved user settings' }
    if (-not (Test-Path $preserveHistory) -or (Get-FileHash $preserveHistory -Algorithm SHA256).Hash -ne $historyHash) { throw 'Uninstall changed saved history' }
    Write-Output 'Uninstall removed only own startup registration/files and preserved settings/history'
} finally {
    # This exact process was started by this test; never stop unknown watchers.
    if ($liveWatcher) {
        if (-not $liveWatcher.HasExited) { $liveWatcher.Kill(); [void]$liveWatcher.WaitForExit(5000) }
        $liveWatcher.Dispose()
    }
    # These exact entries and paths were absent before this test created them.
    foreach ($path in $registryPaths) {
        $key = $registry.OpenSubKey($path, $true)
        try { if ($key) { $key.DeleteValue($runValue, $false) } }
        finally { if ($key) { $key.Dispose() } }
    }
    if ($createdAutostart -and (Test-Path $autostartDirectory)) { Remove-Item $autostartDirectory -Recurse -Force }
    if ($createdSettings -and (Test-Path $preserveSettings)) { Remove-Item $preserveSettings -Force }
    if (Test-Path $preserveHistoryDirectory) { Remove-Item $preserveHistoryDirectory -Recurse -Force }
    $registry.Dispose()
}
