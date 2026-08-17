# Selective artifact transfer for an air-gapped plugin upgrade

This guide describes how to upgrade an existing `artifacthub-shim` Cluster
Plugin in a test or regression environment whose registry is isolated from the
build registry. It transfers only the plugin chart and the three images used by
the running workloads:

- `artifacthub-shim-api`
- `artifacthub-shim-extension`
- the built-in `catalog`

The chart also contains many `global.images.catalog_*` entries. Those entries
are an offline packaging inventory for Task tool images; the workload templates
do not run them. Do not copy that inventory when the regression scope needs
only the API, extension, and built-in catalog.

> This is a test-environment optimization, not a replacement for a complete
> Violet package or a release promotion. Do not use it to bypass a failed build
> or security gate unless the test owner explicitly accepts that the resulting
> installation is regression evidence only and is not release evidence.

## Preconditions

Install these CLIs:

```bash
kubectl
helm
jq
oras
skopeo
```

Prepare two Docker-compatible registry authentication files through the
environment's approved secret-management workflow. Keep them outside the
repository and restrict their permissions to the current user.

```bash
# Authentication file that can pull the build artifacts.
export SOURCE_AUTHFILE=/secure/path/source-auth.json

# Authentication file that can push to and inspect the isolated registry.
export TARGET_AUTHFILE=/secure/path/target-auth.json

chmod 600 "$SOURCE_AUTHFILE" "$TARGET_AUTHFILE"
```

Set the build and target inputs. The example derives the target registry and
installed `ModuleInfo` from the live global cluster instead of hard-coding
environment-specific addresses or object names.

```bash
# Kubeconfig and namespace that contain the source PipelineRun.
export PIPELINE_KUBECONFIG=/path/to/build-kubeconfig
export PIPELINE_NAMESPACE=<build-namespace>
export PIPELINE_RUN=<artifacthub-shim-build-pipelinerun>

# Global-cluster kubeconfig for the installation to upgrade.
export TARGET_KUBECONFIG=/path/to/global-cluster-kubeconfig

# Source registry and the catalog version selected for the regression.
export SOURCE_REGISTRY=registry-dev.alauda.io
export CATALOG_VERSION=<catalog-version>

# Resolve target values from the current installation.
export TARGET_REGISTRY="$(
  kubectl --kubeconfig "$TARGET_KUBECONFIG" -n cpaas-system \
    get apprelease artifacthub-shim \
    -o jsonpath='{.spec.source.repoURL}'
)"
export MODULEINFO_NAME="$(
  kubectl --kubeconfig "$TARGET_KUBECONFIG" \
    get moduleinfo -l cpaas.io/module-name=artifacthub-shim \
    -o jsonpath='{.items[0].metadata.name}'
)"
```

## 1. Record rollback state

Create a private working directory and save the platform inputs before changing
the registry or cluster:

```bash
# Private scratch directory for rollback manifests and logs.
export WORKDIR="$(mktemp -d /tmp/artifacthub-shim-selective.XXXXXX)"
chmod 700 "$WORKDIR"

kubectl --kubeconfig "$TARGET_KUBECONFIG" \
  get moduleplugin artifacthub-shim -o yaml \
  > "$WORKDIR/moduleplugin.before.yaml"

kubectl --kubeconfig "$TARGET_KUBECONFIG" \
  get moduleinfo "$MODULEINFO_NAME" -o yaml \
  > "$WORKDIR/moduleinfo.before.yaml"

kubectl --kubeconfig "$TARGET_KUBECONFIG" -n cpaas-system \
  get apprelease artifacthub-shim -o yaml \
  > "$WORKDIR/apprelease.before.yaml"
```

Do not commit this directory. The snapshots contain environment-specific
configuration even though they must not contain registry passwords.

## 2. Resolve authoritative image results

Require the API and extension build tasks to have succeeded. Read their image
references and immutable digests from TaskRun results rather than reconstructing
them from a branch name.

