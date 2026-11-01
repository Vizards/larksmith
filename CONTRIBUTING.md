# Contributing to larksmith

Use Node.js 24 and `npm ci --ignore-scripts`. Run:

```sh
npm run typecheck
npm test
BRIDGE_ISSUER=https://mcp.example.com npm run build
npm run release:check
```

Tests use synthetic identities and in-memory storage. Builds download and verify
the pinned official Linux CLI. Use independent test credentials and resources for
cloud integration checks.

## Command and file support

Keep ordinary CLI commands on the generic discovery and execution path. Fix
catalog generation or dispatch centrally, and record identity, file transport or
lifecycle adaptations in the [Agent guide](docs/bridge.md). Use upstream risk and
user-identity metadata to determine command eligibility.

File routes should bound input/output, validate download destinations, and clean
temporary files on every exit path. Add regression coverage for changed behavior,
including failure handling.

## State and CLI updates

Preserve state names, key derivation contexts, OAuth subject, issuer and account
aliases when updating an instance. Validate persistence changes with synthetic
fixtures; follow the [upgrade instructions](docs/upgrade.md) for deployment.

For CLI upgrades, review the upstream release and license, update the version and
checksum in `config/cli-version.json`, then regenerate the catalog:

```sh
LARK_CATALOG_BINARY=/path/to/candidate npm run catalog
```

Review new commands, risk, identity and file parameters. Run tests and build, then
verify representative reads and writes in a dedicated test workspace.

Use synthetic examples in issues and pull requests. Contributions use the project's
MIT license; retain third-party attribution.
