# artifacthub-shim Plugin 上架指南

本文记录 `artifacthub-shim` plugin chart 从 PR 流水线产物到目标平台上架的操作流程。内部环境优先使用快捷上架：确认 plugin chart 和镜像已经同步到目标 registry 后，直接在 global cluster 更新 `ModulePlugin`，由平台生成对应版本的 `ModuleConfig`。`violet` 大包流程只作为离线交付、无 global cluster 操作权限或自动生成 `ModuleConfig` 失败时的回退方案。

## 目标

- 等待 PR 触发的 `as-all-in-one` PipelineRun 完成。
- 从 `package-chart` 结果中获取 `plugin-chart-version`。
- 确认 plugin chart 和相关镜像已经同步到 `registry.alauda.cn:60070`。
- 内部环境通过 `ModulePlugin` 快捷上架新版本。
- 必要时使用 `violet push --skip-push` 回退更新平台侧上架信息。
- 区分“上架新版本”和“升级已安装实例”。

## 前置条件

本机需要具备以下命令。`violet` 只在回退流程中需要：

```bash
kubectl
helm
jq
skopeo
violet # optional, fallback only
```

按实际环境填写路径和目标。下面只保留示例值，不代表默认集群。快捷上架命令假设 `kubectl` 当前 context 已切到 global cluster；如使用显式 kubeconfig，请自行在相关 `kubectl` 命令里添加参数。

```bash
export PIPELINE_KUBECONFIG=/path/to/pipeline-kubeconfig
export PIPELINE_NAMESPACE=<pipeline-namespace>
export TARGET_KUBECONFIG=/path/to/target-cluster-kubeconfig
export TARGET_CLUSTER=<target-cluster-name>
export DEST_REPO='registry.alauda.cn:60070'
```

如果需要使用 Violet 回退流程，再填写平台访问参数。平台密码不要写入脚本或提交到仓库，交互式读取即可：

```bash
export PLATFORM_ADDRESS='https://<platform-host>'
export PLATFORM_USERNAME='<platform-username>'
read -rsp 'Platform password: ' PLATFORM_PASSWORD; echo
```

## 等待流水线完成

如果已知 PipelineRun 名称，例如 `as-all-in-one-b8ztf`：

```bash
export PIPELINE_RUN=as-all-in-one-b8ztf

kubectl --kubeconfig "$PIPELINE_KUBECONFIG" -n "$PIPELINE_NAMESPACE" \
  wait --for=condition=Succeeded "pipelinerun/$PIPELINE_RUN" --timeout=90m
```

如果 `wait` 失败，先查看整体状态和失败任务：

```bash
kubectl --kubeconfig "$PIPELINE_KUBECONFIG" -n "$PIPELINE_NAMESPACE" \
  get pipelinerun "$PIPELINE_RUN" \
  -o jsonpath='{.status.conditions[?(@.type=="Succeeded")].status}{"\n"}{.status.conditions[?(@.type=="Succeeded")].reason}{"\n"}{.status.conditions[?(@.type=="Succeeded")].message}{"\n"}'

kubectl --kubeconfig "$PIPELINE_KUBECONFIG" -n "$PIPELINE_NAMESPACE" \
  get taskruns -l "tekton.dev/pipelineRun=$PIPELINE_RUN" \
  -o custom-columns='NAME:.metadata.name,TASK:.metadata.labels.tekton\.dev/pipelineTask,STATUS:.status.conditions[?(@.type=="Succeeded")].status,REASON:.status.conditions[?(@.type=="Succeeded")].reason'

kubectl --kubeconfig "$PIPELINE_KUBECONFIG" -n "$PIPELINE_NAMESPACE" \
  get customruns -l "tekton.dev/pipelineRun=$PIPELINE_RUN" \
  -o custom-columns='NAME:.metadata.name,TASK:.metadata.labels.tekton\.dev/pipelineTask,STATUS:.status.conditions[?(@.type=="Succeeded")].status,REASON:.status.conditions[?(@.type=="Succeeded")].reason'
```

## 获取 Plugin Chart 版本

`package-chart` 通常是一个 CustomRun，名称为 `${PIPELINE_RUN}-package-chart`：

```bash
export PACKAGE_CHART_RUN="${PIPELINE_RUN}-package-chart"

kubectl --kubeconfig "$PIPELINE_KUBECONFIG" -n "$PIPELINE_NAMESPACE" \
  get customrun "$PACKAGE_CHART_RUN" -o json | jq '.status.results // []'
```

提取版本号：

