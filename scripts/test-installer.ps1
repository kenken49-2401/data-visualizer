$ErrorActionPreference = 'Stop'
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$installer = (Resolve-Path "dist/Codex-Usage-Overlay-Setup-$version.exe").Path
$directory = Join-Path $env:RUNNER_TEMP "usage-installed"
$runtime = Join-Path $env:RUNNER_TEMP "usage-installer-smoke"
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
$codex = Get-ChildItem $directory -Filter codex.exe -Recurse | Select-Object -First 1
if (-not $codex) { throw 'Bundled native Codex executable missing' }
& $codex.FullName --version
if ($LASTEXITCODE -ne 0) { throw 'Bundled Codex executable failed' }
$shortcut = Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs/Codex Usage Overlay.lnk'
if (-not (Test-Path $shortcut)) { throw 'Start menu shortcut missing' }
# Check that Windows classifies the installed main executable as a GUI application.
$bytes = [IO.File]::ReadAllBytes($executable)
$header = [BitConverter]::ToInt32($bytes, 0x3c)
if ([BitConverter]::ToUInt16($bytes, $header + 24 + 68) -ne 2) { throw 'Unexpected console executable' }
Write-Output 'NSIS installation, GUI launch, menu shortcut and bundled Codex passed'
$uninstaller = Get-ChildItem $directory -Filter 'Uninstall*.exe' | Select-Object -First 1
$process = Start-Process $uninstaller.FullName -ArgumentList '/S' -PassThru
if (-not $process.WaitForExit(60000)) { throw 'Uninstall timeout' }
if (-not (Test-Path (Join-Path $runtime 'settings.json'))) { throw 'Uninstall removed user settings' }
