---
title: Tekton Hub 下线并切换到 artifacthub-shim
status: proposed
creation-date: "2026-06-15"
last-updated: "2026-06-17"
authors:
  - Alauda DevOps
---

# Tekton Hub 下线并切换到 artifacthub-shim

## Summary

本设计要求从 ACP DevOps 4.13 起，将默认 Hub 数据源从 Tekton Hub 切换到 `artifacthub-shim`。同时，仍维护的 LTS 分支也需要移除以下运行时依赖：

- Tekton Hub
- `tektoncd-hubs-api`
- `hubs-wrapper`
- operator 内置 catalog runtime

目标状态如下：

- 标准集群安装 `artifacthub-shim` 后，Tekton hub resolver、Pipelines as Code remote annotation、DevOps UI 的 Hub Task/Pipeline/StepAction 展示都默认访问集群内 shim 服务。
- catalog、tool image ConfigMap、overview/mail template 等资源随 `artifacthub-shim` 侧发布。
- Tekton Operator 不再维护 Tekton Hub runtime 和 catalog runtime。

迁移需要分为四条主线并行推进：

- `artifacthub-shim`：提供稳定服务、Ingress rewrite 入口、Artifact Hub API 子集、UI 兼容 API 和 catalog 资源同步。
- `tektoncd-operator`：移除 Tekton Hub runtime，更新 resolver/PAC 默认值，保留必要的历史资源清理能力。
- `catalog`：改为由 `artifacthub-shim` 发布链路维护，迁移镜像仓库、元数据和测试归属。
- `pipeline-v2-frontend`：保持现有 `/hub` 网关入口，在 shim 不可用时给出可理解的降级和安装指引。

## Motivation

当前 Tekton Hub 在产品中承担两类职责：

- 给 Tekton hub resolver 和 PAC remote annotation 提供远程 Task/Pipeline 定义。
- 通过 `tektoncd-hubs-api` / `hubs-wrapper` 给 DevOps UI 提供 Hub 资源列表和详情。

这个模型带来两个问题：

- operator、catalog、UI 和 Tekton Hub runtime 强耦合。
- air-gap 环境下的默认链路依赖一套不再计划长期维护的组件。

`artifacthub-shim` 已经具备以下能力：

- 本地 catalog 索引
- Artifact Hub 兼容 API
- UI 兼容 API
- ConfigMap 额外资源同步
- ACP RBAC 集成

将默认入口切到 shim 可以带来以下收益：

- 减少运行时组件。
- 降低 operator 发布和 catalog 发布的耦合。
- 避免默认访问公网 `artifacthub.io` 或 `api.hub.tekton.dev`。
- 为后续把 catalog 能力独立成插件提供基础。

## Goals

- 4.13 标准部署中不再部署 Tekton Hub、`tektoncd-hubs-api`、`hubs-wrapper` 和 operator 内置 catalog runtime。
- 4.0、4.2、4.6、4.10 等 LTS 维护分支也移除 Tekton Hub runtime 依赖；经历史分支 `components.yaml` 和对应源码确认，这些分支的 Tekton Pipelines hub resolver 均支持 Artifact Hub 模式，应默认切到 `type: artifact`。
- `resolver: hub` 在新版本默认走 Artifact Hub 模式，默认值如下：
  - Task catalog：`catalog`
  - Pipeline catalog：`catalog-pipelines`
  - API：`http://artifacthub-shim-api.artifacthub-shim-system.svc.cluster.local/`
- PAC 默认 remote task hub 配置指向集群内 `artifacthub-shim`，显式设置 `hub-catalog-type: artifacthub`，不依赖 PAC 对 `/api/v1/stats` 的自动探测。
- UI 仍能通过 `/hub/api/v1alpha1/*` 列出、预览和选择 Hub Task/Pipeline/StepAction；`/hub` 前缀由单独的 hub Ingress/网关 rewrite 去掉，shim 自身只提供 canonical API。
- catalog 中的 tool image、overview template、mail template 等配套资源随 `artifacthub-shim` 交付，并保留 UI 动态表单依赖的 selector labels。
- 明确 send-mail 等依赖 `tektoncd-enhancement` 的 catalog Task 的能力边界，并按 Phase B 将 template-render 迁到 `artifacthub-shim` 仓库内的独立通用扩展服务。
- 明确各仓库需要新增、修改、删除或迁移的文档，以及 operator e2e 与 catalog e2e 的新归属。

## Non-Goals

- 不保留 Tekton Hub 与 `artifacthub-shim` 的长期双运行时共存；兼容期只允许为升级清理、历史 resolver 或 PAC 行为提供最小兜底。
- 不把 `artifacthub-shim` 做成完整 Artifact Hub 实现；只覆盖 Tekton resolver、PAC 和 DevOps UI 需要的 API 子集。
- 不要求 shim API 实现 `/hub/**` 路由；`/hub` 是 UI 网关入口，由单独的 hub Ingress/网关 rewrite 去掉前缀后转发到 `/api/v1alpha1/*` 或 `/readyz`。
- 不在本次迁移中改变 catalog Task/Pipeline 的用户可见语义；镜像仓库名前缀变化不触发 Task/Pipeline 版本升级。
- 不把 template-render webhook 强行并入 `artifacthub-shim` API 进程。解除 catalog 与 `tektoncd-enhancement` 的耦合时，应作为 `artifacthub-shim` 仓库内的独立通用扩展服务设计。

## Requirements

- Air-gap first：默认配置不得访问公网 `artifacthub.io`、`api.hub.tekton.dev` 或 GitHub。
- 开箱即用：按标准插件方式安装 `artifacthub-shim` 到 `artifacthub-shim-system`，release name 保持 `artifacthub-shim` 时，Tekton Operator 默认配置无需用户手工修改即可解析内置 catalog。
- 自定义可配置：如果用户自定义 `artifacthub-shim` 的 namespace 或 release name，shim 文档需要明确如何更新 `TektonConfig` 和 PAC settings；operator 默认值不为所有自定义安装位置做自动发现。
- 向后兼容：已有 `resolver: hub` 的 TaskRun/PipelineRun 尽量继续工作。Task 默认 catalog 保持 `catalog`，Pipeline 默认 catalog 改为 `catalog-pipelines`。
- 对历史 `pipeline + catalog` 引用提供兼容策略或清晰 troubleshooting。
- 失败可理解：UI 必须区分未安装/路由不存在、服务未 ready、无权限、网络异常和资源不存在。Task 列表和 Pipeline 编排选择 Task 时，Hub 不可用不能影响 namespace Task 和 CustomRun 的展示。
- 可回滚：operator 升级迁移只覆盖空值和可明确识别的旧集群内 Tekton Hub Service URL，不覆盖公网 Hub URL、用户自定义 hub URL、catalog 或 additional catalogs。
- 可测试：catalog 单主分支发布必须覆盖当前正式 operator 与 LTS 分支的兼容矩阵；operator e2e 不再默认依赖完整 catalog 行为测试。

## Current State

### artifacthub-shim

`artifacthub-shim` 当前已经提供核心 API 能力：

- health/ready/metrics：`/healthz`、`/readyz`、`/metrics`
- Artifact Hub API 子集：`/api/v1/packages/search`、`/api/v1/packages/...`
- UI 兼容 API：`/api/v1alpha1/tasks`、`/api/v1alpha1/pipelines`、`/api/v1alpha1/stepactions`、`/api/v1alpha1/{catalog}/{kind}/{name}/{version}`
- legacy raw manifest API：`/v1/resource/{catalog}/{kind}/{name}/{version}/yaml`

默认内置 source 如下：

- Task：`catalog`
- Pipeline：`catalog-pipelines`
- StepAction：存在 `stepaction/` 目录时注册 `catalog-stepactions`

标准插件安装约定如下：

- namespace：`artifacthub-shim-system`
- release name：`artifacthub-shim`
- Service：`artifacthub-shim-api`
- FQDN：`artifacthub-shim-api.artifacthub-shim-system.svc.cluster.local`

因此，固定服务名不是 P0 缺口。真正需要补齐的是：

- 自定义 namespace/release name 时，如何修改 TektonConfig 与 PAC 的配置文档。
- DevOps UI 需要的 `/hub(/|$)(.*)` rewrite 入口。

chart 已有通用 Ingress 模板，但 `ingress.enabled` 默认关闭，当前默认 path 也不是 DevOps UI 需要的 `/hub(/|$)(.*)` rewrite 入口。本次 UI API 应新增独立的 hub Ingress 配置，不复用既有通用 ingress，避免与其他暴露场景混在一起。

当前 root `values.yaml` 和 `charts/artifacthub-shim/values.yaml` 中，catalog/tool image 仓库前缀仍有大量 `devops/tektoncd/hub/*`。

这会让 shim 虽然承担新发布链路，但镜像命名仍表现为 Tekton Hub 归属；镜像命名迁移后续跟 catalog 归属迁移一起统一处理，本轮不改默认镜像仓库。

### tektoncd-operator

operator 当前仍包含 Tekton Hub runtime 交付入口：

- `components.yaml` 注册 `hubs-wrapper`、`tektoncd-hub`、`catalog`。
- `config/tekton-pipeline/kustomization.yaml` 引入 `hubs-wrapper.yaml`。
- `config/tekton-hub/**` 保存 Tekton Hub api/db/ui/db-migration/hub-info 相关 manifest。
- `values.yaml` 仍含 `catalog_*`、`tektoncd-hub_*`、`hubs-wrapper_*` 镜像。
- `hack/update_components.sh` 对 Tekton Hub 和 catalog 有专门处理。
- `devspace.yaml` 仍有旧 e2e 强制启用 TektonHub 的逻辑。

resolver 默认配置来源不是 operator 手写的 release 产物，而是从 `tektoncd-pipeline` 的 `config/pipeline/resolver-patch.yaml` 自动同步。目前该 patch 仍设置：

