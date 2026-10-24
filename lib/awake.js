import { spawn } from 'node:child_process';

// Asks Windows not to go to sleep while a post is scheduled (ES_CONTINUOUS | ES_SYSTEM_REQUIRED; the screen
// may still turn off). It does not stop a manual Sleep or closing a laptop lid.
// The helper exits on its own if this server dies, so the request never leaks.
let child = null;

const script = parentPid => `
Add-Type -Name P -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[W.P]::SetThreadExecutionState([uint32]2147483649) | Out-Null
while (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 }
`;

export function keepAwake(on) {
  if (process.platform !== 'win32' || on === !!child) return;
  if (!on) {
    child.kill();
    child = null;
    return;
  }
  child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script(process.pid)], { stdio: 'ignore', windowsHide: true });
  child.on('exit', () => { child = null; });
  child.on('error', () => { child = null; });
}
