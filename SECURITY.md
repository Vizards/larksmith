# Security

## Account access

Each larksmith instance serves one owner and their configured Feishu user accounts.
The owner password authorizes MCP clients to access those accounts. Keep that
password in a password manager and use a separate instance for each owner.

Each CLI invocation receives the selected account's user token in an isolated
temporary directory. The dispatcher checks command risk and identity metadata,
passes arguments directly to the CLI, and routes files through dedicated transfer
tools. Treat remote document content as untrusted data. Obtain user authorization
for high-risk actions, then set the corresponding confirmation flag.

## Credentials and state

OAuth uses authorization code + PKCE and rotating refresh tokens. Shared state is
encrypted and updated through conditional writes. Each request checks the current
authorization state. Per-instance rate limits and bounded retries control traffic.
Use Vercel firewall and usage monitoring for deployment-level protection.

Store application secrets, signing keys, encryption keys, password hashes and
Cron secrets in Vercel sensitive environment variables. Back up static credentials
in a password manager, and preserve the latest rotating OAuth state in Redis.
Use separate credentials, databases and Blob stores for development, Preview and
Production. Keep repositories and public logs limited to source and synthetic data.

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** channel. If that channel
is unavailable, contact the maintainer privately to arrange secure disclosure.
Share reproduction steps with synthetic data and send sensitive details through
the agreed private channel.