- `default-type: tekton`
- `default-tekton-hub-catalog: catalog`
- `tekton-hub-api: http://tekton-hub-api.tekton-pipelines:8000/`
- `artifact-hub-api: https://artifacthub.io/`
- remote resolver Deployment 中的 `TEKTON_HUB_API`

同时，当前 hub resolver 代码还有两个前置约束：

- `populateDefaultParams` 要求 `default-kind` 存在。
- `resolveCatalogName` 即使请求是 Artifact Hub 类型，也会先要求 `default-tekton-hub-catalog` 存在。

因此本次不删除 `default-kind` 和 `default-tekton-hub-catalog`，而是在默认配置中继续补齐这两个 key；没有必要为此修改 hub resolver 源码。

PAC 默认配置来源也不应在 operator vendored 产物里直接修改，而应从以下位置处理：

- `tektoncd-pipelines-as-code` 的 `config/pac/release.yaml`
- `config/pac/patch-*.yaml` 中表达的默认配置 patch

当前 PAC 仍存在这些问题：

- 默认 URL 仍是公网 Artifact Hub。
- 4.10/main 使用的 PAC 0.39 有 Artifact Hub provider，但默认 catalog 为空或 `default` 时仍会 fallback 到 `tekton-catalog-tasks` / `tekton-catalog-pipelines`。
- 4.0、4.2、4.6 使用的 PAC 0.32/0.36 只有 Tekton Hub legacy client，PAC remote Hub annotation 无法只靠配置对接 Artifact Hub。
- operator 的 `preUpgradePipelinesAsCodeArtifacts` 已存在，但当前未注册到 pre-upgrade 函数列表。
- 当前迁移目标是公网 `https://artifacthub.io`，不符合 air-gap 目标。

`TektonHub` CRD/API/controller 仍注册在 Kubernetes 和 OpenShift platform controller map 中。

controller 的 `FinalizeKind` 会删除 `operator.tekton.dev/created-by=TektonHub` 的 InstallerSet 并清理 finalizer。

如果后续直接删除 controller 或 CRD，已有带 finalizer 的 `TektonHub` CR 可能无法删除。4.12 不是用户升级的必经版本，因此所有目标 LTS 和 main/4.13 都需要带上可直接执行的清理逻辑。

### catalog

catalog 中仍有旧镜像前缀和 Tekton Hub 归属假设：

- `values.yaml`、Task/Pipeline manifest、README、samples、testdata、`.tekton/images`、`config/images` 中存在 `devops/tektoncd/hub/*`。
- tool-image ConfigMap 依赖 `catalog.tekton.dev/tool-image-*` labels，UI 动态表单通过这些 labels 查询镜像候选。
- send-mail、overview template、mail template 等配套资源当前与 operator enhancement 和 operator 安装链路存在耦合。

`artifacthub-shim` 已有 catalog 迁移开发文档，定义了从 catalog `config` 目录导入 ConfigMap 的规则：

- 导入标签：`artifacthub-shim.alauda.io/import: "true"`
- 保留策略：`artifacthub-shim.alauda.io/resource-policy: keep`

这些规则需要从开发说明提升到正式维护文档和发布门禁中。

### pipeline-v2-frontend

UI 当前继续通过以下路径访问 Hub 资源：

- `/hub/api/v1alpha1/tasks`
- `/hub/api/v1alpha1/pipelines`
- `/hub/api/v1alpha1/{catalog}/{kind}/{name}/{version}`

这些路径不需要在 P0 改成 `/api/v1alpha1/*`。原因是 `/hub` 是 ACP 网关/Ingress 的稳定入口，后端切到 shim 后仍应由 rewrite 去掉 `/hub` 前缀。需要改的是后端服务目标和错误体验，而不是 shim API 的路由前缀。

不同 UI 场景的降级方式不同：

- Pipeline 列表有单独的 Hub tab；如果访问 `/hub/api/v1alpha1/*` 失败，Hub tab 可以整块展示“未检测到可用 Hub 服务，请安装或检查 artifacthub-shim”的提示，并提供全局集群部署或自定义安装位置的文档链接。
- Task 列表、TaskRun 表单、Pipeline 编排选择 Task 的表单会把 namespace Task、CustomRun 和 Hub Task 混在一起；Hub 不可用时只能降级 Hub 来源，不能让本地 Task 和 CustomRun 消失。

## Community and Upstream Findings

Tekton hub resolver 支持通过 `resolver: hub`、`type: artifact` 访问 Artifact Hub 兼容 API。相关参数包括：

- `catalog`
- `type`
- `kind`
- `name`
- `version`

这里的 `catalog` 是 TaskRun/PipelineRun 中 hub resolver params 的显式参数。用户显式写 `resolver: hub` 时，PAC 不会覆盖这个参数。

社区通过两个 Artifact Hub repository 解决 Task 和 Pipeline 不能注册到同一个 catalog 的问题，默认 repository 名分别是 `tekton-catalog-tasks` 和 `tekton-catalog-pipelines`。但 ACP 现有用户、UI 和 shim 默认 source 使用 `catalog` / `catalog-pipelines`，所以不应直接采用社区默认 repository 名。

PAC remote annotation 是另一条链路。`pipelinesascode.tekton.dev/task` 和 `pipelinesascode.tekton.dev/pipeline` 中的普通名字不会携带 resolver `catalog` 参数，而是使用 PAC ConfigMap 中的默认 Hub settings。`hub-catalog-name` 只影响 PAC remote annotation 的默认 Artifact Hub repository，不影响用户显式编写的 hub resolver params。

PAC 的 Artifact Hub client 会在 `hub-url` 后自动追加 `/api/v1`，因此默认 PAC 配置需要注意：

- `hub-url` 应写为 `http://artifacthub-shim-api.artifacthub-shim-system.svc.cluster.local`，不要写公网地址。
- 如果缺失 `hub-catalog-type`，PAC 会尝试请求 `/api/v1/stats` 判断类型。
- shim 当前不需要实现 `/api/v1/stats`。
- 标准配置必须显式写 `hub-catalog-type: artifacthub`，避免自动探测失败后回退到 Tekton Hub 类型。
- 如果 `hub-catalog-name` 为空或 `default`，PAC Artifact Hub client 会按 kind 使用社区默认 repository：Task 请求 `tekton-catalog-tasks`，Pipeline 请求 `tekton-catalog-pipelines`。
- 标准配置需要显式写 `hub-catalog-name: catalog`，避免 Task remote annotation 落到社区默认 `tekton-catalog-tasks`。PAC settings 没有 `hub-task-catalog-name` / `hub-pipeline-catalog-name` 这样的分 kind 默认配置，因此 Pipeline remote annotation 也会请求 `catalog`；shim 侧需要保留 `pipeline/catalog -> catalog-pipelines` fallback。

Artifact Hub Tekton metadata 主要通过 `artifacthub.io/*` annotations 表达，例如：

- `artifacthub.io/license`
- `artifacthub.io/category`
- `artifacthub.io/deprecated`

Tekton hub resolver 当前没有 StepAction 默认 catalog 配置项，StepAction 引用仍应显式传 `catalog: catalog-stepactions`。

参考：

- Tekton Hub Resolver: https://tekton.dev/docs/pipelines/hub-resolver/
- Artifact Hub package annotations: https://artifacthub.io/docs/topics/annotations/
- Artifact Hub Tekton package kind: https://artifacthub.io/packages/search?kind=7

## 历史版本兼容矩阵

历史分支能力从 `tektoncd-operator` 各分支的 `components.yaml` 获取，并用对应 `tektoncd-pipeline` / `tektoncd-pipelines-as-code` 提交源码复核。

| ACP 分支 | Tekton Pipelines | hub resolver Artifact 模式 | Pipelines as Code | PAC Artifact Hub 支持 | 推荐接入方式 |
| --- | --- | --- | --- | --- | --- |
| 4.0 | release-0.65 | 支持 | release-0.32 | 不支持，只有 Tekton Hub legacy client | resolver 走 Artifact Hub；PAC remote Hub annotation 不承诺 artifacthub-only 支持 |
| 4.2 | release-1.0 | 支持 | release-0.36 | 不支持，只有 Tekton Hub legacy client | resolver 走 Artifact Hub；PAC remote Hub annotation 不承诺 artifacthub-only 支持 |
| 4.6 | release-1.0 | 支持 | release-0.36 | 不支持，只有 Tekton Hub legacy client | resolver 走 Artifact Hub；PAC remote Hub annotation 不承诺 artifacthub-only 支持 |
| 4.10 | release-1.6 | 支持 | release-0.39 | 支持 Artifact Hub provider | resolver 和 PAC 均走 shim Artifact Hub API |
| main / 4.13 | release-1.6 | 支持 | release-0.39 | 支持 Artifact Hub provider | resolver 和 PAC 均走 shim Artifact Hub API |

复核结论：

- Pipeline 0.65、1.0、1.6 的 hub resolver 都已有 `ArtifactHubType=artifact` 和 `/api/v1/packages/tekton-{kind}/{catalog}/{name}/{version}` 访问路径。
- 这些 resolver 版本在 `resolveCatalogName` 中都会先读取 `default-tekton-hub-catalog`、`default-artifact-hub-task-catalog` 和 `default-artifact-hub-pipeline-catalog`。因此配置中必须保留 `default-tekton-hub-catalog`，不需要修改 resolver 源码。
- PAC 0.32/0.36 的 `pkg/hub` 只有 `/resource/{catalog}/{kind}/{name}` 和 `/raw` 的 Tekton Hub legacy client，没有 `hub-catalog-type` 或 Artifact Hub provider。本次不把 shim legacy API 作为默认承诺；若这些分支必须支持 PAC remote Hub annotation，需要单独 backport PAC 0.39 的 Artifact Hub provider。
- PAC 0.39 有 Artifact Hub provider；默认配置必须显式设置 `hub-catalog-type: artifacthub` 和 `hub-catalog-name: catalog`，并依赖 shim 的 Pipeline catalog fallback 处理 `catalog` 与 `catalog-pipelines` 的差异。

