// Windows only: keep Follow mode's processes out of power throttling ("EcoQoS") while it listens.
// On battery, Windows slows down processes whose windows are in the background (the operator is
// usually looking at OBS or slides). For live speech that means late or missing audio, so while
// Follow mode is on we opt out, the way real-time audio apps do (SetProcessInformation with
// ProcessPowerThrottling), and give the decision back to Windows when it stops.
const { spawn } = require('child_process');

const CS = `
using System; using System.Runtime.InteropServices;
public static class GpQos {
  [StructLayout(LayoutKind.Sequential)] struct PPT { public uint Version; public uint ControlMask; public uint StateMask; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetProcessInformation(IntPtr h, int cls, ref PPT info, int size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  // high = true: never throttle execution speed or timer resolution. false: let Windows decide again.
  public static int Set(int pid, bool high) {
    IntPtr h = OpenProcess(0x0200 /* PROCESS_SET_INFORMATION */, false, pid);
    if (h == IntPtr.Zero) return -1;
    PPT p = new PPT(); p.Version = 1; p.ControlMask = high ? 0x5u : 0u; p.StateMask = 0;   // EXECUTION_SPEED | IGNORE_TIMER_RESOLUTION
    bool ok = SetProcessInformation(h, 4 /* ProcessPowerThrottling */, ref p, Marshal.SizeOf(p));
    CloseHandle(h);
    return ok ? 1 : 0;
  }
}`;

function setHighQoS(pids, high) {
  if (process.platform !== 'win32' || !pids.length) return Promise.resolve(null);
  const script = `Add-Type -TypeDefinition @'\n${CS}\n'@\n` +
    pids.map(p => `[GpQos]::Set(${p | 0}, $${high ? 'true' : 'false'})`).join('\n');
  return new Promise((resolve) => {
    let out = '';
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
    ps.stdout.on('data', d => { out += d; });
    ps.on('error', () => resolve(null));
    ps.on('close', () => resolve(out.trim().split(/\s+/).filter(Boolean).map(Number)));
  });
}

module.exports = { setHighQoS };