```bash
export PLUGIN_VERSION="$(
  kubectl --kubeconfig "$PIPELINE_KUBECONFIG" -n "$PIPELINE_NAMESPACE" \
    get customrun "$PACKAGE_CHART_RUN" -o json |
    jq -r '.status.results[] | select(.name=="plugin-chart-version") | .value'
)"

echo "$PLUGIN_VERSION"
```

示例输出：

```text
v0.1.0-pr2.73.g341a90c
```

如果需要确认 plugin chart push 的 digest，可查看 `plugin-build-push` Pod 日志：

```bash
kubectl --kubeconfig "$PIPELINE_KUBECONFIG" -n "$PIPELINE_NAMESPACE" \
  logs "pod/${PACKAGE_CHART_RUN}-plugin-build-push-pod" \
  --all-containers=true --prefix=true | grep -E 'Pushed:|Digest:'
```

## 验证目标 Registry

上架时应使用 `registry.alauda.cn:60070` 作为目标 registry。先确认 chart 已经存在：

```bash
export CHART_REPO='devops/artifacthub-shim/charts/artifacthub-shim-plugin'
export CHART_REF="${DEST_REPO}/${CHART_REPO}:${PLUGIN_VERSION}"
export WORKDIR="$(mktemp -d "/tmp/artifacthub-shim-listing-${PLUGIN_VERSION}.XXXXXX")"

helm pull "oci://${DEST_REPO}/${CHART_REPO}" \
  --version "$PLUGIN_VERSION" \
  --destination "$WORKDIR"
```

建议同时拉取 build-harbor 上的同版本 chart，对比 digest：

```bash
helm pull "oci://build-harbor.alauda.cn/${CHART_REPO}" \
  --version "$PLUGIN_VERSION" \
  --destination "$WORKDIR/build-harbor"
```

## 验证关联镜像

从 chart values 中读取 API 镜像 tag：

```bash
export CHART_TGZ="${WORKDIR}/artifacthub-shim-plugin-${PLUGIN_VERSION}.tgz"

export API_TAG="$(
  tar -xOzf "$CHART_TGZ" artifacthub-shim-plugin/values.yaml |
    awk '/^[[:space:]]*api:/{in_api=1; next} in_api && /^[[:space:]]*catalog:/{in_api=0} in_api && /^[[:space:]]*tag:/{print $2; exit}'
)"

echo "$API_TAG"
```

确认 API 镜像存在：

```bash
skopeo inspect "docker://${DEST_REPO}/devops/artifacthub-shim/artifacthub-shim-api:${API_TAG}" |
  jq '{Name,Digest,Created,Architecture,Os}'
```

确认 catalog 镜像存在：

```bash
skopeo inspect "docker://${DEST_REPO}/devops/tektoncd/hub/catalog:v4.11.0-g8672a45" |
  jq '{Name,Digest,Created,Architecture,Os}'
```

## 检查 ModulePlugin 内容

确认 chart 内声明的版本正确：

```bash
tar -xOzf "$CHART_TGZ" artifacthub-shim-plugin/module-plugin.yaml |
  sed -n '1,140p'
```

重点检查：

- `spec.appReleases[].chartVersions[].version` 是否等于 `$PLUGIN_VERSION`。
- `spec.mainChart` 是否为 `devops/artifacthub-shim/charts/artifacthub-shim-plugin`。
- `values.yaml` 中 `global.registry.address` 是否为 `registry.alauda.cn:60070`。

## 内部环境快捷上架（推荐）

快捷上架只更新 global cluster 上的插件发布元数据，不负责复制 chart 或镜像。因此必须先完成前面 registry 验证，确保目标 registry 已经存在同版本 plugin chart 和关联镜像。

先确认当前 cluster 有 cluster plugin 发布态 CRD：

```bash
kubectl api-resources | grep -E 'moduleplugins|moduleconfigs|moduleinfoes'
```

应能看到 `moduleplugins.cluster.alauda.io`、`moduleconfigs.cluster.alauda.io` 和 `moduleinfoes.cluster.alauda.io`。如果没有这些资源，当前 context 不是可执行上架的 global cluster。

从 plugin chart 中提取 `ModulePlugin`：

```bash
export MODULE_PLUGIN_FILE="${WORKDIR}/artifacthub-shim-module-plugin-${PLUGIN_VERSION}.yaml"

tar -xOzf "$CHART_TGZ" artifacthub-shim-plugin/module-plugin.yaml \
  > "$MODULE_PLUGIN_FILE"
```