```bash
# Version produced by the source commit and PipelineRun.
export PLUGIN_VERSION="$(
  kubectl --kubeconfig "$PIPELINE_KUBECONFIG" -n "$PIPELINE_NAMESPACE" \
    get taskrun "${PIPELINE_RUN}-git-version" -o json |
    jq -r '.status.results[] | select(.name=="version") | .value'
)"

# API image reference and digest produced by buildctl.
export API_IMAGE="$(
  kubectl --kubeconfig "$PIPELINE_KUBECONFIG" -n "$PIPELINE_NAMESPACE" \
    get taskrun "${PIPELINE_RUN}-buildctl-api" -o json |
    jq -r '.status.results[] | select(.name=="IMAGE_URL") | .value'
)"
export API_DIGEST="$(
  kubectl --kubeconfig "$PIPELINE_KUBECONFIG" -n "$PIPELINE_NAMESPACE" \
    get taskrun "${PIPELINE_RUN}-buildctl-api" -o json |
    jq -r '.status.results[] | select(.name=="IMAGE_DIGEST") | .value'
)"

# Extension image reference and digest produced by buildctl.
export EXTENSION_IMAGE="$(
  kubectl --kubeconfig "$PIPELINE_KUBECONFIG" -n "$PIPELINE_NAMESPACE" \
    get taskrun "${PIPELINE_RUN}-buildctl-extension" -o json |
    jq -r '.status.results[] | select(.name=="IMAGE_URL") | .value'
)"
export EXTENSION_DIGEST="$(
  kubectl --kubeconfig "$PIPELINE_KUBECONFIG" -n "$PIPELINE_NAMESPACE" \
    get taskrun "${PIPELINE_RUN}-buildctl-extension" -o json |
    jq -r '.status.results[] | select(.name=="IMAGE_DIGEST") | .value'
)"
```

Confirm that every selected image is a complete multi-architecture index. The
target cluster may currently use only one architecture, but copying the whole
index prevents a later scheduling change from exposing a missing platform.

```bash
skopeo inspect --authfile "$SOURCE_AUTHFILE" --raw \
  "docker://${API_IMAGE}" |
  jq '[.manifests[]?.platform | {os,architecture,variant}]'

skopeo inspect --authfile "$SOURCE_AUTHFILE" --raw \
  "docker://${EXTENSION_IMAGE}" |
  jq '[.manifests[]?.platform | {os,architecture,variant}]'

skopeo inspect --authfile "$SOURCE_AUTHFILE" --raw \
  "docker://${SOURCE_REGISTRY}/alauda-pipelines-catalog/hub/catalog:${CATALOG_VERSION}" |
  jq '[.manifests[]?.platform | {os,architecture,variant}]'
```

Record each raw index digest before copying:

```bash
skopeo inspect --authfile "$SOURCE_AUTHFILE" --raw "docker://${API_IMAGE}" |
  sha256sum
skopeo inspect --authfile "$SOURCE_AUTHFILE" --raw "docker://${EXTENSION_IMAGE}" |
  sha256sum
skopeo inspect --authfile "$SOURCE_AUTHFILE" --raw \
  "docker://${SOURCE_REGISTRY}/alauda-pipelines-catalog/hub/catalog:${CATALOG_VERSION}" |
  sha256sum
```

## 3. Obtain the plugin chart

### Preferred: copy the chart built by the PipelineRun

When the cluster-plugin chart task succeeded, copy the OCI artifact directly.
The source and target repository paths may differ:

```bash
# Chart artifact produced by the component build.
export SOURCE_CHART_REF="${SOURCE_REGISTRY}/alauda-pipelines-catalog/artifacthub-shim/charts/artifacthub-shim-plugin:${PLUGIN_VERSION}"

# Existing ACP installation path in the isolated registry.
export TARGET_CHART_REF="${TARGET_REGISTRY}/devops/artifacthub-shim/charts/artifacthub-shim-plugin:${PLUGIN_VERSION}"

oras cp \
  --from-registry-config "$SOURCE_AUTHFILE" \
  --to-registry-config "$TARGET_AUTHFILE" \
  --to-insecure \
  "$SOURCE_CHART_REF" "$TARGET_CHART_REF"
```

### Test-only recovery: images exist but the chart task was skipped

A post-build gate can stop the PipelineRun after both images were pushed but
before `chart-build-cluster-plugin`. With explicit test-owner approval, rebuild
only the chart from the exact source commit:

1. Check out or archive the PipelineRun's exact Git SHA, not the moving branch.
2. Copy `charts/artifacthub-shim/` into a scratch chart directory.
3. Follow the `chart-build-cluster-plugin` `preScript` in `.tekton/build.yaml`:
   rename the chart to `artifacthub-shim-plugin`, then render
   `module-plugin.yaml.tmpl` and `scripts/plugin-config.yaml.tmpl` with the same
   plugin name, chart repository, release name, version, and supported-upgrade
   range.
