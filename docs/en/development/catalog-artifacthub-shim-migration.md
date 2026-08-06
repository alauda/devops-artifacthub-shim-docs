# Catalog 迁移到 artifacthub-shim 改造指南

正式用户文档入口见 [Catalog](../catalog/index.mdx)。本文保留为 catalog
维护和迁移开发检查清单。

本文面向 catalog 维护者，说明 catalog 正式迁移到 `artifacthub-shim` 后需要完成的目录、元数据、镜像发现和验收改造。`artifacthub-shim` 不会在运行时重写 catalog manifest；迁移质量主要由 catalog 仓库本身保证。

## 目录结构改造

资源版本目录遵循 `{kind}/{name}/{version}/{name}.yaml`。同目录必须放置 `README.md`，作为 UI 和 API 展示该版本说明的来源。

推荐结构：

```text
task/
  run-script/
    0.1/
      README.md
      run-script.yaml
pipeline/
  build-deploy/
    0.2/
      README.md
      build-deploy.yaml
stepaction/
  echo-message/
    0.1/
      README.md
      echo-message.yaml
```

当前 `artifacthub-shim` 不要求也不读取 `artifacthub-repo.yml`。内置 catalog 的 resolver-facing repository 名称来自 shim source 配置，而不是目录中的 metadata 文件：

- `task` -> `catalog`
- `pipeline` -> `catalog-pipelines`
- `stepaction` -> `catalog-stepactions`

这些 source 名称发布后必须保持稳定。修改 source 名称会改变 resolver 引用和 UI detail URL，应按迁移处理，而不是普通重命名。

当前 Alauda catalog 还没有 `stepaction/` 目录时，可以先只迁移 `task/` 和 `pipeline/`。`artifacthub-shim` 仅在目录存在时注册可选的内置 StepAction source；Task source 需要继续使用历史 Tekton Hub 默认名称 `catalog`。

## Manifest Annotation 要求

Task、Pipeline、StepAction manifest 需要保留或补齐现有 Tekton 展示 annotation：

- `tekton.dev/displayName`
- `tekton.dev/tags`
- `tekton.dev/platforms`
- `tekton.dev/pipelines.minVersion`

同时补充 Artifact Hub 相关 annotation。最低要求是为每个版本提供：

```yaml
metadata:
  annotations:
    artifacthub.io/license: Apache-2.0
    artifacthub.io/category: integration-delivery
```

`artifacthub.io/category` 使用 Artifact Hub 支持的单一分类值，例如 `integration-delivery`、`security`、`monitoring-logging`、`storage` 等；如果资源确实不适合任何分类，可以使用 `skip-prediction`，避免 Artifact Hub 自动预测出错误分类。

弃用版本需要显式标记：

```yaml
metadata:
  annotations:
    artifacthub.io/deprecated: "true"
```

`spec.description` 和同版本目录中的 `README.md` 继续作为 UI/API 展示内容来源。manifest 中已有的 `style.tekton.dev/descriptors` 必须原样保留；`artifacthub-shim` 不会重写动态表单，也不会把 descriptor 自动迁移成新的 schema。

## Artifact Hub 元数据文件

`artifacthub-repo.yml` 对当前 `artifacthub-shim` 是可选文件。shim 的 filesystem provider 会跳过 source 根目录下的普通文件，只扫描 package/version 目录；repository 名称、展示名称和 kind 均来自 source 配置。

如果后续需要直接接入 upstream Artifact Hub，可以再按官方 Artifact Hub 规范补充 `artifacthub-repo.yml`。在实现读取逻辑之前，不要依赖该文件改变 resolver catalog、UI list label 或 detail URL。

版本目录存在归一化冲突规则：`0.1` 与 `0.1.0` 会被视为同一个 SemVer 版本。相同 repository、kind、name 下不能同时发布 `0.1` 和 `0.1.0`，否则 resolver lookup 会出现歧义，`artifacthub-shim` 会拒绝对应 source 的候选快照。

## 镜像发现 ConfigMap 改造

继续维护 `config/images` 下的 tool-image ConfigMap。数据源仍然是 `kube-public` namespace 中的 ConfigMap；UI 动态表单通过 label selector 查询这些 ConfigMap，并读取 `data.name`、`data.image` 生成镜像下拉候选。

