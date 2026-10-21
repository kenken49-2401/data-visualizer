param([string]$OutputPath = '')

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot 'native/chatgpt-launch-watcher.cs'
if (-not $OutputPath) { $OutputPath = Join-Path $repoRoot 'build/chatgpt-launch-watcher.exe' }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$compilerCandidates = @(
  (Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  (Join-Path $env:SystemRoot 'Microsoft.NET/Framework/v4.0.30319/csc.exe')
)
$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) { throw 'Windows .NET Framework C# compiler was not found.' }
$framework = Split-Path -Parent $compiler
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($OutputPath))
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /debug- /warn:4 "/reference:$framework/System.Web.Extensions.dll" "/reference:$framework/System.Security.dll" "/out:$OutputPath" $source
if ($LASTEXITCODE -ne 0) { throw 'ChatGPT launch watcher compilation failed.' }

# A GUI subsystem executable cannot create a console window when started by
# Windows at sign-in. Check the actual PE flags rather than just build options.
$bytes = [IO.File]::ReadAllBytes($OutputPath)
if ($bytes.Length -lt 256 -or $bytes[0] -ne 77 -or $bytes[1] -ne 90) { throw 'Watcher output is not a Windows executable.' }
$peOffset = [BitConverter]::ToInt32($bytes, 60)
if ($peOffset -lt 64 -or $peOffset + 94 -gt $bytes.Length -or [BitConverter]::ToUInt32($bytes, $peOffset) -ne 17744 -or [BitConverter]::ToUInt16($bytes, $peOffset + 4) -ne 34404 -or [BitConverter]::ToUInt16($bytes, $peOffset + 92) -ne 2) { throw 'Watcher must be an x64 Windows GUI executable.' }
Write-Output "Built native ChatGPT launch watcher: $OutputPath"
