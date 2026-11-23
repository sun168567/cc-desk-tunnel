# Troubleshooting

[简体中文](troubleshooting.md) | **English**

Go through this page when the client cannot connect, when a connection keeps dropping, or when security software blocks the installer or a bundled component. The client's messages are in Chinese; each row below gives the message as it appears and what it means.

## When connecting fails

The first line of the message on the sign-in page is the cause, and what follows says where to look. A connection is made in two stages, and the message tells you which one failed:

| Message | Meaning | What to do |
| --- | --- | --- |
| 无法解析域名 / 连接超时 / 拒绝了连接 (cannot resolve the domain / timed out / connection refused) | The control connection did not reach the service | Check the service address and port, that the server is up, and that the control port is open |
| 证书不受信任 / 指纹不匹配 / 证书已过期 (certificate not trusted / fingerprint mismatch / certificate expired) | TLS verification failed | For a self-signed certificate, enter the SHA256 fingerprint the installer printed; after a certificate change, use the new one; renew an expired certificate on the server |
| 服务凭据不正确 (wrong service token) | The service was reached and refused the token | Check the token; after several failures in a row the address is refused for a while |
| 版本不一致 (version mismatch) | The client and the service are on different versions | Upgrade as the sign-in page suggests |
| SSH 服务被拦截 / 找不到 / 没能启动 (SSH server blocked / missing / failed to start) | The token was accepted, but the local `sshd.exe` or PowerShell could not run | If the message includes their output, act on it; if blocked or missing, see [Antivirus and SmartScreen](#antivirus-and-smartscreen) and check your security software's history first |
| 执行通道没有就绪 (execution channel not ready) | The token was accepted and the local SSH server started, but the service could not reach back to this computer through the execution channel | Follow the reason in the message if there is one; through a reverse proxy or a system proxy, make sure it allows several simultaneous connections to the same address |
| 本机 SSH 服务没有执行探测命令 (the local SSH server did not run the probe) | The execution channel is up, but the local SSH server did not run the probe command the service sent | Follow the "本机答复" (local reply): it is what the local shell or `ssh` said |
| 本机 OpenSSH 的默认 shell 是 … (the default shell of the local OpenSSH is …) | The system OpenSSH sets `DefaultShell` (registry `HKLM\SOFTWARE\OpenSSH`), and the bundled `sshd.exe` uses it too | PowerShell, pwsh and Git Bash are handled by the client, and commands still run as cmd; for any other shell, delete the value or set it back |

## When a working connection drops

Nothing needs doing when the connection drops: the client stays where it is and reconnects by itself, for as long as it takes, then catches up on what happened meanwhile. A task that was running goes on in the service; only the command that was executing on the computer at that moment fails, which Claude sees and deals with, and later commands wait for the computer to come back.

A task stops only after the computer has been away for more than 5 minutes (`PROXY_GRACE_SECONDS` on the server changes this). Back in the session, the "continue" button at the lower right of the message box takes it up again without writing anything; the same goes for a task stopped by hand. Choosing "Disconnect" or quitting the client ends a task at once.

The client checks every 15 seconds that the service is still there and, after about 45 seconds without any answer, treats the connection as lost; the service does the same for the client. It returns to the sign-in page only when the service refuses it outright (wrong token, another version).

To find which part of the way failed, compare both records:

- **Client**: `client.log` under "Settings → About and updates → Open log folder". For each connection it records when it was made, when it ended, whether the window or the service side ended it first, and why. It contains no credentials, conversations or commands.
- **Server**: `sudo docker logs <container> 2>&1 | grep Connection`. For each connection it records which computer it was, the address it came from, how long it lasted and how it ended. `no heartbeat answer for 45s` means the service got no answer from the client; `code 1006` means the other side went away without saying so, usually somewhere on the network, a proxy or a reverse proxy in between.

When connecting through a proxy or a reverse proxy, make sure it does not cut connections that carry little data for a long time; see [nginx as a reverse proxy](../deploy/nginx.md) (in Chinese) for nginx.

## Antivirus and SmartScreen

- **Verify before allowing a bundled component.** The Windows client bundles the official releases of OpenSSH and PowerShell 7, verifies their SHA256 when packaging, runs them only while connected and has them listen on this machine only. They are rarely blocked; if it happens, check that the installer comes from this repository's [releases page](https://github.com/sun168567/cc-desk-tunnel/releases/latest), verify it against `SHA256SUMS`, and identify the file that was blocked. After checking the source, make only the necessary exception for the verified component file; do not disable antivirus or exclude a whole drive. Restore quarantined files or reinstall only after verification.
- **SmartScreen.** The installer is not code-signed. On first run Windows shows "Windows protected your PC": choose "More info → Run anyway".
- The project never changes the settings of any security software. If in doubt, [build from source](../README.en.md#building-from-source).
