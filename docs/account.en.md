# Your account

[简体中文](account.md) | **English**

Read this page before signing the service in to your own Claude account.

## What this looks like to Anthropic

An official Claude Code running on your server: signed in through the official flow, run by the official Agent SDK for the desktop client and as the interactive official CLI in `ccdt`, connecting to the model service directly from the server. This project does not modify Claude Code, does not handle or rewrite the requests between it and the model service, and does not fake a region, device or client identity. Claude runs commands on your computer the same way it would if you used Claude Code on a server to work on another machine over SSH.

That describes the structure. **It is not a guarantee about your account.** Keep in mind:

- **The server's location is where you are using Claude.** Every request Claude Code makes leaves from the server. Choose a server in one of [Anthropic's supported countries and regions](https://www.anthropic.com/supported-countries) with a clean history. Even if you are in a supported region yourself, a service placed in an unsupported one, or on a heavily abused IP address, may trip risk controls. This project does not, and cannot, change or hide this.
- **The terms are yours to check.** Anthropic sets out how subscription sign-in and the Agent SDK may be used (see its [legal and compliance notes](https://code.claude.com/docs/en/legal-and-compliance)), including limits on third-party products offering Claude.ai sign-in or using subscription quota on a user's behalf. That something works does not mean your use is permitted; when unsure, use an API key instead (configured in `config/provider.json` in the data directory).
- **The 5-hour quota may count differently.** Community tests (see [#136](https://github.com/sun168567/cc-desk-tunnel/issues/136)) found that the same work counts about twice as much toward the 5-hour quota when run through the Agent SDK as in the interactive CLI; the weekly quota is not affected. When the 5-hour quota is tight, run long tasks in `ccdt`.
- **One account, one person.** Do not use this to share or resell an account; the project offers no such feature and will not accept one.
- The project makes no promise about account standing, availability or compliance.

## Scope

- **Single user.** One service serves one person, who may have several of their computers connected at once; each session runs on the computer its project directory is on. There are no multiple users, permission levels or tenant isolation, and none are planned.
- **No modification of the official client, no evasion.** Nothing here is designed to get around risk controls or detection, or to get past the service's regional restrictions.