先做 server-side dry run，再实际更新：

```bash
kubectl apply --dry-run=server -f "$MODULE_PLUGIN_FILE"
kubectl apply -f "$MODULE_PLUGIN_FILE"
```

`ModulePlugin` 更新后，平台会根据 `spec.mainChart` 指向的 chart 和 chart 内的 `scripts/plugin-config.yaml` 生成当前版本的 `ModuleConfig`。等待目标版本出现：

```bash
export MODULE_CONFIG="artifacthub-shim-${PLUGIN_VERSION}"

kubectl wait --for=jsonpath='{.status.readyForDeploy}'=true \
  "moduleconfig/${MODULE_CONFIG}" \
  --timeout=5m
```

如果当前 `kubectl` 不支持该 `wait` 写法，可以轮询查看：

```bash
kubectl get moduleconfig "$MODULE_CONFIG" \
  -o jsonpath='{.metadata.name}{"\n"}{.spec.version}{"\n"}{.status.readyForDeploy}{"\n"}'
```

确认快捷上架结果：

```bash
kubectl get moduleplugin artifacthub-shim \
  -o jsonpath='{.status.latestVersion}{"\n"}'

kubectl get moduleconfig "$MODULE_CONFIG" -o json |
  jq '{
    name: .metadata.name,
    version: .spec.version,
    readyForDeploy: .status.readyForDeploy,
    chartVersions: [.spec.appReleases[]?.chartVersions[]? | {name, releaseName, version}]
  }'
```

重点检查：

- `ModulePlugin.status.latestVersion` 是否等于 `$PLUGIN_VERSION`。
- `ModuleConfig.metadata.name` 是否为 `artifacthub-shim-${PLUGIN_VERSION}`。
- `ModuleConfig.spec.version` 是否等于 `$PLUGIN_VERSION`。
- `ModuleConfig.spec.appReleases[].chartVersions[].version` 是否等于 `$PLUGIN_VERSION`。

## Violet 回退流程

仅在离线交付、无法直接操作 global cluster，或快捷上架没有生成 `ModuleConfig` 时使用 Violet 回退流程。回退流程会生成完整 Violet 包，耗时和磁盘占用都明显高于快捷上架。

### 生成完整 Violet 包

不要使用 `--skip-package-images` 生成轻量包。轻量包虽然 `violet push --skip-push` 可能返回成功，但前端升级下拉列表可能不会出现新版本。推荐生成完整包，再在 push 阶段使用 `--skip-push` 避免重复推送 registry 制品。

```bash
export PACKAGE_DIR="${WORKDIR}/artifacthub-shim-plugin-${PLUGIN_VERSION}"
export PACKAGE_FILE="${WORKDIR}/artifacthub-shim-plugin-${PLUGIN_VERSION}.tgz"

violet create "$PACKAGE_DIR" \
  --artifact="$CHART_REF" \
  --no-auth

violet package "$PACKAGE_DIR" \
  --no-auth \
  --output "$PACKAGE_FILE"

ls -lh "$PACKAGE_FILE"
violet show "$PACKAGE_FILE" --all
```

完整包通常约数百 MiB，因为其中包含 PackageManifest 数据和关联镜像层。

### 上架到平台

使用 `--skip-push`，只更新平台侧上架资源，不重复复制 chart/image 到 registry：

```bash
violet push "$PACKAGE_FILE" \
  --platform-address "$PLATFORM_ADDRESS" \
  --platform-username "$PLATFORM_USERNAME" \
  --platform-password "$PLATFORM_PASSWORD" \
  --clusters "$TARGET_CLUSTER" \
  --dest-repo "$DEST_REPO" \
  --force \
  --skip-push
```

成功时会看到类似输出：

```text
moduleplugin artifacthub-shim has been updated successfully
```

## 验证上架结果

快捷上架优先通过 global cluster 上的 `ModulePlugin` / `ModuleConfig` 验证：

```bash
kubectl get moduleplugin artifacthub-shim
kubectl get moduleconfigs -l cpaas.io/module-name=artifacthub-shim
kubectl get moduleconfig "artifacthub-shim-${PLUGIN_VERSION}" \
  -o jsonpath='{.spec.version}{"\n"}{.status.readyForDeploy}{"\n"}'
```

如果使用 Violet 回退流程，可以继续查看平台应用列表：

