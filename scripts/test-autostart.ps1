[CmdletBinding()]
param([string]$WatcherPath = (Join-Path $PSScriptRoot '../build/chatgpt-launch-watcher.exe'))

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'The native auto-start integration test requires Windows' }
$watcher = (Resolve-Path $WatcherPath).Path
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path $compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe' }
if (-not (Test-Path $compiler)) { throw 'The .NET Framework C# compiler is missing' }
$sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
if (Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue | Where-Object SessionId -eq $sessionId) {
  throw 'This test needs an isolated Windows session without a real ChatGPT process'
}
$temporaryRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$directory = Join-Path $temporaryRoot ('codex watcher test ' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory | Out-Null
$chatgpt = Join-Path $directory 'ChatGPT.exe'
$overlay = Join-Path $directory 'Overlay Fixture.exe'
$config = Join-Path $directory 'watcher settings.json'
$log = Join-Path $directory 'launches.txt'
$originalLog = $env:CODEX_AUTOSTART_TEST_LOG
$env:CODEX_AUTOSTART_TEST_LOG = $log
$owned = [Collections.Generic.List[Diagnostics.Process]]::new()

function Start-Fixture([string]$Executable, [string]$Arguments = '') {
  $process = [Diagnostics.Process]::new()
  $process.StartInfo.FileName = $Executable
  $process.StartInfo.Arguments = $Arguments
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.CreateNoWindow = $true
  [void]$process.Start()
  $owned.Add($process)
  return $process
}
function Stop-Fixture([Diagnostics.Process]$Process) {
  if ($Process -and -not $Process.HasExited) { $Process.Kill(); [void]$Process.WaitForExit(5000) }
}
function Wait-Condition([scriptblock]$Condition, [string]$Message, [int]$Timeout = 12000) {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  do {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 100
  } while ($timer.ElapsedMilliseconds -lt $Timeout)
  throw $Message
}
function Read-Launches {
  if (-not [IO.File]::Exists($log)) { return @() }
  $stream = [IO.File]::Open($log, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  $reader = [IO.StreamReader]::new($stream)
  try { while ($null -ne ($line = $reader.ReadLine())) { $line } }
  finally { $reader.Dispose() }
}
function Launch-Count { return @(Read-Launches).Count }
function Assert-NoLaunch([int]$Expected, [int]$Milliseconds, [string]$Message) {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  do {
    if ((Launch-Count) -ne $Expected) { throw $Message }
    Start-Sleep -Milliseconds 100
  } while ($timer.ElapsedMilliseconds -lt $Milliseconds)
}
function Save-Config([bool]$Enabled, [string]$Application = $overlay) {
  # Rename a complete document so the real watcher observes a normal settings
  # replacement, rather than a partially written test file.
  $text = @{ schema = 1; enabled = $Enabled; appPath = $Application } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($config + '.tmp', $text, [Text.UTF8Encoding]::new($false))
  Move-Item -Force ($config + '.tmp') $config
}
function Start-Watcher {
  return Start-Fixture $watcher ('--config "' + $config + '"')
}
function Wait-Visible([Diagnostics.Process]$Process) {
  Wait-Condition { $Process.Refresh(); -not $Process.HasExited -and $Process.MainWindowHandle -ne [IntPtr]::Zero } 'Synthetic ChatGPT did not create a visible native window'
}
function Stop-Overlay {
  # This exact executable exists only in this test's random temporary directory.
  # Do not stop unrelated overlay installations or processes with the same name.
  Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
    try { if ([StringComparer]::OrdinalIgnoreCase.Equals($_.Path, $overlay)) { Stop-Fixture $_ } } catch { }
  }
}
function Wait-Exit([Diagnostics.Process]$Process, [string]$Message) {
  if (-not $Process.WaitForExit(10000)) { throw $Message }
  if ($Process.ExitCode -ne 0) { throw ($Message + ': exit ' + $Process.ExitCode) }
}

try {
  $guiSource = @'
using System;
using System.Windows.Forms;
internal static class ChatGPTFixture {
  [STAThread] private static void Main(string[] args) {
    Application.EnableVisualStyles();
    if (args.Length > 0 && args[0] == "--hidden") { Application.Run(); return; }
    Form window = new Form();
    window.Text = "ChatGPT auto-start integration fixture";
    window.Width = 460; window.Height = 180;
    Application.Run(window);
  }
}
'@
  $overlaySource = @'
using System;
using System.IO;
using System.Windows.Forms;
internal static class OverlayFixture {
  [STAThread] private static void Main(string[] args) {
    string file = Environment.GetEnvironmentVariable("CODEX_AUTOSTART_TEST_LOG");
    if (String.IsNullOrEmpty(file)) return;
    File.AppendAllText(file, String.Join(" ", args) + Environment.NewLine);
    Application.Run();
  }
}
'@
  $guiFile = Join-Path $directory 'chatgpt-fixture.cs'
  $overlayFile = Join-Path $directory 'overlay-fixture.cs'
  [IO.File]::WriteAllText($guiFile, $guiSource)
  [IO.File]::WriteAllText($overlayFile, $overlaySource)
  & $compiler /nologo /target:winexe /platform:x64 /reference:System.Windows.Forms.dll ("/out:$chatgpt") $guiFile
  if ($LASTEXITCODE -ne 0) { throw 'Synthetic ChatGPT compilation failed' }
  & $compiler /nologo /target:winexe /platform:x64 /reference:System.Windows.Forms.dll ("/out:$overlay") $overlayFile
  if ($LASTEXITCODE -ne 0) { throw 'Synthetic overlay compilation failed' }
  $bytes = [IO.File]::ReadAllBytes($watcher)
  $header = [BitConverter]::ToInt32($bytes, 0x3c)
  if ([BitConverter]::ToUInt16($bytes, $header + 24 + 68) -ne 2) { throw 'Watcher must be a native GUI executable without a console subsystem' }

  Save-Config $true
  $first = Start-Watcher
  Assert-NoLaunch 0 2200 'Watcher launched an overlay without ChatGPT'
  if ($first.HasExited) { throw 'Enabled watcher exited before a ChatGPT window appeared' }
  $duplicate = Start-Watcher
  Wait-Exit $duplicate 'Duplicate watcher must exit quietly'
  if ($first.HasExited) { throw 'Duplicate invocation stopped the original watcher' }
  $hidden = Start-Fixture $chatgpt '--hidden'
  Assert-NoLaunch 0 2300 'A windowless ChatGPT process incorrectly triggered auto-start'
  Stop-Fixture $hidden
  Write-Output 'Auto-start: absent and windowless ChatGPT ignored; duplicate helper exits'

  $chat = Start-Fixture $chatgpt
  Wait-Visible $chat
  Wait-Condition { (Launch-Count) -eq 1 } 'Visible ChatGPT did not launch the overlay'
  if (@(Read-Launches)[0] -ne '--chatgpt-autostart') { throw 'Watcher supplied unexpected application arguments' }
  Assert-NoLaunch 1 2300 'Watcher launched a second overlay while the first was running'
  Stop-Overlay
  Assert-NoLaunch 1 3300 'Watcher respawned the overlay after the user closed it during the same ChatGPT cycle'
  Stop-Fixture $chat
  Start-Sleep -Milliseconds 3300
  Write-Output 'Auto-start: visible window launches once; manual quit stays respected'

  $manual = Start-Fixture $overlay '--fixture-manual'
  Wait-Condition { (Launch-Count) -eq 2 } 'Manually started overlay fixture did not initialize'
  $chat = Start-Fixture $chatgpt
  Wait-Visible $chat
  Assert-NoLaunch 2 2300 'An already running exact application was launched again'
  Stop-Fixture $manual
  Assert-NoLaunch 2 2300 'Watcher relaunched an application that was already open at the start of this cycle'
  Stop-Fixture $chat
  Start-Sleep -Milliseconds 3300
  $chat = Start-Fixture $chatgpt
  Wait-Visible $chat
  Wait-Condition { (Launch-Count) -eq 3 } 'Closing all ChatGPT windows and reopening did not begin a new launch cycle'
  if (@(Read-Launches)[2] -ne '--chatgpt-autostart') { throw 'Reopened ChatGPT did not use auto-start arguments' }
  Write-Output 'Auto-start: existing application suppressed; closing and reopening ChatGPT resets the cycle'

  Save-Config $false
  Wait-Exit $first 'Disabling auto-start did not stop the watcher'
  Stop-Fixture $chat
  Stop-Overlay
  $disabled = Start-Watcher
  Wait-Exit $disabled 'A disabled configuration must exit quietly'
  Save-Config $true
  $stoppable = Start-Watcher
  Start-Sleep -Milliseconds 1200
  if ($stoppable.HasExited) { throw 'Watcher exited before the stop-command test' }
  $stop = Start-Fixture $watcher '--stop'
  Wait-Exit $stop 'The stop command did not return'
  Wait-Exit $stoppable 'The stop command did not terminate the watcher'

  # During an update the new staged hash must stop and fully release the old
  # hash before its executable can be replaced or removed on Windows.
  $oldHash = Join-Path $directory 'watcher-1111111111111111.exe'
  $newHash = Join-Path $directory 'watcher-2222222222222222.exe'
  Copy-Item -LiteralPath $watcher -Destination $oldHash
  Copy-Item -LiteralPath $watcher -Destination $newHash
  $oldWatcher = Start-Fixture $oldHash ('--config "' + $config + '"')
  Start-Sleep -Milliseconds 1200
  if ($oldWatcher.HasExited) { throw 'The old staged helper exited before the migration-stop test' }
  $migrationStop = Start-Fixture $newHash '--stop'
  Wait-Exit $migrationStop 'A new staged helper could not stop the old staged hash'
  $oldWatcher.Refresh()
  if (-not $oldWatcher.HasExited) { throw 'The stop command returned before the old staged process fully exited' }
  if ($oldWatcher.ExitCode -ne 0) { throw 'The old staged helper failed during migration shutdown' }

  # NSIS briefly removes the installed executable while replacing it. A helper
  # that already validated this installation must survive that gap, without
  # consuming a launch attempt or forgetting the current ChatGPT window cycle.
  Save-Config $true
  $updating = Start-Watcher
  Start-Sleep -Milliseconds 1200
  if ($updating.HasExited) { throw 'Watcher exited before the application-update test' }
  $replacement = $overlay + '.updating'
  Move-Item -LiteralPath $overlay -Destination $replacement
  Assert-NoLaunch 3 3300 'Watcher launched an application while its executable was being replaced'
  if ($updating.HasExited) { throw 'A temporary missing executable stopped an already valid watcher' }
  $chat = Start-Fixture $chatgpt
  Wait-Visible $chat
  Assert-NoLaunch 3 2300 'Watcher attempted to launch the missing executable'
  if ($updating.HasExited) { throw 'The update grace period ended while ChatGPT was open' }
  Stop-Fixture $chat
  Start-Sleep -Milliseconds 3300
  $chat = Start-Fixture $chatgpt
  Wait-Visible $chat
  Assert-NoLaunch 3 1300 'Reopening ChatGPT launched an executable that was still missing'
  Move-Item -LiteralPath $replacement -Destination $overlay
  Wait-Condition { (Launch-Count) -eq 4 } 'Restoring the executable did not launch the current unhandled ChatGPT cycle'
  if (@(Read-Launches)[3] -ne '--chatgpt-autostart') { throw 'The restored executable received incorrect arguments' }
  Stop-Overlay
  Move-Item -LiteralPath $overlay -Destination $replacement
  Assert-NoLaunch 4 2200 'A handled cycle launched while the executable was missing again'
  if ($updating.HasExited) { throw 'A second temporary update gap stopped the watcher' }
  Move-Item -LiteralPath $replacement -Destination $overlay
  Assert-NoLaunch 4 2300 'Restoring an executable forgot the user quit during an already handled cycle'
  Stop-Fixture $chat
  Start-Sleep -Milliseconds 3300
  $chat = Start-Fixture $chatgpt
  Wait-Visible $chat
  Wait-Condition { (Launch-Count) -eq 5 } 'The watcher did not launch a fresh ChatGPT cycle after an application update'
  Stop-Fixture $chat
  Stop-Overlay
  $updateStop = Start-Fixture $watcher '--stop'
  Wait-Exit $updateStop 'The update-surviving watcher could not be stopped'
  Wait-Exit $updating 'The update-surviving watcher did not exit'
  Write-Output 'Auto-start: temporary replacement survives; restore launches only an unhandled cycle and preserves manual quit'

  Save-Config $true (Join-Path $directory 'missing application.exe')
  $missing = Start-Watcher
  Wait-Exit $missing 'A missing application must not leave a watcher running'
  if ((Launch-Count) -ne 5) { throw 'Disabling, stopping or an initially missing executable unexpectedly launched an application' }
  Write-Output 'Windows auto-start integration passed: GUI subsystem, visible windows, duplicate prevention, manual quit, reopen, disable, stop, staged helper migration and executable replacement'
} finally {
  # Stop the watcher and all directly owned processes before finding its child,
  # so a failing assertion cannot race one final auto-launch during cleanup.
  foreach ($process in $owned) {
    try { Stop-Fixture $process; $process.Dispose() } catch { }
  }
  Stop-Overlay
  if ($null -eq $originalLog) { Remove-Item Env:CODEX_AUTOSTART_TEST_LOG -ErrorAction SilentlyContinue }
  else { $env:CODEX_AUTOSTART_TEST_LOG = $originalLog }
  Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue
}
