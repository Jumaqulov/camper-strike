# Persistent Win32 focus helper for the production smoke harness (stdin/stdout line protocol).
#   FG <pid>  -> bring the top-level window of <pid> to the foreground (ALT-key unlock trick)
#   KEY <vk>  -> OS-level key press (keybd_event) into the current foreground window
#   Q         -> "<foregroundPid> <lastInputTick> <tickNow>"  (GetLastInputInfo: physical/OS input only)
# Desktop focus only: it never touches game state.
Add-Type @"
using System; using System.Runtime.InteropServices;
public class QaW {
  [StructLayout(LayoutKind.Sequential)] public struct LII { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LII p);
  public static uint LastInput() { LII l = new LII(); l.cbSize = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l); return l.dwTime; }
  public static uint FgPid() { uint p; GetWindowThreadProcessId(GetForegroundWindow(), out p); return p; }
}
"@
[Console]::Out.WriteLine("READY"); [Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $parts = $line.Trim().Split(' ')
  try {
    if ($parts[0] -eq 'FG') {
      $proc = Get-Process -Id ([int]$parts[1]) -ErrorAction Stop
      $h = $proc.MainWindowHandle
      if ($h -eq [IntPtr]::Zero) { [Console]::Out.WriteLine("ERR nowindow") }
      else {
        [QaW]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
        [QaW]::ShowWindow($h, 9) | Out-Null
        [QaW]::BringWindowToTop($h) | Out-Null
        $ok = [QaW]::SetForegroundWindow($h)
        [QaW]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
        [Console]::Out.WriteLine("OK $ok $([QaW]::FgPid()) $([QaW]::LastInput()) $([Environment]::TickCount)")
      }
    } elseif ($parts[0] -eq 'KEY') {
      # OS-level key press into the foreground window (Chrome only releases pointer lock on a real Esc)
      $vk = [byte]([int]$parts[1])
      [QaW]::keybd_event($vk, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [QaW]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
      [Console]::Out.WriteLine("OK $([QaW]::FgPid())")
    } elseif ($parts[0] -eq 'Q') {
      [Console]::Out.WriteLine("Q $([QaW]::FgPid()) $([QaW]::LastInput()) $([Environment]::TickCount)")
    } else { [Console]::Out.WriteLine("ERR unknown") }
  } catch { [Console]::Out.WriteLine("ERR $($_.Exception.Message)") }
  [Console]::Out.Flush()
}