### PAC remote annotation 影响范围

PAC 0.32/0.36 不支持 Artifact Hub provider，并不代表 PAC 触发的所有流水线都不能使用 Artifact Hub 上的 Task 或 Pipeline。这里有两条不同链路：

- PAC remote annotation 链路：PAC controller 在创建 PipelineRun 前解析 `pipelinesascode.tekton.dev/task` 和 `pipelinesascode.tekton.dev/pipeline`，并把 remote Task/Pipeline inline 到 PipelineRun。这条链路使用 PAC ConfigMap 的 `hub-url` 和 `pkg/hub` client。
- Tekton resolver 链路：PAC 只提交带有 `taskRef.resolver: hub` 或 `pipelineRef.resolver: hub` 的 PipelineRun；运行期由 Tekton remote resolver 读取 `hubresolver-config` 并访问 shim。这条链路不读取 PAC `hub-url`、`hub-catalog-type` 或 `hub-catalog-name`。

按 PAC `RemoteTasks.getRemote` 的源码分支，只有 annotation 值进入 Hub client 时才受 PAC 0.32/0.36 限制：

- `pipelinesascode.tekton.dev/task: "git-clone"`、`"git-clone:0.10.0"` 这类普通 Task 名会请求默认 Hub catalog。
- `pipelinesascode.tekton.dev/pipeline: "buildpacks"`、`"buildpacks:0.1"` 这类普通 Pipeline 名会请求默认 Hub catalog。
- `customcatalog://curl`、`tektonhub://git-clone` 等 `catalogID://resource` 写法会请求对应 custom Hub catalog；在 PAC 0.32/0.36 中仍是 Tekton Hub legacy API。
- 如果 `pipelinesascode.tekton.dev/pipeline` 取回的 remote Pipeline 自身带有 `pipelinesascode.tekton.dev/task` annotation，且这些 task 值是普通 Hub 名或 `catalogID://resource`，PAC 也会继续走 Hub client 并受同样限制。

以下场景不受 PAC 0.32/0.36 缺少 Artifact Hub provider 的影响：

- `.tekton` 目录内普通 PipelineRun、Pipeline、Task 文件。
- `pipelinesascode.tekton.dev/pipeline` 或 `pipelinesascode.tekton.dev/task` 指向仓库内路径，例如 `.tekton/pipelines/image-build.yaml`、`share/tasks/foo.yaml`、`./task.yaml`。
- `pipelinesascode.tekton.dev/pipeline` 或 `pipelinesascode.tekton.dev/task` 指向 `http://` 或 `https://` 直接 URL。
- PipelineRun/Pipeline 中显式写 `taskRef.resolver: hub` 或 `pipelineRef.resolver: hub`。这种情况下 PAC 不解析 Hub 资源，Task/Pipeline 由 Tekton resolver 在运行期解析。
- namespace-local Task/Pipeline、ClusterTask、bundle/git/cluster 等其他非 PAC Hub client 路径。

## Current Implementation Status

截至 2026-06-17，本轮已经完成或部分完成以下改造：

- `artifacthub-shim` 已新增独立 hub Ingress 配置与模板；host 为空时应省略 `host` 字段，避免生成非法 Ingress。
- `artifacthub-shim` 已新增 `pipeline/catalog -> catalog-pipelines` lookup fallback，覆盖 Artifact Hub 带版本 detail、无版本 latest detail、UI detail/batch 和 legacy raw YAML 路径；fallback 命中时记录 warning 和指标。
- `artifacthub-shim` 已新增 `artifacthub-shim-extension` 独立 binary、Deployment、Service、RBAC、cert-manager 证书资源和 template-render MutatingWebhookConfiguration；首个能力为 template-render。
- `artifacthub-shim` 已新增 chart 门禁脚本，覆盖 hostless `hubIngress`、global cluster ingress class 自动选择、显式 class 覆盖，以及 extension 默认启用/关闭渲染。
- `tektoncd-pipeline` 已在 `config/pipeline/resolver-patch.yaml` 将 resolver 默认配置切到 shim Artifact Hub API，并保留 `default-kind: task` 与 `default-tekton-hub-catalog: catalog`；`config/pipeline/release.yaml` 仍是 upstream 基础产物，交付验证以 `kustomize build config/pipeline` 后的结果为准。
- `tektoncd-pipelines-as-code` 已通过 `config/pac/release.yaml` 和 `config/pac/patch-configmap.yaml` 设置默认 `hub-url`、`hub-catalog-type: artifacthub`、`hub-catalog-name: catalog`；Go 代码默认值保持 upstream。
- `tektoncd-operator` 已清理 Tekton Hub runtime 入口、catalog runtime 入口和 auto-install 入口，并新增 `0019-tekton-hub-artifacthub-shim-migration.patch`，覆盖 TektonHub tombstone cleanup、resolver/PAC pre-upgrade 迁移注册和旧集群内 Tekton Hub Service URL 白名单迁移。
- `catalog` 已通过 catalog 仓库根目录的 `make verify-artifacthub-shim-metadata` 审计 `config/images`、`config/templates` 和正式 Task/Pipeline/StepAction manifest；本轮仍不迁移 `devops/tektoncd/hub` 镜像仓库前缀。
- `tektoncd-operator` runtime 入口清理已完成；catalog/hub 相关 e2e 已迁入 `artifacthub-shim`，operator 保留的 PAC、Results、Triggers、ScheduledTriggers、Simple Upgrade、GitOps Trigger 混合 case 已改用 local/inline fixture，不再依赖 hub resolver 或 artifacthub-shim。
- `artifacthub-shim` PAC 流水线已按 PR 变更路径选择 e2e tag：API/catalog 变更触发 API/catalog compatibility e2e，extension 变更触发 extension e2e，push/tag/manual 或共享区域变更触发全量 `@artifacthub-shim`。
- DevOps builders knowledge/skills 已更新默认 Hub resolver、catalog e2e 归属、Artifact Hub metadata 和 `artifacthub-shim` resource-sync 规则；旧镜像前缀说明按本轮决策保留为暂不迁移。

本轮确认的执行决策如下：

- `pipeline-v2-frontend` 不纳入本轮代码改造；本设计文档只保留前端目标和验收要求，不再跟踪前端任务创建状态。
- `tektoncd-pipelines-as-code` 只改默认配置，不改 Go 代码里的默认值。
- `tektoncd-pipeline/config/pipeline/release.yaml` 不要求直接包含 patch 内容；交付时以 `tp-all-in-one.yaml` 中 `kustomize build config/pipeline` 上传到 Nexus 的 `release.yaml` 包含 patch 后结果为准。
- `artifacthub-shim` 不新增 `/hub/readyz`、`/hub/api/v1alpha1/*` handler，也不新增这类 e2e/smoke；`/hub` 只作为 ACP 网关/Ingress rewrite 前缀存在。
- catalog 镜像仓库从 `devops/tektoncd/hub` 迁到 `devops/artifacthub-shim/hub` 本轮先不做，后续跟 catalog 归属迁移一起处理。
- 当前 PR 已迁移 `tektoncd-operator` 的 catalog/hub e2e；operator 文档迁移仍按 Documentation Plan 后续继续。除文档迁移外，template-render 从 `tektoncd-enhancement` 下线仍在当前 PR 范围内。

本轮剩余待处理项如下：

需要补自动化测试或长期回归的项：

- `artifacthub-shim` resource sync：已有 ConfigMap extra resource sync 和 keep policy prune 覆盖后，仍需在后续 e2e 中长期覆盖真实 catalog 内置 `config` 目录导入。
- `tektoncd-operator`：补或确认 pre-upgrade 单测覆盖 resolver、`TektonConfig` PAC settings、`OpenShiftPipelinesAsCode` CR、已部署 `pipelines-as-code` ConfigMap、旧集群内 Tekton Hub Service URL 迁移、公网/自定义 URL 保留，以及 TektonHub tombstone cleanup/finalizer。
- `artifacthub-shim-extension`：已在 `artifacthub-shim` 仓库内新增独立组件并补 template-render 单元测试；迁入的 `catalog.pipeline.send-mail.feature` 提供 catalog template 消费 e2e，仍需继续补真实 admission webhook 的独立 e2e 覆盖。

后续独立 PR 需要继续做的文档迁移项：

- 将 `tektoncd-operator` 里与 catalog/hub 相关的文档迁到 `artifacthub-shim`；跨仓文档跳转统一使用 `ExternalSiteLink`，不得直接写跨 repo markdown link。

一次性发版或 PR 前门禁验证项如下：

- 全仓扫描默认配置和用户文档中的旧默认链路：`devops/tektoncd/hub`、`api.hub.tekton.dev`、`https://artifacthub.io`。历史设计说明、upstream 测试 fixture、保留的镜像前缀延期项需要显式豁免。
- 确认 `tektoncd-pipeline` 交付到 Nexus 的 `release.yaml` 来自包含 `resolver-patch.yaml` 的 `kustomize build config/pipeline` 结果。
- 确认 4.0、4.2、4.6、4.10、main/4.13 的 backport 说明均包含 resolver/PAC 能力边界和 TektonHub tombstone cleanup/finalizer 处理。

## Proposal

### 1. 默认运行时拓扑

标准安装后的职责边界如下：

```text
DevOps UI
  -> /hub/api/v1alpha1/* 网关入口
  -> 独立 hub Ingress/网关 rewrite 为 /api/v1alpha1/*
  -> artifacthub-shim-api Service
  -> 本地 catalog index / ConfigMap repository source

Tekton hub resolver
  -> ARTIFACT_HUB_API=http://artifacthub-shim-api.artifacthub-shim-system.svc.cluster.local/
  -> /api/v1/packages/*
  -> artifacthub-shim

Pipelines as Code remote annotation
  -> hub-url=http://artifacthub-shim-api.artifacthub-shim-system.svc.cluster.local
  -> /api/v1/packages/*
  -> artifacthub-shim
```