tool-image ConfigMap 的 `metadata.name`、`catalog.tekton.dev/*` labels 和 descriptor 中的 `labelSelector` 应保持一致，确保 UI 动态表单能通过现有 selector 发现镜像候选。

所有需要由 artifacthub-shim 从 catalog `config` 目录导入集群的 ConfigMap，都必须显式添加导入标签：

```yaml
metadata:
  labels:
    artifacthub-shim.alauda.io/import: "true"
```

未带该标签的 ConfigMap、非 ConfigMap 资源和其他 YAML 文件会被 artifacthub-shim 直接跳过，不会同步到集群。

需要长期保留的镜像 ConfigMap 按需添加：

```yaml
metadata:
  annotations:
    artifacthub-shim.alauda.io/resource-policy: keep
```

这能保证该 ConfigMap 曾经被 artifacthub-shim 管理后，即使后续从新版本 catalog 的 `config` 目录中删除，运行时 prune 也不会删除集群里已有的旧 ConfigMap。`helm.sh/resource-policy: keep` 不再用于 catalog ConfigMap 生命周期，因为这些资源不再由 Helm 普通资源渲染。

artifacthub-shim 会从内置 catalog 镜像复制后的 `config` 目录递归读取带 `artifacthub-shim.alauda.io/import: "true"` 的 ConfigMap YAML，并跳过 `kustomization.yaml`。如果集群里已经存在同名且非 artifacthub-shim 托管的 ConfigMap，artifacthub-shim 会跳过该资源，不会接管或覆盖。

catalog 仓库应通过发布门禁长期校验这些规则：

```bash
make verify-artifacthub-shim-metadata
```

该门禁应至少覆盖：

- `config/images` 中除 `kustomization.yaml` 之外的 YAML 均为带 import label 的 `v1/ConfigMap`。
- 非 `latest` 的 tool-image ConfigMap 带 `artifacthub-shim.alauda.io/resource-policy: keep`。
- tool-image ConfigMap 保留 `catalog.tekton.dev/tool-image-*` labels。
- `config/templates` 下同步到集群的模板 ConfigMap 带 import label 和 keep annotation。
- 正式 `task/`、`pipeline/`、`stepaction/` manifest 带最低限度的 Artifact Hub annotations。

## Overview Template ConfigMap 改造

overview-template ConfigMap 继续使用现有 `metadata.name` 和 labels：

- `style.tekton.dev/overview-template-task`
- `style.tekton.dev/overview-template-task-version`
- `style.tekton.dev/overview-template-engine`

UI 和后端查询继续依赖这些 labels 查找 overview template，不应依赖 ConfigMap 名称。

需要长期保留的 overview-template ConfigMap 按需添加：

```yaml
metadata:
  annotations:
    artifacthub-shim.alauda.io/resource-policy: keep
```

mail template ConfigMap 同样保持现有 `metadata.name`、`tekton.alaudadevops.io/*` 和 `style.tekton.dev/descriptors` labels/annotations；需要长期保留时按需添加 `artifacthub-shim.alauda.io/resource-policy: keep`。

## 验收清单

- resolver 能通过 `catalog`、`catalog-pipelines`、`catalog-stepactions` 读取资源。
- UI 能展示 README、`spec.description`、annotations 和 versions。
- 动态表单镜像下拉能通过现有 label selector 展示 tool-image ConfigMap 候选。
- 所有需要从 catalog `config` 目录同步到集群的 ConfigMap 都带有 `artifacthub-shim.alauda.io/import: "true"` label。
- tool-image ConfigMap 按需添加 `artifacthub-shim.alauda.io/resource-policy: keep`。
- overview-template 和 mail template 保持现有 `metadata.name` 与 selector labels，并按需添加 `artifacthub-shim.alauda.io/resource-policy: keep`。
- 删除新版本 catalog 中带 `artifacthub-shim.alauda.io/resource-policy: keep` 语义的 ConfigMap 后，升级仍保留集群里的旧 ConfigMap。
- 同一个 package 下不存在 `0.1` 与 `0.1.0` 这类归一化冲突版本。
- `make verify-artifacthub-shim-metadata` 通过。