```bash
violet list \
  --platform-address "$PLATFORM_ADDRESS" \
  --platform-username "$PLATFORM_USERNAME" \
  --platform-password "$PLATFORM_PASSWORD" \
  --clusters "$TARGET_CLUSTER" \
  --output-file "${WORKDIR}/apps.yaml"

python3 - <<'PY'
import os
import yaml

with open(os.path.join(os.environ["WORKDIR"], "apps.yaml")) as f:
    data = yaml.safe_load(f)

print(yaml.safe_dump(
    {"artifacthub-shim": (data.get("applications") or {}).get("artifacthub-shim")},
    allow_unicode=True,
    sort_keys=False,
))
PY
```

注意：`violet list` 的 `installed.version` 表示当前已安装实例版本，不等于“最新已上架版本”。上架新版本不会自动升级已有实例。

查看目标集群当前已安装实例：

```bash
kubectl --kubeconfig "$TARGET_KUBECONFIG" -n cpaas-system \
  get apprelease artifacthub-shim -o json |
  jq '{
    specRevision:(.spec.source.charts[]? | select(.name=="devops/artifacthub-shim/charts/artifacthub-shim-plugin") | .targetRevision),
    installedRevision:.status.charts["devops/artifacthub-shim/charts/artifacthub-shim-plugin"].installedRevision,
    phase:.status.charts["devops/artifacthub-shim/charts/artifacthub-shim-plugin"].phase,
    conditions:.status.conditions
  }'
```

查看 workload：

```bash
kubectl --kubeconfig "$TARGET_KUBECONFIG" -n artifacthub-shim-system \
  get deploy,po -o wide
```

## 常见问题

### 是否可以像 operator 一样只创建 ArtifactVersion？

不可以。`ArtifactVersion` 是 operator/bundle 的上架资源，只包含 `present` 和 `tag` 这类制品版本信息。Cluster plugin 的发布态由 global cluster 上的 `ModulePlugin` 和 `ModuleConfig` 管理：

- `ModulePlugin` 定义插件基础信息、`mainChart` 和 chart 版本入口。
- `ModuleConfig` 是每个可安装版本的配置，包含 `config`、`deployDescriptors`、`valuesTemplates`、`appReleases` 等字段。
- `ModuleInfo` / `ClusterPluginInstance` 表示已安装实例，不用于发布新版本。

因此内部快捷上架应更新 `ModulePlugin`，并等待平台生成对应版本的 `ModuleConfig`。

### 快捷上架后没有生成 ModuleConfig

优先检查：

```bash
kubectl get moduleplugin artifacthub-shim -o yaml
kubectl get moduleconfigs -l cpaas.io/module-name=artifacthub-shim
```

常见原因：

- 当前 context 不是 global cluster。
- `spec.appReleases[].chartVersions[].version` 对应的 plugin chart 在目标 registry 不存在。
- plugin chart 内缺少 `scripts/plugin-config.yaml`。
- plugin-center 处理延迟或异常。

如果排查后仍未生成 `ModuleConfig`，使用本文 “Violet 回退流程” 重新上架。

### `violet push` 成功，但升级列表没有新版本

优先检查是否使用了轻量包：

```bash
ls -lh "$PACKAGE_FILE"
violet show "$PACKAGE_FILE" --all
```

如果包只有几 KiB，通常说明生成包时用了 `--skip-package-images`。重新按本文“生成完整 Violet 包”章节生成完整包，再执行 `violet push --skip-push`。

### `violet list` 没显示新版本

`violet list` 默认展示已安装应用和已安装版本。它不能直接证明某个新版本是否已经进入升级候选列表。判断上架是否成功应结合：

- `violet push` 是否返回 `moduleplugin artifacthub-shim has been updated successfully`。
- global cluster 中是否存在 `artifacthub-shim-${PLUGIN_VERSION}` 对应的 `ModuleConfig`。
- `violet show "$PACKAGE_FILE" --all` 中 `Version` 是否为目标版本。
- 前端升级弹窗的 `Target Version` 下拉列表是否出现目标版本。

### 目标集群 AppRelease 版本和平台列表不一致

目标集群 kubeconfig 只能反映业务集群内的实际安装状态；平台 API 可能通过 global 侧资源聚合安装状态。出现短时不一致时，以平台页面和 `violet list` 作为上架入口验证，以业务集群 `AppRelease` 作为实际 workload 安装状态验证。

### 上架不会自动升级已有实例

快捷上架或 `violet push` 都只负责把 plugin 版本上架为可选版本。已有 `ModuleInfo` / `ClusterPluginInstance` / `AppRelease` 不会因为上架动作自动升级。需要在平台 UI 中执行 Upgrade，或通过明确的升级流程修改安装实例。