Tekton Hub、`tektoncd-hubs-api`、`hubs-wrapper`、operator 内置 catalog 不再参与新装集群运行时流量。

历史 LTS 的 hub resolver 已确认均可直接切 Artifact Hub 模式。PAC 0.32/0.36 不支持 Artifact Hub provider，本次不把 legacy Tekton Hub API 作为默认依赖；如果这些旧分支必须继续支持 PAC remote Hub annotation，需要单独评估 backport PAC 0.39 的 Artifact Hub provider。

### 2. artifacthub-shim 改造范围

P0 必做：

- 新增独立的 UI 用 hub Ingress 配置，例如 `hubIngress` 或 `uiIngress`，使用 `cpaas-system` class，提供 `/hub(/|$)(.*)` path 和 rewrite 注解，后端指向 `artifacthub-shim-api:80`；不复用既有通用 `ingress`。
- 如果 hub Ingress 模板在 host 为空时渲染 `host: ""` 会被 Kubernetes 拒绝，需要调整模板为 host 为空时省略 `host` 字段；若平台插件会注入 host，则保持与插件渲染规则一致。
- 继续只暴露 canonical API：`/readyz`、`/api/v1alpha1/*`、`/api/v1/packages/*`、`/v1/resource/.../yaml`。`/hub` 前缀由独立 hub Ingress/网关 rewrite 去掉，不在 API handler 中重复注册 `/hub/**`。
- 本轮不迁移 root `values.yaml` 和 chart `values.yaml` 中 catalog/tool image repository 前缀；镜像仓库从 `devops/tektoncd/hub/*` 迁到 `devops/artifacthub-shim/hub/*` 跟随后续 catalog 归属迁移处理。
- 标准安装约定保持 namespace `artifacthub-shim-system`、release name `artifacthub-shim`，不要求用户修改 release name 或额外覆盖服务名。
- 新增文档说明自定义 namespace 或 release name 时如何更新 TektonConfig resolver 配置和 PAC settings。
- 对 `kind=pipeline` 且 `catalog=catalog` 的历史引用提供兼容策略。首选在 Artifact Hub detail/raw lookup 层增加 fallback：当 `pipeline/catalog/<name>` 未命中时自动尝试 `pipeline/catalog-pipelines/<name>`。
- 不要重复注册一个名为 `catalog` 的 Pipeline source，因为当前索引和 refresh 会按 repository name 做全局重复检查，重复 source 会触发 `duplicate repository name` 并导致状态异常。
- fallback 命中时应打 warning 级别日志和指标，便于后续评估是否可以移除。

P1 建议：

- 不新增 `/hub/readyz`、`/hub/api/v1alpha1/*` 这类 API handler 或 e2e/smoke；如果需要验证网关 rewrite，应放在平台网关或插件编排测试中，不放在 `artifacthub-shim` API e2e 中。
- 将 `docs/quick_start.md` 改成最小化安装验证：标准插件安装后不需要修改 TektonConfig；只验证 Service ready、UI rewrite、resolver/PAC 默认配置能访问 shim。
- 新增“自定义安装位置/名称时如何配置 Tekton 集成”的 how-to 文档，quickstart、troubleshooting、operator 文档都链接到这篇文档。
- 将 catalog 迁移规则从开发文档提升为正式维护文档，并作为 catalog 发布门禁引用。

P2 / Phase B：

- template-render 不并入 shim API 进程。
- Phase B 在 `artifacthub-shim` 仓库内新增通用扩展组件，暂定名称 `artifacthub-shim-extension`。
- `artifacthub-shim-extension` 作为独立 binary、Deployment、Service 和 Webhook 交付；首个能力是 template-render，后续可承载其他与 catalog/shim 集成相关的运行时处理逻辑。
- 不建议把 admission webhook、证书、Tekton API 类型和普通 Artifact Hub API handler 混在同一个服务边界里。
- 不新增独立仓库。原因是 template-render 和后续扩展逻辑需要跟 shim/catalog 发布节奏保持一致，单独仓库会增加版本编排成本；通过独立进程、独立 RBAC 和独立 webhook 边界即可避免与 API 进程耦合。

### 3. tektoncd-pipeline resolver 改造范围

resolver 默认配置应从 `tektoncd-pipeline` 的 `config/pipeline/resolver-patch.yaml` 改起，再由 operator 同步。目标基础配置为：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: hubresolver-config
  namespace: tekton-pipelines-resolvers
data:
  artifact-hub-api: http://artifacthub-shim-api.artifacthub-shim-system.svc.cluster.local/
  default-artifact-hub-task-catalog: catalog
  default-artifact-hub-pipeline-catalog: catalog-pipelines
  default-kind: task
  default-tekton-hub-catalog: catalog
  default-type: artifact
```

`default-kind` 和 `default-tekton-hub-catalog` 都必须保留。当前 resolver 在 `populateDefaultParams` 中会要求默认 kind，在 `resolveCatalogName` 中即使是 Artifact Hub 类型也会先读取 Tekton Hub catalog 默认值。保留这两个 key 即可满足 resolver 要求，不需要改 resolver 源码。

Deployment env 需要同步调整：

- `ARTIFACT_HUB_API` 指向 shim Service。
- `TEKTON_HUB_API` 不参与默认 artifact 路径；如果 transform 仍需要该 env，必须确保不会指向已删除的 `tekton-hub-api.tekton-pipelines` 服务。
- 默认配置不得访问公网 `artifacthub.io` 或 `api.hub.tekton.dev`。

升级场景同样要检查已持久化的 resolver 覆盖值。operator 会先读取 `tektoncd-pipeline` release manifest，再用 `TektonConfig.spec.pipeline["hub-resolver-config"]` / `TektonPipeline.spec["hub-resolver-config"]` 覆盖同名 ConfigMap key；如果这些 spec 字段里保留了旧集群内 Tekton Hub Service URL，单改 `resolver-patch.yaml` 不一定能让集群最终使用新值。resolver 迁移应只改空值和可明确识别的旧集群内 Tekton Hub Service URL，保留用户自定义 Hub URL/catalog。

### 4. tektoncd-pipelines-as-code 改造范围

PAC 的默认配置应从 `tektoncd-pipelines-as-code` 改起，operator 侧只消费同步后的 release manifest 和 patch。目标 ConfigMap settings 为：

```yaml
hub-url: http://artifacthub-shim-api.artifacthub-shim-system.svc.cluster.local
hub-catalog-type: artifacthub
hub-catalog-name: catalog
```

这组 settings 只影响 PAC remote annotation 默认 Hub，不影响用户在 PipelineRun/TaskRun 中显式写的 `resolver: hub` params。PAC 0.39 可以只改配置，不需要修改 Artifact Hub client 源码。关键点是显式设置 `hub-catalog-name: catalog`，避免 Task remote annotation 因 catalog 为空或 `default` 而落到社区默认 `tekton-catalog-tasks`。

这个配置的限制是 Pipeline remote annotation 也会请求 `catalog`，不会自动改成 `catalog-pipelines`。因此 shim 必须提供 `pipeline/catalog -> catalog-pipelines` lookup fallback；如果后续不接受这个 fallback，才需要评估改用社区 repository alias，或在 PAC 代码层面增加 Task/Pipeline 分 catalog 默认配置。

PAC 0.32/0.36 没有 Artifact Hub provider，也没有 `hub-catalog-type`。本次不通过 legacy Tekton Hub API 承诺 PAC remote Hub annotation 的 artifacthub-only 接入；若 4.0、4.2、4.6 必须保留 PAC remote Hub annotation 能力，应单独 backport PAC 0.39 的 Artifact Hub provider，而不是把旧 legacy API 作为默认链路。

operator overlay 中不要直接改 vendored upstream 产物。PAC 默认配置应在 `tektoncd-pipelines-as-code` 的 `config/pac` 下通过 `patch-*.yaml` 表达，随后由 operator 同步。

pre-upgrade 是升级兼容措施，不是让 PAC 支持 Artifact Hub 的功能入口。新装或没有历史持久化设置时，只修改默认配置即可；从旧版本升级时，release manifest 的新默认值不会自动覆盖以下状态：

- `TektonConfig.spec.platforms.openshift.pipelinesAsCode.settings`
- `OpenShiftPipelinesAsCode.spec.settings`
- 已部署的 `pipelines-as-code` ConfigMap

原因是 operator 渲染 PAC 时会把 `OpenShiftPipelinesAsCode.spec.settings` 覆盖到 `pipelines-as-code` ConfigMap；`TektonConfig` 里的 PAC settings 也会在组件拆分/同步链路中继续向下传递。只改 `tektoncd-pipelines-as-code` 的默认 ConfigMap 能覆盖新装，但不能保证已经写入 CR spec 或已部署 ConfigMap 的旧默认值在升级后被替换。

迁移只覆盖空值和可明确识别的旧集群内 Tekton Hub Service URL。`hub-url` 归一化后，只有 host 精确匹配以下值时才自动迁移：

- `tekton-hub-api.tekton-pipelines`
- `tekton-hub-api.tekton-pipelines.svc`
- `tekton-hub-api.tekton-pipelines.svc.cluster.local`

端口和 `/v1` 路径不影响识别，例如 `http://tekton-hub-api.tekton-pipelines:8000/`、`http://tekton-hub-api.tekton-pipelines:8000/v1`、`http://tekton-hub-api.tekton-pipelines.svc.cluster.local:8000/v1` 都应迁移。

公网地址不能作为“旧默认值”静默迁移。`https://artifacthub.io`、`https://artifacthub.io/api/v1`、`https://api.hub.tekton.dev/v1` 可能是用户显式选择的外部 Hub，升级时必须保留；operator 只通过日志、event 或 condition 提示该配置不满足 air-gap 默认链路。

迁移目标为 shim URL 和 `hub-catalog-type: artifacthub`。`hub-catalog-name` 只在本次 `hub-url` 被同步迁移到 shim、且值为空、`default` 或 `tekton` 时改为 `catalog`；用户自定义 catalog 和 additional catalogs 必须保留。

