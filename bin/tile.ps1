# Tiles Align's terminal windows edge to edge: agents side by side on top, coordination log below.
# Usage: tile.ps1 "<left title>" "<right title>" "<bottom title>" [bottomShare]
param([string]$Left, [string]$Right, [string]$Bottom, [double]$BottomShare = 0.28)

Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class AlignTile {
  public delegate bool P(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(P f, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
}
"@
# Work in physical pixels throughout, so window rects, DWM frames and the screen area agree under display scaling.
[void][AlignTile]::SetProcessDpiAwarenessContext([IntPtr]-4)
Add-Type -AssemblyName System.Windows.Forms
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$half = [int][Math]::Floor($area.Width / 2)
$top = [int][Math]::Round($area.Height * (1 - $BottomShare))
$global:places = @{}
$global:places[$Left] = @($area.X, $area.Y, $half, $top)
$global:places[$Right] = @(($area.X + $half), $area.Y, ($area.Width - $half), $top)
if ($Bottom) { $global:places[$Bottom] = @($area.X, ($area.Y + $top), $area.Width, ($area.Height - $top)) }

[AlignTile]::EnumWindows({ param($h, $l)
  if ([AlignTile]::IsWindowVisible($h)) {
    $t = New-Object Text.StringBuilder 256; [void][AlignTile]::GetWindowText($h, $t, 256)
    $p = $global:places[$t.ToString()]
    if ($p) {
      [void][AlignTile]::ShowWindow($h, 9)  # restore if maximized or minimized
      # The visible frame is smaller than the window rect by an invisible resize border; compensate so frames meet exactly.
      $r = New-Object AlignTile+RECT; $f = New-Object AlignTile+RECT
      [void][AlignTile]::SetWindowPos($h, [IntPtr]::Zero, $p[0], $p[1], $p[2], $p[3], 0x0040)
      [void][AlignTile]::GetWindowRect($h, [ref]$r)
      if ([AlignTile]::DwmGetWindowAttribute($h, 9, [ref]$f, 16) -eq 0) {
        $l = $f.L - $r.L; $tp = $f.T - $r.T; $rt = $r.R - $f.R; $b = $r.B - $f.B
        [void][AlignTile]::SetWindowPos($h, [IntPtr]::Zero, ($p[0] - $l), ($p[1] - $tp), ($p[2] + $l + $rt), ($p[3] + $tp + $b), 0x0040)
      }
    }
  }
  $true }, [IntPtr]::Zero) | Out-Null