4. Set `Chart.yaml` version/appVersion and update only
   `global.images.api`, `global.images.extension`, and `global.images.catalog`
   in `values.yaml` with the selected tags and recorded digests.
5. Run `helm lint` and `helm template`; inspect the three rendered workload
   image references.
6. Package and push the chart directly to the target chart repository.

Do not edit the source branch or claim that this locally assembled chart passed
the skipped gate. Keep the source SHA, image digests, chart digest, and explicit
test-only approval in the execution record.

## 4. Copy exactly the three runtime images

Preserve repository paths below the registry so the normal ACP registry-address
substitution continues to work.

```bash
# Repository paths below the source registry.
export API_PATH="${API_IMAGE#${SOURCE_REGISTRY}/}"
export EXTENSION_PATH="${EXTENSION_IMAGE#${SOURCE_REGISTRY}/}"

skopeo copy --all --preserve-digests --retry-times 3 \
  --src-authfile "$SOURCE_AUTHFILE" \
  --dest-authfile "$TARGET_AUTHFILE" \
  --dest-tls-verify=false \
  "docker://${API_IMAGE}" \
  "docker://${TARGET_REGISTRY}/${API_PATH}"

skopeo copy --all --preserve-digests --retry-times 3 \
  --src-authfile "$SOURCE_AUTHFILE" \
  --dest-authfile "$TARGET_AUTHFILE" \
  --dest-tls-verify=false \
  "docker://${EXTENSION_IMAGE}" \
  "docker://${TARGET_REGISTRY}/${EXTENSION_PATH}"

skopeo copy --all --preserve-digests --retry-times 3 \
  --src-authfile "$SOURCE_AUTHFILE" \
  --dest-authfile "$TARGET_AUTHFILE" \
  --dest-tls-verify=false \
  "docker://${SOURCE_REGISTRY}/alauda-pipelines-catalog/hub/catalog:${CATALOG_VERSION}" \
  "docker://${TARGET_REGISTRY}/alauda-pipelines-catalog/hub/catalog:${CATALOG_VERSION}"
```

Do not iterate over all keys below `global.images`. In particular, do not copy
keys whose names begin with `catalog_`; they are package-discovery metadata and
are not referenced by the Deployments.

Repeat the raw-manifest inspection against the target registry. Require the
same index digest and the same platform set as the source for all three images.
Also pull the target chart with Helm and confirm that its values contain the
expected API, extension, and catalog tags and digests.

## 5. Publish the version without replacing target metadata

The chart can contain a `module-plugin.yaml` rendered with the source chart
repository. Do not apply it directly when the isolated environment already uses
a different target chart path. Patch only the version in the existing
`ModulePlugin`, preserving its `mainChart`, labels, annotations, and risk text.

```bash
# Version-only ModulePlugin patch that retains the target chart repository.
export MODULEPLUGIN_PATCH="$(
  jq -cn --arg version "$PLUGIN_VERSION" '{
    spec:{appReleases:[{
      name:"artifacthub-shim",
      chartVersions:[{
        name:"devops/artifacthub-shim/charts/artifacthub-shim-plugin",
        releaseName:"artifacthub-shim",
        version:$version
      }]
    }]}
  }'
)"

kubectl --kubeconfig "$TARGET_KUBECONFIG" \
  patch moduleplugin artifacthub-shim --type merge \
  -p "$MODULEPLUGIN_PATCH" --dry-run=server -o yaml

kubectl --kubeconfig "$TARGET_KUBECONFIG" \
  patch moduleplugin artifacthub-shim --type merge \
  -p "$MODULEPLUGIN_PATCH"
```

Wait for `artifacthub-shim-${PLUGIN_VERSION}` to exist and report
`status.readyForDeploy=true`.

### Check the values-template repository alias

When the chart was copied from `alauda-pipelines-catalog/...` to `devops/...`,
the generated `ModuleConfig.spec.appReleases` can use the target path while
`spec.valuesTemplates` still contains only the source path. Compare the keys:

```bash
# Versioned configuration generated from the newly published chart.
export MODULECONFIG_NAME="artifacthub-shim-${PLUGIN_VERSION}"

kubectl --kubeconfig "$TARGET_KUBECONFIG" \
  get moduleconfig "$MODULECONFIG_NAME" -o json |
  jq '{
    chartNames:[.spec.appReleases[]?.chartVersions[]?.name],
    valueTemplateKeys:(.spec.valuesTemplates|keys)
  }'
```

