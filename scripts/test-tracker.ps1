$ErrorActionPreference = 'Stop'
$source = '$usageOverlayOwnerId = 0' + "`n" + (Get-Content src/windows-tracker.ps1 -Raw)
$script = Join-Path $env:RUNNER_TEMP 'usage-tracker-test.ps1'
Set-Content $script $source -Encoding utf8
$process = [Diagnostics.Process]::new()
$process.StartInfo.FileName = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$process.StartInfo.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`""
$process.StartInfo.UseShellExecute = $false
$process.StartInfo.CreateNoWindow = $true
$process.StartInfo.RedirectStandardOutput = $true
$process.StartInfo.RedirectStandardError = $true
[void]$process.Start()
try {
  for ($i = 0; $i -lt 3; $i++) {
    $line = $process.StandardOutput.ReadLineAsync()
    if (-not $line.Wait(30000) -or -not $line.Result) { throw 'Tracker did not return a heartbeat' }
    $sample = $line.Result | ConvertFrom-Json
    if ($sample.present -or $sample.active -or $sample.menuOpen) { throw 'Tracker unexpectedly found ChatGPT on CI' }
  }
  Write-Output 'Windows native and UI Automation helper starts and emits inactive heartbeats'
} finally {
  if (-not $process.HasExited) { $process.Kill() }
  $process.WaitForExit()
  $errors = $process.StandardError.ReadToEnd()
  if ($errors) { throw $errors }
  $process.Dispose()
}