### 5. tektoncd-operator 改造范围

#### 5.1 移除运行时组件

operator main/4.13 需要清理以下 runtime 入口：

- `components.yaml` 删除 `hubs-wrapper`、`tektoncd-hub`、`catalog`。
- `config/tekton-pipeline/kustomization.yaml` 删除 `hubs-wrapper.yaml` 引用；`config/tekton-pipeline/hubs-wrapper.yaml` 不再生成。
- `config/tekton-hub/**` 删除 Tekton Hub api/db/ui/db-migration/hub-info 交付制品；如果保留 legacy 清理测试数据，应移动到测试目录并避免打包。
- `config/operator/autoinstall-tektonhub.yaml` 和 `config/operator/kustomization.yaml` 中的引用删除；保留 tombstone controller 不等于 auto-install TektonHub。
- `values.yaml` 删除 `catalog_*`、`tektoncd-hub_*`、`hubs-wrapper_*` 镜像。
- `hack/update_components.sh` 删除为 Tekton Hub 创建额外目录的逻辑、catalog release 镜像替换逻辑、跳过 catalog 的特殊分支，以及对 `config/tekton-hub/api/kustomization.yaml` 的 image rewrite。
- `devspace.yaml` 删除强制 `AUTOINSTALL_TEKTONHUB=true` 和测试前 apply `tektonhubs.yaml` 的逻辑。需要 resolver/PAC smoke 的 e2e case 自己安装 shim；catalog 行为 e2e 不再放在 operator 全局 e2e。

#### 5.2 patch 文件处理

明确删除以下只服务 Tekton Hub auto-install/runtime 的 patch：

- `.tekton/patches/0001-tektonconfig-deploys-hub-by-default.patch`
- `.tekton/patches/0010-support-auto-upgrade-tekton-hub.patch`
- `.tekton/patches/0014-hub-installer-support-preserve-namespace.patch`
- `.tekton/patches/0019-default-disable-tektonhub-auto-deploy.patch`

需要修改以下 patch：

- `.tekton/patches/0006-fix-panic-and-e2e.patch`：去掉 TektonHub e2e、测试数据和强依赖，保留与本次迁移无关的 panic/e2e 修复。
- `.tekton/patches/0015-support-resource-policy-annotation.patch`：去掉 TektonHub transform/test hunk，保留通用 resource-policy 支持。
- catalog ConfigMap 的 keep 语义转到 `artifacthub-shim.alauda.io/resource-policy` 文档和 shim 同步逻辑。

如果 patch 中包含 `TektonHub` CRD 注册、client generated code 或 controller 注册，不应在 4.13 第一轮直接全删；需要先确认 tombstone cleanup 能覆盖所有升级路径。下一大版本再评估移除 API、CRD 和 generated code。

#### 5.3 resolver 和 PAC 同步

operator 侧要消费 `tektoncd-pipeline` 更新后的 resolver manifest，确保基础 release 不含旧 `tekton-hub-api` 默认值。

仅修改 `TektonConfig.spec.pipeline.hub-resolver-config` 默认值不足以清掉 release manifest 中的旧 key。原因是 `common.CopyConfigMap` 只覆盖/追加 key，不会删除已有 key。因此必须同时修改：

- 基础 manifest
- Deployment env transform
- 升级迁移逻辑

pre-upgrade 机制是 Tekton Operator 已有的升级框架，不需要新增 Job 或 controller。`TektonConfig` reconcile 已经调用 `upgrade.RunPreUpgrade`；框架会比较当前 operator 版本和 `TektonConfig.status.preUpgradeVersion`，需要升级时执行 `upgrade.go` 中的 `preUpgradeFunctions`，成功后写回 pre-upgrade version。本次只是在这个既有列表中注册迁移函数，并把迁移逻辑改成 shim 目标。

PAC 默认值需要从 `tektoncd-pipelines-as-code` 同步，同时修改 operator 默认测试期望和 pre-upgrade 注册。当前代码里已有旧的 `preUpgradePipelinesAsCodeArtifacts` helper，但它的目标是公网 Artifact Hub 并删除 `hub-catalog-name`；本次必须改为按上文白名单只迁移旧集群内 Tekton Hub Service URL，迁移后设置 shim URL、`hub-catalog-type: artifacthub` 和必要的 `hub-catalog-name: catalog`，然后注册到 pre-upgrade 函数列表，并补充以下 patch 测试：

- 已部署 ConfigMap 中的 `hub-url`
- 已部署 ConfigMap 中的 `hub-catalog-type`
- 已部署 ConfigMap 中的 `hub-catalog-name: catalog`

#### 5.4 TektonHub API/CRD 策略

4.13 和 LTS backport 不建议直接删除 `TektonHub` CRD/API/controller。推荐改造为 tombstone cleanup：

- 不再创建 Tekton Hub api/db/ui/db-migration InstallerSet。
- 如果发现历史 `TektonHub` CR，删除旧 InstallerSet 和关联 runtime 资源。
- 如果发现 `operator.tekton.dev/created-by=TektonHub` 的 InstallerSet，删除对应 runtime 资源。
- 将状态标记为 removed/disabled。
- 确保 finalizer 能被清掉。

只有确认所有支持升级路径都不会残留带 finalizer 的 `TektonHub` CR 后，下一大版本才删除 CRD、API reference、client/informer generated code 和 controller registration。

对于不是从 4.12 升级的用户，目标版本 operator 必须能直接处理历史残留。这意味着 4.0、4.2、4.6、4.10、main/4.13 的目标包都需要包含清理逻辑，不能依赖用户先升级到某个中间版本。

### 6. catalog 改造范围（这次改造暂时先不处理）

catalog 后续归属 `artifacthub-shim` 发布链路，维护一条主分支并随 shim 发布。operator 不再：

- 内置 catalog release。
- 从 operator `values.yaml` 携带 catalog/tool image。

镜像仓库统一从 `devops/tektoncd/hub/<tool>` 迁到 `devops/artifacthub-shim/hub/<tool>`，影响范围包括：

- `values.yaml`
- `.tekton/images/*.yaml`
- Task/Pipeline manifest default params
- `config/images/*.yaml`
- samples
- README
- DEVELOPMENT
- testdata
- 相关脚本

这类变更不升级 Task/Pipeline version，因为资源参数和行为不变，只是默认镜像仓库归属变化。

tool-image ConfigMap 必须保留 `catalog.tekton.dev/tool-image-*` labels，避免 UI descriptor selector 失效。

ConfigMap 同步规则如下：

- 所有需要同步到 `kube-public` 的 ConfigMap 添加 `artifacthub-shim.alauda.io/import: "true"`。
- 需要保留旧版本候选或历史模板时添加 `artifacthub-shim.alauda.io/resource-policy: keep`。

每个 Task/Pipeline/StepAction manifest 至少补齐以下 Artifact Hub annotations：

- `artifacthub.io/license: Apache-2.0`
- 合适的 `artifacthub.io/category`
- 弃用版本补 `artifacthub.io/deprecated: "true"`

同时需要保留现有 Tekton 展示 annotation 和 `style.tekton.dev/descriptors`。

历史 Pipeline 兼容需要特别处理：

- 过去 Tekton Hub 中 Task 和 Pipeline 可能都通过 `catalog` 注册。
- 用户 PipelineRun 中的 `pipelineRef.params.catalog` 可能写成 `catalog`。
- 切到 shim 后默认 Pipeline catalog 是 `catalog-pipelines`。

推荐在 shim lookup 层提供 `pipeline/catalog -> pipeline/catalog-pipelines` fallback。troubleshooting 中需要说明，如果解析失败，可以将 ref 里的 `catalog` 改为 `catalog-pipelines`，或者删除 catalog 参数走默认值。

由于这类用户预计较少，UI 和 resolver 不需要把 `catalog` 同时显示为 Pipeline catalog。

### 7. pipeline-v2-frontend 改造范围

P0 保持现有 `/hub/api/v1alpha1/*` 调用路径，由独立 hub Ingress/网关 rewrite 到 shim canonical API。

UI 文案调整如下：

- 文案从 “Tekton Hub” 收敛为 “Hub”。
- `tekton_hub_tips` 改为“未检测到可用 Hub 服务，请安装或检查 artifacthub-shim”。
- 提供文档跳转链接。

错误分类建议如下：

- 200：available
- 401/403：权限不足
- 404：未安装或路由不存在
- 503：服务已安装但未 ready
- 0、timeout、网关 5xx：网络或服务异常
- detail 404：资源不存在或历史 catalog 名不匹配

Pipeline 列表的 Hub tab 可以在 Hub 不可用时整块展示提示和文档链接。

Task 列表、TaskRun 表单、Pipeline 编排选择 Task 的弹窗需要把 Hub 来源错误做成非阻塞 alert：

- namespace Task、CustomRun 和已有选择仍正常展示。
- Hub tab/filter 显示不可用状态，不让用户误以为本地资源为空。
- Pipeline 编排选择 Task 时，如果已选 ref 是 Hub ref 但当前 Hub 不可用，应展示“当前 Hub 服务不可用，无法预览该 Task”的说明。
- 保留 YAML/ref 值，避免用户保存时被前端清空。

P1 增加 artifacthub-shim 安装页面跳转，可参考其他 cluster plugin 的安装跳转方式。integration tests 更新 “Tekton Hub” 场景名和断言文本为 “Hub”，同时增加未安装 shim、global 集群未部署 shim、服务未 ready 的 UI 状态覆盖。

### 8. tektoncd-enhancement 依赖处理

本轮按 Phase B 处理 template-render，从 `tektoncd-enhancement` 迁到 `artifacthub-shim` 仓库内的通用扩展组件。

组件暂定名称为 `artifacthub-shim-extension`，原因如下：

- 名称不绑定 template-render，后续可以承载其他与 catalog/shim 集成相关的运行时处理逻辑。
- 与 `artifacthub-shim-api` 区分清楚，避免把 admission webhook、证书、Tekton API 类型和普通 HTTP API handler 混在同一个进程中。
- 保持在当前仓库内，便于跟 catalog/shim API 同步发布；同时通过独立 binary、Deployment、Service、RBAC 和 Webhook 保持运行时边界。