If the target chart path is absent, copy the source template to an additional
target-path key before upgrading. Keep the source key as well:

```bash
# Source and target keys for the same values template.
export SOURCE_TEMPLATE_KEY=alauda-pipelines-catalog/artifacthub-shim/charts/artifacthub-shim-plugin
export TARGET_TEMPLATE_KEY=devops/artifacthub-shim/charts/artifacthub-shim-plugin

# Existing generated template content.
export VALUES_TEMPLATE="$(
  kubectl --kubeconfig "$TARGET_KUBECONFIG" \
    get moduleconfig "$MODULECONFIG_NAME" -o json |
    jq -r --arg key "$SOURCE_TEMPLATE_KEY" '.spec.valuesTemplates[$key]'
)"

# Merge patch adds the alias without deleting the source key.
export MODULECONFIG_PATCH="$(
  jq -cn --arg key "$TARGET_TEMPLATE_KEY" --arg value "$VALUES_TEMPLATE" \
    '{spec:{valuesTemplates:{($key):$value}}}'
)"

kubectl --kubeconfig "$TARGET_KUBECONFIG" \
  patch moduleconfig "$MODULECONFIG_NAME" --type merge \
  -p "$MODULECONFIG_PATCH" --dry-run=server -o yaml

kubectl --kubeconfig "$TARGET_KUBECONFIG" \
  patch moduleconfig "$MODULECONFIG_NAME" --type merge \
  -p "$MODULECONFIG_PATCH"
```

## 6. Upgrade and verify

Upgrade the existing instance by changing only `spec.version`. The chart
already contains the selected catalog tag, so keep the current plugin config
and values overrides unchanged.

```bash
kubectl --kubeconfig "$TARGET_KUBECONFIG" \
  patch moduleinfo "$MODULEINFO_NAME" --type merge \
  -p "$(jq -cn --arg version "$PLUGIN_VERSION" '{spec:{version:$version}}')" \
  --dry-run=server -o yaml

kubectl --kubeconfig "$TARGET_KUBECONFIG" \
  patch moduleinfo "$MODULEINFO_NAME" --type merge \
  -p "$(jq -cn --arg version "$PLUGIN_VERSION" '{spec:{version:$version}}')"
```

Require all of these checks to pass:

- `ModuleInfo.status.phase` is `Running` and `status.version` is the target.
- Every `ModuleInfo.status.appReleases` entry is ready, synced, and not failed.
- The `cpaas-system/artifacthub-shim` AppRelease installed revision is the
  target version and its chart phase is `Success`.
- Both Deployments complete their rollout with all replicas ready.
- Running Pod image tags and image IDs match the transferred API, extension,
  and catalog artifacts.
- API `/healthz` and `/readyz` succeed through the Kubernetes Service proxy.
- API and extension logs contain no new startup, image-pull, or catalog-load
  errors.

Example health checks that do not require a local port-forward:

```bash
kubectl --kubeconfig "$TARGET_KUBECONFIG" --request-timeout=20s get --raw \
  '/api/v1/namespaces/artifacthub-shim-system/services/http:artifacthub-shim-api:80/proxy/healthz'

kubectl --kubeconfig "$TARGET_KUBECONFIG" --request-timeout=20s get --raw \
  '/api/v1/namespaces/artifacthub-shim-system/services/http:artifacthub-shim-api:80/proxy/readyz'
```

## Rollback

If the new `ModuleConfig` is not ready, restore the old `ModulePlugin` version
before changing `ModuleInfo`. If the workload upgrade fails, patch
`ModuleInfo.spec.version` back to the version recorded in
`moduleinfo.before.yaml` and wait for it to return to `Running`.

Do not delete the newly copied tags during incident recovery. Leaving immutable,
unused artifacts in the isolated registry is safer than deleting a tag that a
controller or another regression run may still reference.

## What this workflow deliberately avoids

- No `violet create` or `violet package`; those operations discover the full
  `catalog_*` inventory and produce the large offline package.
- No bulk copy of every image in chart values.
- No direct edit of the derived AppRelease or Deployments.
- No direct application of source-repository `module-plugin.yaml` over an
  existing target-repository `ModulePlugin`.
- No credentials in command history, logs, repository files, or MR content.
