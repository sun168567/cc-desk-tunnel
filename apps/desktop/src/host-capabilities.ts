// The same workbench runs in two hosts. Only the desktop owns local folders and an execution channel.
export function hostCapabilities(browser: boolean) {
  return {
    localProjects: !browser,
    schedules: !browser,
    accountManagement: !browser,
    serviceManagement: !browser,
    nativeSettings: !browser,
    // Opening a session in ccdt, a program on this computer.
    terminalClient: !browser,
  };
}
