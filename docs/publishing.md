# Publishing to GitHub, npm, and the MCP Registry

The project publishes through GitHub Actions. A normal release is intentionally split into a feature merge and a small release-version merge so the published artifact can be tied to one reviewed `main` commit.

Public distribution channels:

- GitHub Release / Qwen extension archive
- npm package: `@slp-dev1/qwen-dap-mcp`
- official MCP Registry server: `io.github.SLP-DEV1/qwen-dap-mcp`

The npm artifact must exist before the MCP Registry can validate and publish the server metadata.

## Release version contract

Before publishing, keep these values identical:

- `package.json` → `version`
- `qwen-extension.json` → `version`
- `server.json` → `version`
- `server.json` → `packages[0].version`
- `package-lock.json` root package metadata

`npm run check` includes regression coverage for the release metadata. The publishing workflow also validates the selected release version before any registry write occurs.

Do not overwrite an npm version. Bump the project version and publish a new immutable version instead.

## Recommended release flow

1. Merge the completed feature PR into `main` after its full CI matrix is green.
2. Create a dedicated release branch such as `chore/v0.18.0-release` from that exact `main` commit.
3. Update the release-version files only.
4. Move the completed feature notes from `CHANGELOG.md` → `Unreleased` into a dated release section.
5. Open the release PR and wait for the same required CI/adapter/policy checks.
6. Merge the release PR to `main`.

A push to `main` that changes the release version triggers `.github/workflows/release-extension.yml`.

## `Release Qwen Extension` workflow

The release workflow:

1. checks out the release commit,
2. installs dependencies with `npm ci --ignore-scripts`,
3. runs the full build/test/package check,
4. resolves the version from `package.json`,
5. builds the self-contained extension archive,
6. installs Qwen Code for smoke validation,
7. verifies that the archive installs as a Qwen extension,
8. creates the GitHub Release/tag when it does not already exist,
9. verifies release metadata,
10. installs the published GitHub Release and verifies the exact extension version,
11. triggers the npm + MCP Registry publication workflow.

The release archive bundles runtime npm dependencies into the built server so the GitHub extension install is self-contained.

## `Publish npm and MCP Registry` workflow

`.github/workflows/publish-registries.yml` is normally triggered by the successful GitHub release workflow. It can also be run manually for recovery/verification scenarios.

The workflow:

1. requires the default branch / selects the released version,
2. installs dependencies,
3. builds and tests the project,
4. verifies GitHub release metadata and selected version,
5. verifies the exact npm package contents,
6. checks whether that npm version already exists,
7. publishes `@slp-dev1/qwen-dap-mcp` when needed,
8. verifies the package is actually visible on npm with the expected `mcpName`,
9. checks whether the MCP Registry version already exists,
10. installs the verified `mcp-publisher`,
11. authenticates to the MCP Registry with GitHub OIDC,
12. publishes `server.json` when needed.

A successful trigger alone is not sufficient release evidence. Treat npm publication as complete only after the workflow's npm visibility check succeeds, and MCP Registry publication as complete only after the publisher step succeeds.

## npm authentication

The workflow supports npm Trusted Publishing / GitHub Actions OIDC. If the package is configured for Trusted Publishing, no long-lived npm token should be necessary.

The npm package should trust:

- provider: GitHub Actions
- GitHub user / organization: `SLP-DEV1`
- repository: `qwen-dap-mcp`
- workflow filename: `publish-registries.yml`
- permission: npm publish

A bootstrap `NPM_TOKEN` path may still exist in the workflow for repository setups that have not completed Trusted Publishing configuration. Never place npm credentials in source control.

## MCP Registry ownership

The official registry validates package ownership/identity through the published npm metadata and server manifest. For this project:

```text
package.json mcpName
        ==
server.json name
        ==
io.github.SLP-DEV1/qwen-dap-mcp
```

The capitalization intentionally matches the GitHub account namespace used for registry authentication.

## Post-release verification

After the workflows finish, verify all of the following against the same release commit:

- GitHub tag/release exists and is not draft/prerelease unless intentionally requested,
- the release archive exists and its digest is recorded,
- the GitHub release install smoke verified the exact manifest version,
- npm visibility verification succeeded for `@slp-dev1/qwen-dap-mcp@<version>`,
- MCP Registry publication succeeded for `io.github.SLP-DEV1/qwen-dap-mcp` at the same version.

If documentation-only cleanup follows a release, do **not** create a patch release unless the user intends to publish new runtime/package contents.