`artifacthub-shim-extension` 的首个能力是 template-render，必须满足以下要求：

- 兼容当前真实参数 `renderTemplateName`、`renderTemplateNamespace`、`renderTemplateValues`。
- 读取 `kube-public` 模板 ConfigMap。
- 输出现有 send-mail Task 参数。
- 失败时保留 `tekton.alaudadevops.io/template-render-error` annotation。
- `failurePolicy` 保持 `Ignore`。
- 使用独立端口、证书、RBAC、MutatingWebhookConfiguration 和测试。
- 不能混入 shim 的普通 HTTP API 路由。

## Upgrade and Migration Strategy

### 新装集群

1. 安装 `artifacthub-shim` 到 `artifacthub-shim-system`，release name 保持 `artifacthub-shim`。
2. `artifacthub-shim` 默认启用 UI Ingress，`/hub` rewrite 到 shim Service。
3. 安装或升级 Tekton Operator 4.13，operator 默认 resolver/PAC 配置指向 shim。
4. 不安装 Tekton Hub、`tektoncd-hubs-api`、`hubs-wrapper` 或 operator 内置 catalog runtime。
5. UI、resolver、PAC remote annotation 通过 shim 访问 catalog。

### 从旧版本升级

升级前只需要保存用户自定义 `hubresolver-config` 和 PAC settings，迁移逻辑不得覆盖公网 Hub URL 或自定义 URL。

operator pre-upgrade/reconcile 负责：

- 把空值或旧集群内 Tekton Hub Service URL 改为 shim URL。
- 对迁移到 shim 的 PAC settings，把 `hub-catalog-type` 改为 `artifacthub`。
- 对迁移到 shim 的 PAC settings，把空值、`default` 或 `tekton` 的 `hub-catalog-name` 改为 `catalog`。
- 保留公网 Artifact Hub、公网 Tekton Hub、自定义 Hub URL、自定义 catalog 和 additional catalogs，并提示 air-gap 风险。
- 清理旧 TektonHub InstallerSet/资源。

升级后需要：

- 安装或升级 `artifacthub-shim`。
- 同步 catalog 和 tool-image ConfigMap。
- 验证 resolver、PAC remote annotation、UI 资源列表和历史 Pipeline ref。

如果用户跳过 4.12 直接从更早版本升级到目标版本，目标版本也必须完成同样清理。不能假设历史 `TektonHub` CR 已被中间版本处理，不能先删除 CRD 再尝试清 finalizer。

### LTS 分支

目标是 4.0、4.2、4.6、4.10、main/4.13 都移除 Tekton Hub runtime 依赖。实现路径按已确认能力分两类：

- hub resolver：4.0、4.2、4.6、4.10、main/4.13 均支持 `type: artifact`，默认策略都是切到 Artifact Hub 模式并指向 shim。
- PAC：4.10、main/4.13 使用 PAC 0.39，可通过配置接入 shim Artifact Hub API。
- PAC：4.0、4.2、4.6 使用 PAC 0.32/0.36，不支持 PAC remote Hub annotation 的 artifacthub-only 接入；不通过 legacy API 作为默认兜底。如果这些分支必须支持 PAC remote Hub annotation，需要单独 backport 0.39 Artifact Hub provider。

只有在旧分支必须继续支持 PAC remote Hub annotation、且不允许 backport Artifact Hub provider 时，才需要重新评估是否补 shim legacy endpoint，并明确说明：

- 具体缺失 API
- 影响范围
- 回退策略

## Implementation Plan

### Phase 0: 文档和门禁

- 完成本设计评审，确认 4.13 和所有 LTS 分支的目标一致。
- 明确标准插件安装顺序由产品编排保证：先有 `artifacthub-shim`，再让 Tekton resolver/PAC 默认配置可用。
- 明确 template-render 按 Phase B 迁到 `artifacthub-shim` 仓库内的 `artifacthub-shim-extension`，并保持独立进程和独立 webhook 边界。
- 增加 release gate：`rg "devops/tektoncd/hub|api.hub.tekton.dev|https://artifacthub.io"` 在默认配置和用户文档中不能出现旧默认链路；历史说明和测试 fixture 需要单独豁免。

### Phase 1: artifacthub-shim 基础兼容

- 新增独立 hub Ingress，配置 `/hub(/|$)(.*)` rewrite；shim API 不注册 `/hub/**`，`artifacthub-shim` e2e 不增加 `/hub/readyz` 或 `/hub/api/v1alpha1/*` smoke。
- chart/root values 中 catalog/tool image repository 前缀本轮暂不迁移，后续跟 catalog 归属迁移一起处理。
- 增加 `pipeline/catalog -> catalog-pipelines` lookup fallback 和对应测试；特别覆盖无版本 latest detail fallback 返回非空 `manifestRaw`。
- 补 chart 渲染自动化或 CI 门禁：`helm lint`、`helm template`、hostless `hubIngress`、global cluster class 自动选择和显式 class 覆盖。
- 更新 quickstart 为最小安装验证，新增自定义 namespace/release name 的 Tekton 集成文档。

### Phase 2: tektoncd-pipeline 和 PAC 默认值

- `tektoncd-pipeline/config/pipeline/resolver-patch.yaml` 已设置 Artifact Hub API、`default-type: artifact`、`default-kind: task`、`default-tekton-hub-catalog: catalog` 和默认 Task/Pipeline catalog；继续补生成产物验证，确保交付 manifest 包含 patch 后结果。
- `tektoncd-pipelines-as-code/config/pac` 已设置默认 `hub-url`、`hub-catalog-type: artifacthub`、`hub-catalog-name: catalog`；继续补默认配置测试，确认不依赖 `/api/v1/stats` 自动探测。
- 补 resolver 和 PAC 单测/门禁，覆盖默认配置、用户自定义 catalog、additional catalogs、公网 URL 保留和旧集群内 Tekton Hub Service URL 迁移。

### Phase 3: tektoncd-operator 下线 Tekton Hub runtime

- `components.yaml`、`config/tekton-hub`、`hubs-wrapper`、values 和 auto-install 配置已清理；继续清理 `devspace.yaml` 残留的 `install-hub` 和 `tektonhubs.operator.tekton.dev` wait 项，并复核 `hack/update_components.sh` 中 catalog 特殊分支是否仍需保留。
- 删除或修改 Tekton Hub 相关 patch 文件，保留 tombstone cleanup 所需的 API/controller；`0019-tekton-hub-artifacthub-shim-migration.patch` 作为本次迁移 patch 保留。
- 同步 resolver/PAC 新默认值，更新 pre-upgrade 注册与迁移目标，并补齐对应单测。
- operator e2e 迁移已进入当前 PR。迁移完成后，operator e2e 不再部署 `artifacthub-shim`；operator 只验证自身组件安装、升级、默认配置、tombstone cleanup，以及 PAC、Results、Triggers、ScheduledTriggers、Simple Upgrade 这类 operator-owned 工作流。
- operator 文档迁移不进入当前 PR。后续迁移时删除或重写 Tekton Hub runtime 文档，并通过 `ExternalSiteLink` 指向 `artifacthub-shim` 文档。

operator catalog e2e 迁移清单：

- `hubs-wrapper.feature` 已迁到 `artifacthub-shim` 的 `hub-ui-compat.feature`，通过 canonical `/api/v1alpha1/*` API 覆盖旧 UI list/detail/batch 语义；operator 不再验证 hubs-wrapper 运行时。
- `pipeline.base.feature` 中 `resolver: hub` catalog Task/Pipeline smoke 已迁到 `artifacthub-shim` 的 `resolver.feature` / `catalog-resolver-matrix-001`；operator 只保留 Pipeline 基础 CRUD 和状态流转。
- `resource-policy.feature`、`post-uninstall.feature` 中针对 `kube-public` tool-image ConfigMap、keep policy、owner/image 的断言已从 operator 删除；shim 侧通过 repository extraResources e2e 持续覆盖资源同步导入边界，catalog 内置 `config` 目录导入作为长期回归项保留。
- `pipeline.send-mail.feature` 和相关 testdata 已迁到 `artifacthub-shim` 的 `catalog.pipeline.send-mail.feature`，并标记为 `@artifacthub-extension`。
- 其他 `task.*`、`pipeline.*` 场景中纯 catalog Task/Pipeline 行为已迁出 operator，迁入 shim 的 `catalog.task.*.feature`、`catalog.pipeline.*.feature` 和 `testing/features/testdata/operator-migrated/`。
- `results`、`triggers`、`scheduled-triggers`、`simple-upgrade`、`pac`、`pipeline.gitops-repo-update` 等同时依赖 operator 其他组件和 hub/catalog 的混合 case 保留在 operator；其中 hub/catalog 引用已改成本地 `taskSpec` / `pipelineSpec` 或 inline fixture。

### Phase 4: catalog 迁移

- 后续阶段批量替换镜像仓库前缀，保留 tool-image labels；本轮不处理 catalog 镜像仓库迁移。
- 完成同步资源最终审计：`config/images` 除 `kustomization.yaml` 等非资源聚合文件外均带 `artifacthub-shim.alauda.io/import`，需要长期保留的 ConfigMap 带 `artifacthub-shim.alauda.io/resource-policy: keep`。
- 完成正式 Task/Pipeline/StepAction manifest 的 Artifact Hub annotations 审计和补漏；samples/testdata 不强制补 Artifact Hub annotations。
- catalog 行为 e2e 已挪到 artifacthub-shim 测试树，并通过 `@artifacthub-api`、`@catalog`、`@artifacthub-extension` tag 区分 API、catalog compatibility 和 extension e2e。
- 更新 catalog 维护文档和发布流水线。

### Phase 5: UI 兼容

