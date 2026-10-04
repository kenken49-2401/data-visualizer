$ErrorActionPreference = 'Stop'
$source = "`$ProgressPreference = 'SilentlyContinue'`n`$usageOverlayOwnerId = 0" + "`n" + (Get-Content src/windows-tracker.ps1 -Raw)
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($source))
$process = [Diagnostics.Process]::new()
$process.StartInfo.FileName = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$process.StartInfo.Arguments = "-NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand $encoded"
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
    if ($sample.present -or $sample.active) { throw 'Tracker unexpectedly found ChatGPT on CI' }
  }
  Write-Output 'Windows encoded-command helper starts and emits inactive heartbeats'
} finally {
  if (-not $process.HasExited) { $process.Kill() }
  $process.WaitForExit()
  $errors = $process.StandardError.ReadToEnd()
  if ($errors) { Write-Output ('::error title=Tracker stderr::' + ($errors -replace '%', '%25' -replace "`r", '%0D' -replace "`n", '%0A')); throw $errors }
  $process.Dispose()
}
