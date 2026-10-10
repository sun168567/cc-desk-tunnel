# CC Desk Tunnel

[简体中文](README.md) | **English**

Drive Claude Code in the cloud from a desktop client, and let it work on your Windows PC through a reverse tunnel.

Claude Code (CC for short) runs on a Linux server; your code, compilers and tools stay on Windows. CC Desk Tunnel connects the two: a container on the server, a desktop client on Windows, and an encrypted reverse SSH channel through which Claude reads and writes files and runs commands on your computer.

[Download](https://github.com/sun168567/cc-desk-tunnel/releases/latest) · [Quick start](#quick-start) · [Security](#security) · [Documentation](#documentation) · License: [Apache-2.0](LICENSE)

> [!WARNING]
> **This project is mostly written by AI**, maintained by one person, and has not had a professional security audit. It may contain undiscovered defects. It gives a server the ability to run commands on your computer: read [Security](#security) and [Your account](#your-account) first and judge the risk for yourself.
>
> This project is not affiliated with Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.
>
> The client interface, the installer prompts and the detailed documentation are currently in Chinese only.

## What it solves

| The usual way | What gets in the way | With CC Desk Tunnel |
| --- | --- | --- |
| Move the project to a server and let Claude Code develop there | You set up the toolchain again; builds and tests need an expensive machine; your local editor, emulators and desktop software are out of reach | Project and toolchain stay local and commands run locally; the server only runs Claude Code, so a small one is enough |
| Use the CLI on the server through remote desktop or an SSH terminal | Lag, awkward input methods and copy-paste, long output that is hard to read back | A local desktop app with native input, scrolling and copying |
| Use the command-line interface as it is | Several projects and sessions are hard to keep apart; tool calls and thinking scroll by in one stream of text | Sessions grouped by project; the process folded into summaries you can expand |

## How it works

```text
Windows: desktop client + bundled OpenSSH + your projects
  │  WSS: sign-in, conversation, approvals, settings
  ▼
Linux (Docker): proxy service ── official Agent SDK ── unmodified Claude Code ── model service
  │                                                     │
  │                                         native Bash runs ssh
  └──── execution channel (WSS on the same address, loopback) ─┘
                         │
                         ▼
Windows: PowerShell 7 reads and writes files, runs commands; results return to Claude
```

- Windows connects out. It needs no public IP and no inbound port.
- SSH keys are generated for each connection and destroyed when it ends; nothing is installed as a permanent service on Windows.
- The project is glue on top of the official Agent SDK and the unmodified official Claude Code: it does not change the CLI or replace its tools, approvals or context management. Sessions and long-term memory are kept by Claude Code itself on the server.

This repository publishes all of its own client, server, build and deployment source, with no separate closed-source features. **This does not make Claude Code open source**: the official CLI and Agent SDK are installed from official channels and remain subject to Anthropic's terms. Bundled third-party components retain their own licenses; see [NOTICE](NOTICE).

## Features

| | |
| --- | --- |
| **Projects and sessions** | Grouped by Windows folder; create, rename, delete, search, fork; edit and resend any of your own messages |
| **The conversation** | Streaming replies, thinking summaries, tool calls with their input and results; add messages during a run, stop at any time |
| **Native controls** | Model, reasoning effort, approval mode, context usage and manual compaction, common Claude Code settings; an embedded native terminal when you need it |
| **Account and usage** | Sign the server's Claude account in or out from the client; see quota, reset times and usage statistics |
| **Scheduled tasks** | Send a prepared prompt to a session, or a new one, at a set time; Claude can set these up for you |
| **Convenience** | Runs in the tray, remembers the sign-in, keeps unsent text per session |
| **One-click upgrades** | The service follows the release page; upgrade service and client from the client, without logging in to the server |

## Quick start

You need a Linux server with a public IP or domain name (x86_64, Ubuntu recommended, Docker installed) and a Windows 10 / 11 x64 PC.

**The server can be small.** Builds, tests and development tools all run on your Windows PC; the server only hosts Claude Code and a lightweight proxy service, so an entry-level machine with 2 vCPUs and 1 GB of memory is enough. Size it for heavier work only if you plan to have Claude build or run demanding tasks on the server itself.

### 1. Deploy the service

On the server:

```sh
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/sun168567/cc-desk-tunnel/main/deploy/install.sh)"
```

The script:

1. Checks for Docker, Docker Compose and a few tools. If something is missing it tells you the command to install it; it does not install system software itself.
2. Downloads the newest server archive from this repository's releases, verifies it and unpacks it to `/opt/cc-desk-tunnel`.
3. Asks for the public address, certificate mode, ports and data directory (every question has a default), then builds the image and starts it.
4. Prints what the client needs — **service address, certificate fingerprint, service token** — and the TCP port to open in the firewall (8787 by default, the only one).

There is no prebuilt image yet: the image is built from source on your server, which takes a few minutes the first time. The script does not touch the firewall, nginx or SSH. Running the same command again upgrades an existing deployment. Manual installation, the three certificate modes, backup and restore are covered in the [deployment manual](deploy/README.md); if you already run nginx with a domain, see [reverse proxying with nginx](deploy/nginx.md).

### 2. Install the Windows client

Download `CC-Desk-Tunnel-Setup-<version>-x64.exe` from the [releases page](https://github.com/sun168567/cc-desk-tunnel/releases/latest) and install it. It bundles PowerShell 7 and OpenSSH; nothing else is needed. Start it, enter the three values from step 1 and connect.

Expect a SmartScreen prompt on first run; see [Antivirus and SmartScreen](#antivirus-and-smartscreen).

### 3. Sign in to Claude

Sign in to your Claude account on the account page at the bottom left of the client (the official `claude auth` flow; the login is stored only on the server), add a project folder and start a conversation.

## Security

**One premise: the server must be a machine you control and trust.** While you are connected, the server can run any command as your Windows user. A compromised server is a compromised PC. Do not deploy on a machine you share with others or do not know the history of.

### Ports

| Port | Purpose | Open it? | Protected by |
| --- | --- | --- | --- |
| Service port (8787/TCP by default) | Client sign-in and conversation; the client also sets up Claude's execution channel to your PC through it | Yes. In nginx mode open nginx's 443 instead; 8787 then listens on the server only | TLS + service token + sign-in throttling; the execution channel also has a random secret for each connection |
| The SSH port leading to Windows (random) | Claude running commands on your PC | **No, and it cannot be opened** | Listens only on the loopback address inside the container; it is not published to the server, let alone the internet, and accepts only the temporary public key of this connection |

- **On Windows** no inbound port is needed; the local SSH server listens on loopback only and runs only while connected.
- **If the server's firewall allows every port**: the SSH port still cannot be reached from outside. The project still exposes only the one port above, and its security rests on the service token. Allowing everything does expose whatever else runs on the server (its own SSH, for example), so open only what you need.
- To tighten further, allow only your own egress IP to reach the port in your cloud provider's security group. Ports published by Docker usually bypass `ufw` rules, so restrict sources in the provider's security group.
- **Deployments upgraded from 0.2.9 or earlier** also opened a tunnel port (7000/TCP by default). It is no longer used from 0.2.10 and can be removed from the firewall and security group.

### Four things you must know

1. **The service token is full control.** Whoever has it can use your Claude account and run any command on your PC. Use the random token the script generates, do not replace it with a short password, and do not paste it into screenshots, chats or issues. If it leaks, run `manage.sh token` on the server to replace it.
2. **It is not a sandbox.** Claude can reach everything your Windows user can reach, not just the project folder. The project only guides it by prompt to stay inside the project; approvals are Claude Code's own.
3. **Data leaves your PC.** File excerpts and command output that Claude reads pass through your server to the model service. The server stores session history and the Claude login; backups contain these secrets too.
4. **Get the fingerprint from a trusted place.** With a self-signed certificate, the fingerprint should come from the installation summary you saw yourself on the server, not from a forwarded message.

> If an AI assistant deploys this for you, have it read this section first and remind you to: open only the one port, store the service token safely, and make sure the server is trustworthy.

The full threat model, existing protections and how to report a vulnerability are in [SECURITY.md](SECURITY.md); ports, certificates and trust boundaries in detail are in [Deployment and security boundaries](docs/deployment.md).

## Your account

**What does this look like to Anthropic?** An official Claude Code running on your server: signed in through the official flow, started by the official Agent SDK, and connecting to the model service directly from the server. This project does not modify Claude Code, does not handle or rewrite the requests between it and the model service, and does not fake a region, device or client identity. Claude runs commands on your PC the same way it would if you used Claude Code on a server to work on another machine over SSH.

That describes the structure. **It is not a guarantee about your account.** Keep in mind:

- **The server's location is where you are using Claude.** Every request Claude Code makes leaves from the server. Choose a server in one of [Anthropic's supported countries and regions](https://www.anthropic.com/supported-countries) with a clean history. Even if you are in a supported region yourself, a service placed in an unsupported one, or on a heavily abused IP address, may trip risk controls. This project does not, and cannot, change or hide this.
- **The terms are yours to check.** Anthropic sets out how subscription sign-in and the Agent SDK may be used (see its [legal and compliance notes](https://code.claude.com/docs/en/legal-and-compliance)), including limits on third-party products offering Claude.ai sign-in or using subscription quota on a user's behalf. That something works does not mean your use is permitted; when unsure, use an API key instead (configured in `config/provider.json` in the data directory).
- **One account, one person.** Do not use this to share or resell an account; the project offers no such feature and will not accept one.
- The project makes no promise about account standing, availability or compliance.

## Antivirus and SmartScreen

- **frpc is no longer bundled.** Clients up to 0.2.9 shipped `frpc.exe` from the tunnelling tool frp, which Windows Defender and other antivirus products often quarantine as "hack tool / riskware". From 0.2.10 the client sets up the execution channel itself through the service address; neither the installer nor the server image contains frp, and the installer removes the old `frpc.exe` on upgrade.
- **Verify before allowing a bundled component.** The client still bundles the official releases of OpenSSH and PowerShell 7, verifies their SHA256 when packaging, runs them only while connected and has them listen on this machine only. They are rarely blocked; if it happens, check that the installer comes from this repository's [releases page](https://github.com/sun168567/cc-desk-tunnel/releases/latest), verify it against `SHA256SUMS`, and identify the file that was blocked. After checking the source, make only the necessary exception for the verified component file; do not disable antivirus or exclude a whole drive. Restore quarantined files or reinstall only after verification.
- **SmartScreen.** The installer is not code-signed. On first run Windows shows "Windows protected your PC": choose "More info → Run anyway".
- The project never changes the settings of any security software. If in doubt, build from source.

## Scope

- **Single user.** One service serves one person and one online Windows device at a time. There are no multiple users, permission levels or tenant isolation, and none are planned.
- **No modification of the official client, no evasion.** Nothing here is designed to get around risk controls or detection, or to get past the service's regional restrictions.

## Documentation

| Document | Contents |
| --- | --- |
| [Deployment manual](deploy/README.md) | Installation, upgrades, three TLS modes, backup and restore, operations |
| [Deployment and security boundaries](docs/deployment.md) | Ports, certificates, credentials, data and trust boundaries |
| [Security](SECURITY.md) | Threat model, protections, known gaps, reporting a vulnerability |
| [Architecture](docs/architecture.md) | Components, how a connection is established, key design decisions |
| [Native runtime and session storage](docs/native-runtime.md) | How the official CLI is driven, who owns context, approvals, retention |
| [Windows client](apps/desktop/README.md) · [Linux service](apps/server/README.md) · [Message contract](packages/protocol/README.md) | Implementation notes per module |
| [Roadmap and status](docs/roadmap.md) · [Changelog](CHANGELOG.md) | Done, unverified and planned; changes per version |
| [Development conventions](docs/development.md) | Branches, commits, checks, releases |

These documents are in Chinese.

## Building from source

You need Git, Node.js 24 and npm; on Windows, PowerShell 7.

```powershell
npm ci
npm run dev               # local simulated service + browser UI, no account needed
npm test                  # unit tests; also typecheck, test:ui, check
npm run package:windows   # builds the Windows installer; preparation in apps/desktop/README.md
npm run package:server    # builds the server archive; on the server, run its deploy/install.sh
```

```text
apps/desktop/       Windows client: UI (React), Electron main process, connection bridge, local execution components
apps/server/        Linux service: sessions, Claude Code adapter, Windows tunnel, usage statistics, release tracking
packages/protocol/  Message contract between the two sides (Zod)
deploy/             Docker deployment and operations scripts
scripts/            Checks, development launcher, packaging, release
docs/               Architecture, deployment and development documentation
```

## Community

We recognize [LINUX DO](https://linux.do/) and its values of sincerity, friendliness, solidarity and professionalism, and appreciate the community's discussions of remote development and open-source tools. Feedback is welcome; redact account details, service tokens, server addresses and private project information first. Report security vulnerabilities through the [private reporting channel](SECURITY.md#报告漏洞).

## License

[Apache License 2.0](LICENSE). Bundled third-party components and their licenses are listed in [NOTICE](NOTICE).
