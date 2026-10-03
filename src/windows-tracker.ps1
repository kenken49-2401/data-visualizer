# This helper reads window bounds only. It never reads a conversation or credentials.
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class UsageWindows {
    public delegate bool EnumCallback(IntPtr hwnd, IntPtr context);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback callback, IntPtr context);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out Rect rect, int size);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
}
'@
# Match physical DWM coordinates to Electron's explicit physical-to-DIP conversion.
[void][UsageWindows]::SetProcessDpiAwarenessContext([IntPtr](-4))
$script:chosen = [IntPtr]::Zero
$previous = ''
while ($true) {
    $script:targets = [System.Collections.Generic.List[IntPtr]]::new()
    $callback = [UsageWindows+EnumCallback] {
        param($handle, $context)
        if ([UsageWindows]::IsWindowVisible($handle)) {
            [uint32]$ownerId = 0
            [void][UsageWindows]::GetWindowThreadProcessId($handle, [ref]$ownerId)
            try {
                $owner = Get-Process -Id $ownerId -ErrorAction Stop
                if ($owner.ProcessName -match '^(ChatGPT|Codex)$') { $script:targets.Add($handle) }
            } catch { }
        }
        return $true
    }
    [void][UsageWindows]::EnumWindows($callback, [IntPtr]::Zero)
    $foreground = [UsageWindows]::GetForegroundWindow()
    if ($script:targets.Contains($foreground)) { $script:chosen = $foreground }
    elseif (-not $script:targets.Contains($script:chosen)) {
        $script:chosen = if ($script:targets.Count -gt 0) { $script:targets[0] } else { [IntPtr]::Zero }
    }
    $payload = @{ present = $false; active = $false; minimized = $false }
    if ($script:chosen -ne [IntPtr]::Zero) {
        $rect = [UsageWindows+Rect]::new()
        $valid = [UsageWindows]::DwmGetWindowAttribute($script:chosen, 9, [ref]$rect, 16) -eq 0
        if (-not $valid) { $valid = [UsageWindows]::GetWindowRect($script:chosen, [ref]$rect) }
        if ($valid -and $rect.Right -gt $rect.Left -and $rect.Bottom -gt $rect.Top) {
            $payload = @{ present = $true; active = ($foreground -eq $script:chosen);
                minimized = [UsageWindows]::IsIconic($script:chosen);
                x = $rect.Left; y = $rect.Top; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top }
        }
    }
    $json = ConvertTo-Json -InputObject $payload -Compress
    if ($json -ne $previous) { [Console]::Out.WriteLine($json); [Console]::Out.Flush(); $previous = $json }
    Start-Sleep -Milliseconds 500
}
