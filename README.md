# Alauda DevOps Artifact Hub Shim Docs

This repository contains the public documentation for Alauda DevOps Artifact Hub Shim.

## Source and synchronization

The documentation and its build configuration are synchronized from
[`AlaudaDevops/artifacthub-shim`](https://github.com/AlaudaDevops/artifacthub-shim).
Changes merged into this public repository are sent back to the source repository as
reviewable pull requests.

The source repository remains the canonical location for product code and release
management. This repository contains documentation and documentation build files only.

## Local development

### Prerequisites

- Node.js 18 or later
- Corepack

### Install dependencies

```bash
corepack enable
yarn install --immutable
```

### Development commands

| Command | Description |
| --- | --- |
| `yarn dev` | Start the documentation development server |
| `yarn lint` | Validate documentation content and configuration |
| `yarn build` | Build the production documentation site |
| `yarn serve` | Preview the production build locally |

## Contributing

Open a pull request against `main`. After the pull request is squash-merged, the reverse
sync workflow creates a corresponding pull request in the source repository.