- 文案收敛为 “Hub”，增强错误状态判断和提示。
- Pipeline Hub tab、Task 列表和选择 Task/Pipeline 弹窗分别处理 Hub 不可用降级。
- 增加 artifacthub-shim 安装/排障文档跳转。
- 更新 integration tests 场景和断言。

### Phase 6: LTS backport

- 将已确认的历史版本矩阵同步到各 LTS backport 说明：resolver 全部走 Artifact Hub，PAC 0.32/0.36 标注为 PAC remote Hub annotation 不支持 artifacthub-only，PAC 0.39 走配置接入。
- 每个 LTS 都包含 TektonHub runtime 清理和 finalizer 处理，避免依赖中间版本。
- catalog 单主分支 release 阶段跑 LTS smoke 矩阵。

### Phase 7: skills 更新

需要更新 `alauda-ai-config` 中的 DevOps skill：

- `devops-creating-tekton-pipelines`：默认示例使用 `type: artifact`、`catalog` / `catalog-pipelines`。
- `devops-tekton-task-delivery`：补 Artifact Hub annotations 和新镜像仓库前缀。
- `devops-tekton-operator-task-e2e`：把 catalog e2e 归属改到 artifacthub-shim。
- `devops-tekton-dynamic-form-optimizer`：强调保留 `catalog.tekton.dev/tool-image-*` labels。

其他提到 “Tekton Hub”、旧公网 API 或旧镜像前缀的 skill 做全文审计。

## Test Plan

### Unit / chart

- `artifacthub-shim`：验证 canonical `/api/v1alpha1/*`、`/api/v1/packages/*`、`/v1/resource/.../yaml` 的 list/detail/raw manifest。
- `artifacthub-shim`：验证 pipeline catalog fallback，包含带版本 detail/raw/UI batch 和无版本 latest detail fallback 返回 `manifestRaw`。
- `artifacthub-shim`：验证 ConfigMap extra resource sync、keep policy prune 语义、标准插件值下的独立 hub Ingress 模板、`helm lint` 和 `helm template`。这些属于需要长期保留的自动化或 CI 门禁，不是一次性手工验证。
- `tektoncd-pipeline`：Artifact Hub 模式下保留 `default-kind: task` 和 `default-tekton-hub-catalog: catalog`；默认 Task/Pipeline catalog 分别为 `catalog` / `catalog-pipelines`；默认配置不访问公网。
- `tektoncd-pipelines-as-code`：默认 hub URL、catalog type、`hub-catalog-name: catalog`；用户 custom catalog 和 additional catalogs 不被覆盖；不依赖 `/api/v1/stats` 自动探测。
- `tektoncd-operator`：resolver ConfigMap copy/cleanup、Deployment env transform、PAC default/pre-upgrade、TektonHub tombstone cleanup、patch 删除后的 generated manifest。
- `tektoncd-operator`：PAC pre-upgrade 只迁移空值和 host 为 `tekton-hub-api.tekton-pipelines`、`.svc`、`.svc.cluster.local` 的旧集群内 URL；保留 `https://artifacthub.io`、`https://artifacthub.io/api/v1`、`https://api.hub.tekton.dev/v1`、自定义 URL、自定义 catalog 和 `catalog-N-*`。
- `pipeline-v2-frontend`：Hub 可用性错误分类、Pipeline Hub tab 降级、Task 混合列表降级、i18n 文案。

### 一次性门禁

- PR/发版前扫描默认配置和用户文档中是否仍出现旧默认链路：`devops/tektoncd/hub`、`api.hub.tekton.dev`、`https://artifacthub.io`。历史说明、upstream fixture 和本轮延期的镜像前缀需要显式豁免。
- PR/发版前确认 `tektoncd-pipeline` 交付产物来自 `kustomize build config/pipeline` 后的结果，而不是未叠加 patch 的 upstream `config/pipeline/release.yaml`。
- PR/发版前确认 4.0、4.2、4.6、4.10、main/4.13 的 backport 说明和 smoke 矩阵覆盖本文档列出的能力边界。

### Integration / e2e

- 新装：安装 `artifacthub-shim` + operator 4.13，验证 `hubresolver-config` 默认值。
- 新装：验证 TaskRun `resolver: hub` + `type: artifact`、PipelineRun `pipelineRef.resolver: hub`、UI 列表/详情/版本切换/manifest preview。
- 未安装 shim：UI 展示安装/检查提示；resolver/PAC 报错指向 shim 服务不可用而不是旧 Tekton Hub；namespace Task 和 CustomRun 仍可展示。
- 自定义 shim 安装：按文档修改 TektonConfig/PAC 后 resolver 和 PAC remote annotation 可用。
- 升级：从带 Tekton Hub 的旧 operator 升级，旧 TektonHub runtime 被清理，PAC settings 中的旧集群内 Tekton Hub Service URL 迁移到 shim，公网 Hub URL 和用户自定义 hub URL 不被覆盖，已有 finalizer 不阻塞删除。
- catalog compatibility：release 阶段对正式支持 operator 版本跑 smoke 矩阵；历史 `pipelineRef.params.catalog=catalog` 触发 shim fallback 或按 troubleshooting 修复。

## Documentation Plan

### artifacthub-shim 文档

新增：

- `docs/how_to/configure-tekton-integration.md`：说明标准安装无需修改配置；自定义 namespace/release name 时如何配置 `TektonConfig.spec.pipeline.hub-resolver-config`、PAC `hub-url` 和 `hub-catalog-type`。
- `docs/how_to/expose-devops-hub-ui.md`：说明 `/hub` Ingress rewrite、class、path、global 集群部署注意事项。
- `docs/trouble_shooting/devops_hub_ui_unavailable.md`：区分未安装、未 ready、无权限、global 集群未部署或网关未转发。
- `docs/trouble_shooting/historical_pipeline_catalog.md`：说明历史 Pipeline ref 中 `catalog` 需要改为 `catalog-pipelines`，或删除 catalog 参数走默认值；同时说明 shim fallback 的行为。

修改：

- `docs/quick_start.md`：改成最小安装验证，不再要求默认情况下手工修改 TektonConfig。
- `docs/how_to/consume-resources-with-hub-resolver.md`：默认示例使用 shim URL、`type: artifact`、Task `catalog`、Pipeline `catalog-pipelines`；StepAction 明确传 `catalog-stepactions`。
- `docs/trouble_shooting/hub_resolver_cannot_resolve_resource.md`：增加 shim 服务、Ingress、历史 pipeline catalog、PAC 默认 catalog 的排障路径。
- `docs/configure/chart-configuration.md`：更新 Ingress 默认值、catalog 镜像仓库前缀、自定义安装位置说明。
- `docs/development/catalog-artifacthub-shim-migration.md`：升级为 catalog 维护入口，链接到正式 how-to 和发布门禁。
- 从 `tektoncd-operator` 迁入的文档不得保留跨 repo markdown 直链；指回 operator 文档时使用 `ExternalSiteLink name="tektoncd-operator"`。

### tektoncd-operator 文档

当前 PR 不迁移以下文档；后续独立 PR 按本节执行。operator 文档需要指向 `artifacthub-shim` 时，统一使用 `ExternalSiteLink name="artifacthub-shim"`，不得直接写到 shim 仓库文件路径的 markdown link。

删除：

- `docs/en/development/tektoncd-hub/api.md`
- `docs/en/development/tektoncd-hub/index.md`
- `docs/en/development/tektoncd-hub/quick-start.md`
- `docs/en/hub/configure/enabling-tekton-hub.mdx`

迁移或重写后移到 artifacthub-shim：

- `docs/en/hub/configure/tekton-hub-config.mdx` 中 resolver/PAC 配置部分迁到 shim 的 Tekton 集成文档，Tekton Hub API config、category config、重启 `tekton-hub-api` 的内容删除。
- `docs/en/hub/configure/custom-catalogs.mdx` 迁到 shim 的 custom repository/source 文档，并按 shim ConfigMap source 模型重写。
- `docs/en/hub/tutorials/writing-tasks.mdx`、`writing-pipelines.mdx` 中通用 catalog authoring 内容迁到 artifacthub-shim/catalog 维护文档，Tekton Hub 特有内容删除。
- `docs/en/hub/concepts/*`、`intro.mdx`、`architecture.mdx` 重写为 artifacthub-shim/Hub 抽象说明，放在 shim 文档中；operator 侧只保留“DevOps Hub 由 artifacthub-shim 提供”的外链。

修改：

- `docs/en/concepts/tektonconfig_concept.mdx`：移除 TektonHub 作为默认组件的描述，说明 Hub 数据源由 artifacthub-shim 插件提供。
- `docs/en/pac/how_to/pac_resolver.mdx`、PAC quick start 和 troubleshooting：更新默认 `hub-url`、`hub-catalog-type`、Task/Pipeline catalog，删除公网 Tekton Hub 默认说明。
- `docs/en/development/component-quickstart/index.md`：移除 catalog/hubs-wrapper 作为 operator 自研组件的维护说明，改为链接 artifacthub-shim/cat 维护文档。
- `docs/en/development/catalog/*`：如果仍作为历史开发说明保留，需要加迁移提示；当前维护入口应转到 artifacthub-shim 或 catalog。
- 以下历史 TEP 不强行改写结论，但需要在当前用户/维护文档中补充“资源由 artifacthub-shim 同步，template-render 由 artifacthub-shim-extension 提供”的说明：
  - `docs/en/teps/catalog/0004-task-result-template.md`
  - `docs/en/teps/catalog/0005-configurable-task-images.md`
  - `docs/en/teps/catalog/0006_tasks_template_render.md`
  - `docs/en/teps/0009_send_mail_task.md`
