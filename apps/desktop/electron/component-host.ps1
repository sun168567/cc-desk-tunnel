param(
  [Parameter(Mandatory)][string]$Runtime,
  [Parameter(Mandatory)][string]$OpenSshDirectory,
  [Parameter(Mandatory)][int]$OwnerProcessId
)
$ErrorActionPreference = 'Stop'
$Runtime = [IO.Path]::GetFullPath($Runtime)
if ([IO.Path]::GetDirectoryName($Runtime) -ne [IO.Path]::GetTempPath().TrimEnd('\') -or
    [IO.Path]::GetFileName($Runtime) -notlike 'cc-desk-tunnel-ssh-*') {
  throw 'Component runtime must be a client-allocated temporary directory.'
}
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public static class ComponentHost {
  const uint JobKillOnClose = 0x2000;
  const uint CreateSuspended = 0x4;
  const uint CreateNoWindow = 0x08000000;
  const uint Synchronize = 0x100000;
  const uint Infinite = uint.MaxValue;
  const uint WaitTimeout = 258;
  const int StartUseStdHandles = 0x100;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct StartupInfo {
    public int cb;
    public string reserved, desktop, title;
    public int x,y,xsize,ysize,xcount,ycount,fill,flags;
    public short show,reservedSize;
    public IntPtr reservedBytes,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo { public IntPtr process, thread; public int pid, tid; }
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimit {
    public long processTime,jobTime;
    public uint flags;
    public UIntPtr minimumWorkingSet,maximumWorkingSet;
    public uint activeProcesses;
    public UIntPtr affinity;
    public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimit {
    public BasicLimit basic;
    public IoCounters io;
    public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, int size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity,
    bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  public static int Run(string[] executables, string[] arguments, int ownerPid, string stopPath) {
    var job = CreateJobObject(IntPtr.Zero,null);
    if(job == IntPtr.Zero) throw new Win32Exception();
    var processes = new IntPtr[executables.Length];
    IntPtr owner = IntPtr.Zero;
    var stopping = new CancellationTokenSource();
    Task watcher = null;
    try {
      var limits = new ExtendedLimit { basic = new BasicLimit { flags = JobKillOnClose } };
      var size = Marshal.SizeOf<ExtendedLimit>();
      var memory = Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(limits,memory,false);
        if(!SetInformationJobObject(job,9,memory,size)) throw new Win32Exception();
      } finally { Marshal.FreeHGlobal(memory); }
      owner = OpenProcess(Synchronize,false,ownerPid);
      if(owner == IntPtr.Zero) throw new Win32Exception();
      var waits = new Task[executables.Length + 1];
      var ownerHandle = owner;
      watcher = waits[executables.Length] = Task.Run(() => {
        while(!stopping.IsCancellationRequested && !File.Exists(stopPath)) {
          var state = WaitForSingleObject(ownerHandle,250);
          if(state == 0) return;
          if(state != WaitTimeout) throw new Win32Exception();
        }
      });
      for(int index=0; index<executables.Length; index++) {
        var startup = new StartupInfo {
          cb=Marshal.SizeOf<StartupInfo>(), flags=StartUseStdHandles,
          input=GetStdHandle(-10),output=GetStdHandle(-11),error=GetStdHandle(-12)
        };
        ProcessInfo info;
        var command = new StringBuilder("\""+executables[index]+"\" "+arguments[index]);
        // Assign while suspended so no component child can escape the owner's job.
        if(!CreateProcess(executables[index],command,IntPtr.Zero,IntPtr.Zero,true,CreateNoWindow | CreateSuspended,
          IntPtr.Zero,null,ref startup,out info)) {
          var refused = new Win32Exception();
          // Read by the client to tell the user which component the system would not start, and why.
          Console.Error.WriteLine("cc-desk-tunnel: cannot start "+Path.GetFileName(executables[index])+" error "+refused.NativeErrorCode);
          throw refused;
        }
        processes[index] = info.process;
        try {
          if(!AssignProcessToJobObject(job,info.process)) {
            var error = new Win32Exception();
            TerminateProcess(info.process,1);
            throw error;
          }
          if(ResumeThread(info.thread) == uint.MaxValue) throw new Win32Exception();
        } finally { CloseHandle(info.thread); }
        var handle = info.process;
        waits[index] = Task.Run(() => {
          if(WaitForSingleObject(handle,Infinite) != 0) throw new Win32Exception();
        });
      }
      var completed = Task.WaitAny(waits);
      waits[completed].GetAwaiter().GetResult();
      if(completed >= executables.Length) return 0;
      uint code;
      if(!GetExitCodeProcess(processes[completed],out code)) throw new Win32Exception();
      Console.Error.WriteLine("cc-desk-tunnel: "+Path.GetFileName(executables[completed])+" exited "+code);
      return code == 0 ? 1 : (int)code;
    } finally {
      CloseHandle(job);
      stopping.Cancel();
      if(watcher != null) watcher.GetAwaiter().GetResult();
      stopping.Dispose();
      if(owner != IntPtr.Zero) CloseHandle(owner);
      foreach(var handle in processes) {
        if(handle == IntPtr.Zero) continue;
        WaitForSingleObject(handle,5000);
        CloseHandle(handle);
      }
    }
  }
}
'@
$executables = @((Join-Path $OpenSshDirectory 'sshd.exe'))
$arguments = @("-D -e -f `"$(Join-Path $Runtime 'sshd_config')`"")
# sshd detaches its session process, so each command's cmd.exe would open a visible console on the user's desktop.
# This OpenSSH switch makes sshd create its children with CREATE_NO_WINDOW; it is set for this host's children only.
$env:SSH_TEST_ENVIRONMENT = '1'
# The service has Claude run PowerShell by this variable, which every command of the SSH service inherits: the
# one this host runs in, whichever others the computer has installed. The path of a command is not inherited;
# the SSH service makes it anew from the computer's settings.
$env:CC_DESK_TUNNEL_PWSH = [Environment]::ProcessPath
# OpenSSH hands the state of its descriptors to its own children in this variable. Started from inside an SSH
# session (a command Claude runs on this computer, such as the project's own tests), sshd would take the outer
# session's state for its own and never answer a connection once its error output is a pipe.
Get-ChildItem Env: | Where-Object Name -Like '*_POSIX_FD_STATE' | ForEach-Object { Remove-Item -LiteralPath "Env:$($_.Name)" }
$code = 1
try {
  $code = [ComponentHost]::Run($executables, $arguments, $OwnerProcessId, (Join-Path $Runtime 'stop'))
} finally {
  # Runtime is allocated by the client, not supplied by a remote message.
  Remove-Item -LiteralPath $Runtime -Recurse -Force
}
exit $code
