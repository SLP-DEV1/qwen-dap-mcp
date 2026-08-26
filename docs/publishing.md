# Publishing to npm and the MCP Registry

GitHub Releases are the primary Qwen Code distribution path and are already automated by `release-extension.yml`.

The repository is also prepared for two additional public distribution channels:

- npm package: `@slp-dev1/qwen-dap-mcp`
- official MCP Registry server: `io.github.SLP-DEV1/qwen-dap-mcp`

The npm artifact must exist before the MCP Registry can validate and publish the server metadata.

## Before the first npm publish

The npm account or organization that owns the `@slp-dev1` scope must grant you publish access. The GitHub username alone does not automatically create or grant the matching npm scope.

The package metadata is already configured for public scoped publication:

- `package.json` name: `@slp-dev1/qwen-dap-mcp`
- `publishConfig.access`: `public`
- `mcpName`: `io.github.SLP-DEV1/qwen-dap-mcp`
- `server.json` uses the same MCP name and npm package/version

CI also runs `npm pack --dry-run --json` and verifies that the package contains the bundled server, Qwen extension manifest, MCP Registry metadata, README, and Apache-2.0 license.

## Bootstrap option A: publish once from a trusted local terminal

After signing in to the npm account that owns the scope:

```bash
npm login
npm ci --ignore-scripts
npm run check
npm publish --access public
```

Then verify:

```bash
npm view @slp-dev1/qwen-dap-mcp@0.11.1 version
npm view @slp-dev1/qwen-dap-mcp@0.11.1 mcpName
```

The second command must return:

```text
io.github.SLP-DEV1/qwen-dap-mcp
```

After npm is live, run the GitHub Actions workflow **Publish npm and MCP Registry** with `publish_npm=false` and `publish_mcp=true`. MCP Registry authentication uses GitHub OIDC, so no MCP Registry secret is required.

## Bootstrap option B: use a temporary npm token in GitHub Actions

Create a GitHub repository secret named `NPM_TOKEN` whose npm identity can publish to the `@slp-dev1` scope. Then run **Publish npm and MCP Registry** with both inputs enabled.

The workflow will:

1. build and test the project,
2. verify package/extension/server versions and ownership metadata,
3. inspect the exact npm package contents,
4. skip npm publication when that exact version already exists,
5. otherwise publish the public scoped npm package,
6. wait until npm exposes the expected `mcpName`,
7. download the latest official `mcp-publisher`,
8. authenticate to the MCP Registry with GitHub OIDC,
9. publish `server.json`.

The workflow never contains an npm token in source control.

## Recommended after the first npm version exists: npm Trusted Publishing

Once the package exists on npm, configure a Trusted Publisher for the package so future GitHub Actions publishes use short-lived OIDC credentials instead of a long-lived npm token.

Configure the npm package to trust:

- provider: GitHub Actions
- GitHub user / organization: `SLP-DEV1`
- repository: `qwen-dap-mcp`
- workflow filename: `publish-registries.yml`
- permission: npm publish

The workflow already grants `id-token: write` and uses a current Node/npm environment suitable for OIDC. After Trusted Publishing works, remove the `NPM_TOKEN` repository secret.

## MCP Registry ownership

The official registry validates npm ownership by comparing:

```text
package.json mcpName
        ==
server.json name
```

For this project both values are:

```text
io.github.SLP-DEV1/qwen-dap-mcp
```

The capitalization intentionally matches the GitHub account name used for GitHub namespace authentication.

## Version releases

For a future release, keep these versions identical before publishing:

- `package.json` → `version`
- `qwen-extension.json` → `version`
- `server.json` → `version`
- `server.json` → `packages[0].version`

The registry workflow fails before publication if these values diverge.

Do not overwrite an npm version. Bump the project version and publish a new immutable version instead.