- 若网站会直接把这些 TEP 当当前文档展示，应新增勘误段落。
- API reference：如果 4.13 保留 tombstone `TektonHub` CRD，则 `docs/en/apis/kubernetes_apis/operator/tektonhubs.mdx` 标记 deprecated；下一大版本删除 CRD 后再删除并重新生成 shared CRD 文档。

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| `/hub` Ingress 后端仍指向旧服务 | UI Hub 页面不可用 | 将既有 rewrite 后端切到 `artifacthub-shim-api`；rewrite 验证放在平台网关或插件编排测试，不在 shim API e2e 中新增 `/hub/**` smoke |
| Ingress hostless 渲染无效 | 标准插件无法创建 UI 入口 | 模板支持 host 为空时省略 host，或由插件明确注入 host |
| 缺失 `default-tekton-hub-catalog` | Artifact Hub 模式启动后解析失败 | 保留 `default-tekton-hub-catalog: catalog`，不为此改 resolver 源码 |
| 缺失 `default-kind` | 省略 kind 的历史 hub ref 失败 | 保留 `default-kind: task` |
| PAC 自动探测 shim 类型失败 | PAC 回退 Tekton Hub 类型 | 默认显式设置 `hub-catalog-type: artifacthub` |
| PAC 0.39 未设置 `hub-catalog-name` | PAC remote annotation 查社区默认 catalog | 默认显式设置 `hub-catalog-name: catalog` |
| PAC 0.39 Pipeline remote annotation 请求 `catalog` | Pipeline remote annotation 找不到 `catalog-pipelines` 资源 | shim 提供 `pipeline/catalog -> catalog-pipelines` fallback |
| 旧 TektonHub finalizer 卡住 | 升级或删除 CR 阻塞 | 保留 tombstone cleanup，所有目标分支 backport |
| 重复注册 Pipeline `catalog` source | shim source 冲突、UI 重复 | 在 lookup 层做 fallback，不重复注册 source |
| tool-image labels 被改名 | UI 动态表单无镜像候选 | 明确保留 `catalog.tekton.dev/tool-image-*` labels |
| send-mail 可见但模板不可用 | 用户运行失败或体验下降 | Phase B 用 `artifacthub-shim-extension` 提供 template-render，e2e 覆盖资源同步与 extension 消费 |

## Alternatives

### 保留 Tekton Hub 与 artifacthub-shim 共存

不采用。共存会继续维护两套数据源、两套 UI API 和两套测试路径，迁移收益变小。历史兼容只通过 shim API fallback、operator tombstone cleanup 和文档 troubleshooting 处理。

### 前端立即切换到 `/api/v1alpha1/*`

可行但不作为 P0。现有 `/hub` 是产品网关入口，rewrite 机制稳定且此前 Tekton Hub API 也是这样接入；P0 只切换后端服务目标，减少 UI、网关和业务/全局集群联动风险。

### 重复注册 Pipeline `catalog` source

不采用。当前 shim 会按 repository name 做全局重复检查，Task `catalog` 和 Pipeline `catalog` 同时存在会触发重复 source 问题，也会让 UI catalog 展示混乱。lookup fallback 更可控。

### 把 template-render 并入 artifacthub-shim API 进程

不采用。template-render 是 admission webhook 和运行时增强能力，不是 Artifact Hub API 数据源；本轮只接受在 `artifacthub-shim` 仓库内新增 `artifacthub-shim-extension` 独立组件，不并入 API 进程。

## Open Questions

- 产品编排是否保证 artifacthub-shim 在 Tekton Operator 之前安装；如果不能保证，UI 和 resolver 的错误提示需要覆盖短暂未安装状态。
- UI 安装跳转应使用哪个 ModulePlugin/ClusterPlugin 标识，global 集群场景的文档链接是否已有统一位置？
- `artifacthub-shim-extension` 除 template-render 外，后续还需要承载哪些处理逻辑；本轮先预留通用组件边界，不在名称和 chart values 中绑定单一能力。

## Concrete Change Checklist

### artifacthub-shim

- [x] chart values：新增独立 hub Ingress 配置，提供 `/hub` rewrite，后端指向 `artifacthub-shim-api`。
- [x] chart template：hub Ingress host 为空时可渲染合法 Ingress。
- [x] chart tests/gate：补 `helm lint` / `helm template` 自动化或 CI 门禁，覆盖 hostless `hubIngress`、global cluster class 和显式 class 覆盖。
- [x] values：本轮不迁移 catalog 镜像仓库前缀；后续 catalog 归属迁移时统一迁到 `devops/artifacthub-shim/hub/*`。
- [x] API/index：已增加 `pipeline/catalog -> catalog-pipelines` fallback，并覆盖无版本 fallback detail 返回 latest `manifestRaw`。
- [x] extension：新增 `artifacthub-shim-extension` 独立组件，先迁移 template-render 能力。
- [x] tests：canonical API、legacy raw API、extra resource sync import boundary、catalog resolver matrix、Hub UI compatibility 和 send-mail catalog template e2e 已纳入 artifacthub-shim 测试树。
- [ ] tests：extension admission webhook 独立 e2e 和真实 catalog 内置 `config` 目录导入长期回归。
- [x] docs：quickstart、自定义 Tekton 集成、UI Ingress、Hub 不可用 troubleshooting、历史 Pipeline catalog troubleshooting、catalog 维护文档。

### tektoncd-pipeline

- [x] `config/pipeline/resolver-patch.yaml`：设置 shim Artifact Hub API、`default-type: artifact`、`default-kind: task`、`default-tekton-hub-catalog: catalog`、默认 Task/Pipeline catalog。
- [x] tests/gate：覆盖保留 `default-tekton-hub-catalog` 和 `default-kind` 后的 Artifact Hub 解析，并验证交付产物来自叠加 patch 后的 `kustomize build config/pipeline`。

### tektoncd-pipelines-as-code

- [x] `config/pac/release.yaml`：默认 `hub-url` 指向 shim，`hub-catalog-type: artifacthub`，`hub-catalog-name: catalog`。
- [x] `upstream/pkg/params/settings/*`：本轮不改 Go 代码默认值；默认行为通过 `config/pac` 配置表达。
- [x] `config/pac/patch-*.yaml`：用 patch 表达默认配置 delta，供 operator 同步。
- [x] docs/tests：覆盖默认配置、不依赖 `/api/v1/stats`、保留 custom catalog/additional catalogs；4.0、4.2、4.6 的 PAC 0.32/0.36 标注为 PAC remote Hub annotation 不支持 artifacthub-only，如需支持该能力另行 backport provider。

### tektoncd-operator

- [x] `components.yaml`：删除 `hubs-wrapper`、`tektoncd-hub`、`catalog`。
- [x] `config/tekton-pipeline/kustomization.yaml`：删除 `hubs-wrapper.yaml`。
- [x] `config/tekton-hub/**`：移除 runtime manifests。
- [x] `config/operator/autoinstall-tektonhub.yaml`：删除自动安装入口。
- [x] `hack/update_components.sh`：复核并清理残留 catalog 特殊 skip 分支。
- [x] `values.yaml`：删除 Hub/catalog 镜像。
- [x] `devspace.yaml`：删除 TektonHub auto-install/e2e 准备，清理 `install-hub` 和 `tektonhubs.operator.tekton.dev` wait 残留。
- [x] `pre_upgrade.go`：通过 `0019-tekton-hub-artifacthub-shim-migration.patch` 注册并修改 resolver/PAC 迁移到 shim URL。
- [x] `tektonpipeline/transform.go`：避免写入空或不存在的 `TEKTON_HUB_API`。
- [x] `tektonhub` controller：改为 tombstone cleanup，不再创建 runtime InstallerSet。
- [x] `.tekton/patches`：删除旧 Tekton Hub runtime patch，保留新的 `0019-tekton-hub-artifacthub-shim-migration.patch` 作为迁移 patch，并修改 0006/0015。
- [x] follow-up e2e：已迁移 `hubs-wrapper.feature`、catalog resolver smoke、send-mail template-render 和其他 catalog/hub 场景；operator e2e 不部署 `artifacthub-shim`，保留的混合 case 已改用 local/inline fixture。
- [ ] follow-up docs：按 Documentation Plan 删除、移动、修改 operator catalog/hub 用户和维护文档；跨 repo 跳转使用 `ExternalSiteLink`。

### tektoncd-enhancement

- [x] 移除 template-render webhook 注册和 `/mutate/render/template` MutatingWebhookConfiguration。
- [x] 移除 template-render 实现包、默认配置字段和旧 e2e/testdata。
- [x] 保留 ScheduledTrigger、PAC webhook registration、enhancement API 等非 template-render 能力。

### catalog

- [ ] 后续项：全仓替换 `devops/tektoncd/hub` 到 `devops/artifacthub-shim/hub`，本轮不处理，后续 catalog 归属迁移时统一处理。
- [x] 审计并确认保留 `catalog.tekton.dev/tool-image-*` labels。
- [x] 审计并补漏 ConfigMap 资源的 `artifacthub-shim.alauda.io/import`；`config/images/kustomization.yaml` 等非资源聚合文件豁免。
- [x] 审计并补漏需要保留的 ConfigMap 的 `artifacthub-shim.alauda.io/resource-policy: keep`。
- [x] 审计并补漏正式 Task/Pipeline/StepAction manifest 的 Artifact Hub annotations；samples/testdata 不强制补。
- [ ] e2e 迁到 artifacthub-shim 并建立 LTS compatibility 矩阵。

### pipeline-v2-frontend

- [ ] i18n 文案 `Tekton Hub` 收敛为 `Hub`。
- [ ] `EnvironmentService.checkTektonHub()` 错误分类。
- [ ] Pipeline Hub tab 的不可用提示和文档链接。
- [ ] Task 列表、TaskRun 表单、Pipeline 编排选择 Task 的非阻塞降级。
- [ ] integration tests 更新场景文案和未安装/未 ready/global 集群覆盖。

### skills

- [x] 更新 Tekton pipeline/task delivery 相关 skill，补 Artifact Hub annotations 和 `type: artifact` sample 规则。
- [x] 审计并替换旧公网 API、旧 e2e 归属和 “Tekton Hub” 默认表述；`devops/tektoncd/hub` 镜像前缀按本轮决策保留为后续 catalog 归属迁移项。
