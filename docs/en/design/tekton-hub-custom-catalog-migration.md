---
title: Tekton Hub 自定义 Catalog 到 artifacthub-shim 的自动迁移
status: proposed
creation-date: "2026-07-16"
last-updated: "2026-07-20"
authors:
  - Alauda DevOps
---

# Tekton Hub 自定义 Catalog 到 artifacthub-shim 的自动迁移

## 概述

DEVOPS-44537 用于补齐 `tektoncd-operator` 下线 Tekton Hub runtime 后的存量兼容路径。
如果集群在升级前已经通过 Tekton Hub 配置过自定义 Git catalog，operator 需要在升级或
`TektonHub` reconcile 过程中读取旧配置，并生成 `artifacthub-shim` 可消费的 repository
ConfigMap。迁移完成后，公开 Git catalog 和可识别的私有 SSH catalog 应继续被
`artifacthub-shim` 同步，并继续服务 Hub resolver、Pipelines as Code 和 DevOps UI。

迁移边界必须保持收敛：

- 不恢复 Tekton Hub API、UI、PostgreSQL DB 或 catalog refresh runtime。
- 不访问公网 `api.hub.tekton.dev`、`artifacthub.io`，也不访问用户配置的
  `hubConfigUrl`。
- 不覆盖用户已经在 `artifacthub-shim` namespace 中手工维护的 repository ConfigMap。
- 不把 Secret 明文写入日志、Event、status、annotation 或 ConfigMap。
- 单个 catalog 无法迁移时，不影响其它 catalog 的迁移。

## 背景

旧 Tekton Hub 的自定义 catalog 配置主要来自两处：

- `TektonHub.spec.catalogs[]`
- 已渲染的 `tekton-hub-api` ConfigMap 中的 `data.CATALOGS`

当前 operator 会把 `TektonHub.spec.catalogs[]` 渲染成 `data.CATALOGS` YAML。一个典型旧
catalog 如下：

```yaml
name: team-a
org: platform
type: community
provider: github
url: https://git.example.com/platform/catalog.git
sshUrl: git@git.example.com:platform/catalog.git
revision: main
contextDir: catalogs/devops
```

Tekton Hub 会在 `contextDir` 下按资源类型扫描目录。旧产品路径主要处理 `Task` 和
`Pipeline`；迁移到 `artifacthub-shim` 后，还需要考虑 shim 已支持的 `StepAction`。
旧配置没有 per-catalog `kind` 字段，也没有 per-catalog `credentialRef` 字段。

`artifacthub-shim` 当前通过带 label 的 ConfigMap 读取动态 repository 配置：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: artifacthub-shim-team-a
  namespace: artifacthub-shim-system
  labels:
    artifacthub-shim.alauda.io/repository: "true"
data:
  repository.yaml: |
    gitRepositories:
      - url: https://git.example.com/platform/catalog.git
        revision: main
        credentialRef:
          name: team-a-git
        repositories:
          - name: team-a
            displayName: Team A Tasks
            kind: task
            path: catalogs/devops/task
```

## 目标

- 在旧 Tekton Hub runtime 被删除前，自动迁移存量 Tekton Hub 自定义 catalog。
- 支持公开 Git repository，以及使用旧 Hub 标准 SSH Secret 模型的私有 SSH repository。
- 尽量保留旧配置中的 catalog name、Git URL、revision、contextDir，以及可发现的
  disabled package 规则。
- 保持幂等：重复 reconcile 不产生重复配置，不覆盖用户手工配置。
- 保持 air-gap 兼容：迁移阶段只读取 Kubernetes API 中已有对象。
- 对跳过、冲突、失败、成功等迁移结果提供可观测信息，同时不泄露敏感数据。

## 非目标

- operator 不读取旧 Tekton Hub PostgreSQL 数据库。
- operator 不在迁移过程中调用 `TektonHub.spec.api.hubConfigUrl`。
- operator 不 clone 用户 Git repository 来探测 kind 目录是否存在。
- operator 不从共享 `.ssh/config` 中推断多套 SSH key 与 catalog 的映射关系。
- 本迁移不为 `artifacthub-shim` 增加跨 namespace `credentialRef`。
- 用户手工编写的 shim repository ConfigMap 默认保持严格语义，除非用户显式使用新字段。

## 当前行为

### 旧 Tekton Hub 配置

`TektonHubSpec` 中包含 `Catalogs []Catalog`。与本迁移相关的 `Catalog` 字段如下：

| 字段 | 含义 |
| --- | --- |
| `name` | 旧 Tekton Hub API 暴露的 catalog name。 |
| `url` | HTTPS Git URL。 |
| `sshUrl` | SSH Git URL。存在时 Tekton Hub 优先使用它。 |
| `revision` | clone 使用的 branch、tag 或 commit。 |
| `contextDir` | Git repository 内的 catalog 根目录。 |
| `provider`、`org`、`type` | Tekton Hub 元数据，shim 不需要。 |

operator 会把 `TektonHub.spec.catalogs[]` 渲染到 `tekton-hub-api` ConfigMap 的
`data.CATALOGS`。旧 reconciler 里仍保留 `hubConfigUrl` 逻辑，并会通过 `http.Get` 读取远端
配置；但本设计明确不把这条网络路径纳入迁移，因为升级必须能在 air-gap 集群中完成，且不应依赖外部服务。

### 旧 Tekton Hub SSH 凭据

旧 Tekton Hub 不在 `Catalog` 中保存 Secret 名称。标准部署方式是把可选 Secret
`tekton-hub-api-ssh-crds` 挂载到 `tekton-hub-api` Pod 的 `/home/hub/.ssh`：

```yaml
volumes:
  - name: ssh-creds
    secret:
      secretName: tekton-hub-api-ssh-crds
      optional: true
containers:
  - name: tekton-hub-api
    volumeMounts:
      - name: ssh-creds
        mountPath: /home/hub/.ssh
```

当 catalog 配置了 `sshUrl` 时，Tekton Hub 使用该 SSH URL clone，并依赖 Pod 中挂载的
`.ssh` 目录。因此，存量环境里通常只有一个 namespace 级别的 SSH Secret，而不是每个
catalog 单独引用一个 Secret。

`artifacthub-shim` 的模型不同：Git repository entry 通过 `credentialRef.name` 引用
repository ConfigMap 所在 namespace 中的 Secret：

```yaml
credentialRef:
  name: team-a-git
```

shim 当前支持以下 Secret key：

- HTTPS：`username`、`password`、`token`
- SSH：`sshPrivateKey` 或 `ssh-privatekey`，以及 `known_hosts`
- CA bundle：`ca.crt`

### 当前 source 错误隔离

`artifacthub-shim` 已经具备 source 级错误隔离：

- 动态 ConfigMap 解析失败会变成 source status，不会阻塞其它有效 ConfigMap。
- 某个 source load 或 index 失败时，该 source 被标记为 `Invalid`。
- 如果该 source 之前有成功 shard，且 source spec 没有变化，临时失败会标记为
  `Degraded`，并继续服务 last-good 内容。
- 其它 source 仍继续发布到同一个 snapshot。

因此，本文后续提出的 `optional` source 不是为了解决 source 隔离。它的目的只是兼容旧
Tekton Hub 的目录语义：operator 在不 clone 用户 Git repository 的前提下，无法知道
`task/`、`pipeline/`、`stepaction/` 哪些目录存在。

## 目标架构

迁移由 operator 和 shim 两侧配合完成：

- `tektoncd-operator` 负责发现旧 Hub catalog 配置，写入 shim repository ConfigMap，并把可识别的旧 SSH Secret 复制到 shim namespace。
- `artifacthub-shim` 负责接受迁移生成的 repository 配置，并补齐三个兼容能力：
  - repository identity 继续使用全局 `name`，保持与 Artifact Hub repository 模型兼容；
  - operator 生成的 optional kind entry 在目录缺失时可以发布 `Ready` 且 packages 为 0；
  - Pipeline 和 StepAction source 可以显式声明 legacy catalog alias，让旧 Hub 引用继续通过旧 catalog name 查询。

## Operator 迁移流程

### 触发点

迁移 helper 应接入两个位置，并共用同一套实现：

- `TektonConfig` pre-upgrade：覆盖标准 ACP 升级路径。
- `TektonHub.ReconcileKind`：在旧 `tekton-hub-api` 资源被删除前执行，覆盖只有
  `TektonHub` CR 或旧渲染 ConfigMap 可用的环境。

两个触发点必须调用同一个 helper，避免行为分叉。

### 旧配置发现

helper 按以下顺序发现旧 catalog：

1. 列出 `TektonHub` CR，读取 `spec.catalogs[]`。
2. 按每个 TektonHub 的 target namespace 读取 `tekton-hub-api` ConfigMap。
3. 如果存在 `data.CATALOGS`，则按 YAML 解析为 legacy catalog entries。

helper 不调用 `hubConfigUrl`。如果某个集群只依赖远端 `hubConfigUrl`，但集群内没有已渲染的
`data.CATALOGS`，迁移只记录 warning 并跳过。相比在升级 controller 中引入网络 I/O，这是更安全的行为。

### 去重规则

同一个 catalog 可能同时出现在 CR 和已渲染 ConfigMap 中。去重 key 为：

```text
lower(name) + "\x00" + effectiveURL + "\x00" + revision + "\x00" + contextDir
```

其中 `effectiveURL` 是 `sshUrl` 非空时取 `sshUrl`，否则取 `url`。

CR 与 ConfigMap 冲突时优先 CR，因为 CR 是用户声明式来源；ConfigMap 只作为旧 runtime 已渲染状态的兜底。

### 字段映射

| 旧字段 | shim 字段 | 规则 |
| --- | --- | --- |
| `name` | Task 的 `repositories[].name` | 保持旧 catalog name。 |
| `name` | Pipeline 的 `repositories[].name` | 生成 `<name>-pipelines`，作为 Artifact Hub 兼容的 canonical repository name。 |
| `name` | StepAction 的 `repositories[].name` | 生成 `<name>-stepactions`，作为 Artifact Hub 兼容的 canonical repository name。 |
| `name` | Pipeline/StepAction 的 `repositories[].legacyCatalogAliases[]` | 填入旧 catalog name，允许旧引用继续访问迁移后的 canonical repository。 |
| `name` | `repositories[].displayName` | 分别渲染为 `<name> Tasks`、`<name> Pipelines`、`<name> StepActions`。 |
| `sshUrl` | `gitRepositories[].url` | 非空时优先使用，保留 SSH clone 行为。 |
| `url` | `gitRepositories[].url` | `sshUrl` 为空时使用；如果包含 userinfo，则拒绝迁移该 catalog。 |
| `revision` | `gitRepositories[].revision` | 非空时使用原值；为空时回退 `main` 并记录 warning。 |
| `contextDir` | `repositories[].path` | `path.Join(contextDir, kind)`；空 `contextDir` 映射为 `task`、`pipeline`、`stepaction`。 |
| `disabledPackages` | `repositories[].disabledPackages` | 标准 CR 无此字段；仅当旧 `CATALOGS` YAML 显式携带时透传。 |
| 旧 SSH Secret | `credentialRef.name` | 引用复制到 shim namespace 后的 Secret。 |

### 生成的 ConfigMap

operator 在 shim watch namespace 中维护一个专用迁移 ConfigMap：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: artifacthub-shim-legacy-tekton-hub-catalogs
  namespace: artifacthub-shim-system
  labels:
    artifacthub-shim.alauda.io/repository: "true"
    operator.tekton.dev/managed-by: tekton-operator
    operator.tekton.dev/migrated-from: tekton-hub
  annotations:
    operator.tekton.dev/migration-source: DEVOPS-44537
    operator.tekton.dev/generated-hash: <sha256>
data:
  repository.yaml: |
    gitRepositories:
      - url: git@git.example.com:platform/catalog.git
        revision: main
        credentialRef:
          name: artifacthub-shim-legacy-tekton-hub-ssh-creds
        repositories:
          - name: team-a
            displayName: Team A Tasks
            kind: task
            path: catalogs/devops/task
            optional: true
          - name: team-a-pipelines
            displayName: Team A Pipelines
            kind: pipeline
            path: catalogs/devops/pipeline
            optional: true
            legacyCatalogAliases:
              - team-a
          - name: team-a-stepactions
            displayName: Team A StepActions
            kind: stepaction
            path: catalogs/devops/stepaction
            optional: true
            legacyCatalogAliases:
              - team-a
```

这个 ConfigMap 是本迁移唯一由 operator 管理的 shim repository ConfigMap。operator 不修改用户已有的 repository ConfigMap。

### 幂等策略

operator 将生成内容的 hash 写入 `operator.tekton.dev/generated-hash`。

- 迁移 ConfigMap 不存在：创建。
- ConfigMap 存在，且存储的 hash 与当前内容匹配：允许根据新生成内容更新。
- ConfigMap 存在，但存储的 hash 与当前内容不匹配：视为用户手动修改，停止覆盖并记录 warning。
- 冲突过滤后没有任何 entry：不创建空的迁移 ConfigMap。

## Secret 迁移设计

### 决策：复制并规范化

对于旧 Git SSH 凭据，迁移策略是：operator 从 TektonHub target namespace 读取可识别的旧
Secret，复制到 shim namespace，并规范化为 shim 支持的 credential Secret 格式。

这直接回答 Secret 处理问题：如果旧 Tekton Hub 配置引用或隐式使用了 Git Secret，迁移时应复制到
`artifacthub-shim` namespace 下，repository ConfigMap 只引用复制后的 Secret。

不采用跨 namespace `credentialRef`，原因是它会扩大 shim 的 Secret 读取面，要求新增 namespace 字段和
RBAC，也会让用户更难审计某个 shim source 实际读取了哪个 namespace 的敏感数据。

### 源 Secret 发现

仅当至少一个迁移 catalog 使用 `sshUrl` 时，operator 才尝试迁移 SSH Secret。

源 Secret 按以下顺序查找：

1. `TektonHub` 或旧 `tekton-hub-api` ConfigMap annotation 中显式指定的 Secret：
   `operator.tekton.dev/legacy-git-credential-secret`。
2. 旧 Hub 标准 Secret：`tekton-hub-api-ssh-crds`。

私有 HTTPS repository 无法自动迁移，因为旧 `Catalog` 字段没有保存 HTTPS credential Secret 名称。
如果旧 URL 中包含内联凭据，例如 `https://user:token@host/repo.git`，operator 跳过该 catalog，并提示用户改用 Secret。

### 规范化规则

旧 Hub Secret 是 `.ssh` 目录挂载模型，可能包含以下 key：

- `sshPrivateKey`
- `ssh-privatekey`
- `id_rsa`
- `id_ed25519`
- `known_hosts`
- `config`

复制后的 shim Secret 使用以下形态：

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: artifacthub-shim-legacy-tekton-hub-ssh-creds
  namespace: artifacthub-shim-system
  labels:
    operator.tekton.dev/managed-by: tekton-operator
    operator.tekton.dev/migrated-from: tekton-hub
  annotations:
    operator.tekton.dev/generated-hash: <sha256>
type: Opaque
data:
  sshPrivateKey: <copied-private-key>
  known_hosts: <copied-known-hosts>
```

规则如下：

- 如果源 Secret 已有 `sshPrivateKey` 或 `ssh-privatekey`，复制为 `sshPrivateKey`。
- 如果两者都不存在，但只有一个 `id_rsa` 或 `id_ed25519`，复制为 `sshPrivateKey`。
- 如果同时存在多个私钥候选 key，operator 不猜测，跳过 Secret 迁移并记录 warning。
- `known_hosts` 必须存在。缺失时不创建复制 Secret，也不生成宽松的 SSH host key 配置。
- 不复制 `.ssh/config`，因为其中可能包含 host alias、proxy command、identity file 等无法安全转换的客户端逻辑。
- 不在日志、Event、status、annotation 或 ConfigMap 中打印 Secret 明文或派生凭据内容。

### Secret 幂等

目标 Secret 名称为：

```text
artifacthub-shim-legacy-tekton-hub-ssh-creds
```

目标 Secret 使用与 ConfigMap 一致的 ownership label 和 generated hash 策略：

- 目标 Secret 不存在：创建。
- 目标 Secret 存在且带 migration ownership：仅当规范化后的源数据 hash 变化时更新。
- 目标 Secret 存在但不带 migration ownership：不覆盖。相关 catalog 仍可迁移，但需要明确记录 credential conflict warning。

对于 `sshUrl` catalog，operator 不在迁移阶段 clone repository，因此无法判断它是否公开可读。更安全的默认行为是保留
catalog entry，并清晰记录 credential warning；如果 repository 实际需要认证，shim 后续会把该 source 标记为
`Invalid`。

## Optional Source 语义

### 为什么需要 Ready 且 0 packages

这个设计不是为了解决“一个 source 失败会影响其它 source”的问题。shim 当前已经能隔离 source 失败。

真正的问题是旧 Hub 与 shim 的语义不一致：

- 旧 Tekton Hub 是一个 catalog declaration 下扫描多个 kind 目录。如果 `contextDir/pipeline` 不存在，用户通常理解为“这个 catalog 没有 Pipeline”。
- shim 是一个 kind 一个 source。迁移时 operator 必须决定要生成哪些 kind source。
- operator 不应在升级路径中 clone 用户 Git repository 来探测 `task/`、`pipeline/`、`stepaction/` 是否存在。

如果 operator 为所有可能 kind 都生成 source，但 shim 没有 optional 语义，那么一个只有 `task/` 目录的旧 catalog
会在迁移后长期出现 `pipeline` 和 `stepaction` 的 `Invalid`。这不会影响 `task` source，也不会影响其它 source，
但会产生持续 Event 和日志，误导运维认为迁移失败。

### 新增 schema

在 repository entry 中新增可选字段：

```yaml
repositories:
  - name: team-a-pipelines
    kind: pipeline
    path: catalogs/devops/pipeline
    optional: true
    legacyCatalogAliases:
      - team-a
```

`optional` 默认值为 `false`。

只有 operator 自动迁移生成的 entries 默认设置 `optional: true`。用户手工编写的 repository ConfigMap 默认仍是严格模式，
除非用户显式配置该字段。

### 运行时行为

当 `optional=true` 时：

- Git checkout 成功，但 `path` 不存在：source 发布为 `Ready`，`packages=0`，`versions=0`。
- `path` 存在但为空：source 发布为 `Ready`，`packages=0`，`versions=0`。
- 日志增加类似 `optional_source_empty=true` 的结构化字段，便于区分普通 Ready 与 optional empty Ready。

`optional=true` 不吞掉真实错误：

- Git clone 或 fetch 失败仍然是 `Invalid` 或 `Degraded`。
- Secret 不存在或认证失败仍然是 `Invalid` 或 `Degraded`。
- path 校验失败、symlink escape、非法 manifest、多 manifest 候选、kind/name mismatch、duplicate package 等内容错误仍然报错。
- index 阶段冲突仍然报错。

因此，`Ready/0 packages` 只表达“该 kind 目录为空或不存在是允许的”，不改变 shim 既有 source 错误隔离策略。

## Repository Identity 与 Legacy Alias 兼容性

旧 Hub API 路径同时包含 catalog 和 kind：

```text
/v1/resource/<catalog>/<kind>/<name>
```

同一个旧 catalog name 可以同时包含 Task、Pipeline 和 StepAction。但 Artifact Hub 的 repository
name 是对外 repository identity，不能把不同 kind 的 repository 全部注册成同一个 name。shim
也已经在 repository ConfigMap validation、refresh desired-source conflict filtering、index builder
duplicate repository detection 中把 repository `name` 当作全局唯一键。

因此，本迁移不把 repository identity 调整为 `kind + name`。operator 生成全局唯一的 canonical
repository name，并通过显式 legacy alias 保留旧 Hub 查询路径：

```yaml
repositories:
  - name: team-a
    kind: task
    path: catalogs/devops/task
  - name: team-a-pipelines
    kind: pipeline
    path: catalogs/devops/pipeline
    legacyCatalogAliases:
      - team-a
```

`legacyCatalogAliases` 是可选字段，默认空列表。它只影响 resolver/API/UI lookup，不改变 source
的 canonical repository name，也不出现在 Artifact Hub repository 列表里作为独立 repository。
成功通过 alias 查询时，返回内容仍使用 resolved canonical repository name，例如
`team-a-pipelines`。

查询规则：

- 先按请求中的 kind、catalog、resource name 做 canonical lookup。
- canonical lookup 不存在时，再按相同 kind 的 legacy alias registry 查找 canonical repository。
- alias registry 按 `lower(kind) + "\x00" + lower(alias)` 建立，大小写不敏感。
- alias 在同一 kind 下指向多个 canonical repository，或与同一 kind 的其它 canonical repository name 冲突时，只禁用该 alias；canonical source 继续服务并通过 status warning、Event、日志和 metric 暴露冲突。
- alias 与自己的 canonical repository name 相同时视为冗余配置并忽略。
- 内置 `pipeline/catalog -> pipeline/catalog-pipelines` 兼容也应通过同一套 alias lookup helper 声明，避免内置兼容和用户兼容行为分叉。

预期行为：

- `task/team-a` 是 canonical repository lookup。
- `pipeline/team-a-pipelines` 是 canonical repository lookup。
- `pipeline/team-a` 在 canonical lookup 不存在时，通过 legacy alias 回落到 `pipeline/team-a-pipelines`。
- 新引用应使用 canonical repository name；legacy alias 只用于升级兼容。

## 用户配置冲突处理

写入迁移 ConfigMap 前，operator 会列出 shim watch namespace 中已有的 repository ConfigMap，并解析其中的
`repository.yaml`。

对每个生成 entry：

- 如果用户已有 ConfigMap 声明了相同的 canonical repository `name`，跳过该 entry。
- 如果用户已有 ConfigMap 在同一 kind 下声明了相同的 canonical name 或 legacy alias，跳过会产生该 alias 的 entry。
- 不覆盖或删除用户 ConfigMap。
- 无冲突 entry 继续迁移。
- 日志记录冲突的 kind、canonical repository name、legacy alias、namespace、ConfigMap name。
- URL 中的 userinfo 必须脱敏，Secret 数据绝不打印。

如果某个用户 ConfigMap 无法解析，operator 不应假设该用户配置想占用哪些 name。operator 记录解析失败，并基于其它可解析的
ConfigMap 继续迁移。shim 侧已经会用 `RepositoryConfigInvalid` 暴露该用户 ConfigMap 的问题。

## 可观测性

operator 日志和 Event 应覆盖以下场景：

- `migration skipped: no legacy Tekton Hub catalog found`
- `migration configmap created`
- `migration configmap updated`
- `migration configmap not overwritten because it was user edited`
- `migration entry skipped due to user conflict`
- `migration entry skipped due to legacy alias conflict`
- `legacy catalog skipped because URL contains inline credentials`
- `legacy SSH Secret copied`
- `legacy SSH Secret skipped: source Secret not found`
- `legacy SSH Secret skipped: missing known_hosts`
- `legacy SSH Secret skipped: multiple private keys`
- `legacy SSH Secret skipped: target Secret is user managed`

shim 侧继续使用已有 ConfigMap Event reason：

- `RepositoryConfigAccepted`
- `RepositoryConfigInvalid`
- `RepositorySourceReady`
- `RepositorySourceInvalid`
- `RepositorySourceDegraded`
- `RepositoryAliasConflict`

对于 optional missing-path source，shim 应记录 `RepositorySourceReady`，且 packages 和 versions 均为 0。

## 安全设计

- 不在日志、Event、annotation、status 或 ConfigMap 中输出 Secret data。
- 不把 Secret data 或派生 credential payload 存入非 Secret 对象。
- 拒绝迁移带 URL userinfo 的 Git URL，避免继续传播内联凭据。
- 不复制 `.ssh/config`。
- SSH credential 必须有 `known_hosts`。
- 不为 shim 增加跨 namespace Secret 读取能力。
- operator 只读取 TektonHub target namespace 中由显式 annotation 指定的 Secret，或标准旧 Secret
  `tekton-hub-api-ssh-crds`。
- 复制 Secret 和生成 ConfigMap 均带 migration ownership label，便于审计和后续清理。

## Air-gap 行为

operator 迁移阶段只读取 Kubernetes API 对象：

- `TektonHub` CR；
- `tekton-hub-api` ConfigMap；
- 可选的旧 SSH Secret；
- shim watch namespace 中已有 repository ConfigMap。

operator 不 clone Git repository，不调用 `hubConfigUrl`，不访问公网 Hub 服务，也不访问用户 Git server。Git clone 仍由
`artifacthub-shim` 正常 refresh loop 负责。

## 实现要点

### artifacthub-shim

需要调整的数据模型：

- 在 `repository.RepositoryConfig` 中新增 `Optional bool`。
- 在 `repository.RepositoryConfig` 中新增 `LegacyCatalogAliases []string`。
- 在 `source.RepositorySource` 中新增 `Optional bool`。
- 在 `source.RepositorySource` 中新增 `LegacyCatalogAliases []string`。
- YAML 字段保持可选，`optional` 默认值为 false，`legacyCatalogAliases` 默认空列表，保证向后兼容。

需要调整的校验：

- 保持 `name`、`kind`、`path` 必填校验。
- 保持 duplicate repository 检查基于全局 canonical `name`，不改为 `kind + name`。
- 校验 `legacyCatalogAliases[]` 非空、无换行；self alias 直接忽略，跨 source 冲突在 index 阶段禁用 alias，但不拒绝 source。
- 继续拒绝绝对路径和 escape repository root 的相对路径。

需要调整的加载行为：

- 当 `Optional` 为 true，且 filesystem scan 读取 source root 时遇到 `os.ErrNotExist`，返回空的
  `SourceSnapshot`，不返回错误。
- 对已存在路径，保留 symlink、manifest、indexing 等所有既有校验。

需要调整的 status 行为：

- optional empty snapshot 成功构建 Ready shard，packages 为 0。
- source status key 保持稳定，并继续包含已有 ownership 信息。

需要调整的 lookup 行为：

- 抽取通用 catalog alias lookup helper，供 Artifact Hub detail、UI detail、UI batch、legacy raw YAML API 共同调用。
- 将内置 `pipeline/catalog -> pipeline/catalog-pipelines` 兼容迁移到同一 helper。
- 通过 alias 命中时记录 requested repository、resolved repository、kind、name、version，并增加可观测计数。

### tektoncd-operator

需要新增或调整的组件：

- legacy catalog reader：读取 `TektonHub.spec.catalogs[]`。
- rendered ConfigMap reader：读取 `tekton-hub-api` `data.CATALOGS`。
- migration planner：负责去重、字段映射、用户冲突检测，并生成一个 shim repository payload。
- Secret copier/normalizer：复制并规范化旧 SSH Secret。
- idempotent writer：幂等写入迁移 ConfigMap 和复制后的 Secret。

建议常量：

```text
MigrationConfigMapName  = artifacthub-shim-legacy-tekton-hub-catalogs
MigrationSecretName     = artifacthub-shim-legacy-tekton-hub-ssh-creds
LegacySSHSecretName     = tekton-hub-api-ssh-crds
LegacySecretAnnotation  = operator.tekton.dev/legacy-git-credential-secret
GeneratedHashAnnotation = operator.tekton.dev/generated-hash
```

shim namespace 应优先来自 operator 对 artifacthub-shim 安装位置的配置；标准安装下为
`artifacthub-shim-system`。

## 测试计划

### operator 单元测试

- `TektonHub.spec.catalogs[]` 中公开 HTTPS catalog 能生成 repository ConfigMap。
- 旧 `tekton-hub-api` ConfigMap 的 `data.CATALOGS` 可解析并迁移。
- CR 与 ConfigMap 同时存在时优先 CR 并去重。
- 无旧 catalog 时不创建迁移 ConfigMap。
- 重复执行迁移不产生重复 entries。
- 生成的 Pipeline entry 使用 `<name>-pipelines`，并带 `legacyCatalogAliases: [<name>]`。
- 生成的 StepAction entry 使用 `<name>-stepactions`，并带 `legacyCatalogAliases: [<name>]`。
- 用户已有 ConfigMap 中存在相同 canonical repository `name` 时，只跳过对应 entry。
- 用户已有 ConfigMap 中存在同一 kind 的 alias 冲突时，只跳过会产生该 alias 的 entry。
- 已存在非 managed 迁移 ConfigMap 时不覆盖。
- managed 迁移 ConfigMap 被用户手改后不覆盖。
- URL userinfo 导致 catalog 被跳过。
- `revision` 为空时回退 `main` 并记录 warning。
- `sshUrl` catalog 会把 `tekton-hub-api-ssh-crds` 复制到 shim namespace。
- SSH Secret 缺少 `known_hosts` 时跳过。
- SSH Secret 存在多个私钥候选时跳过。
- 目标 Secret 已由用户管理时不覆盖。
- `TektonHub.ReconcileKind` 在旧 Hub 资源删除前执行迁移。

### artifacthub-shim 单元测试

- `repositories[].optional` 可解析到 source definition。
- `optional=false` 且 path 不存在时保持 `Invalid`。
- `optional=true` 且 path 不存在时为 `Ready`，packages 和 versions 为 0。
- `optional=true` 且 path 存在但为空时为 `Ready`，packages 和 versions 为 0。
- `optional=true` 时 Git clone、认证、symlink、manifest 错误仍为 invalid 或 degraded。
- `repositories[].legacyCatalogAliases` 可解析到 source definition。
- repository `name` 仍保持全局唯一，同名不同 kind repository 仍冲突。
- 同一 kind 下指向不同 canonical repository 的重复 legacy alias 不注册，相关 canonical source 仍为 Ready 并携带 warning。
- canonical lookup 优先于 legacy alias lookup。
- 内置 `pipeline/catalog` 回落和用户 legacy alias 共用同一个 helper。
- Resolver 和 UI lookup 路径可通过 legacy alias 查询迁移后的 canonical repository。

### 集成场景

- 公开 Git catalog：operator 升级后，shim 可以索引迁移后的 Task 和 Pipeline，UI/resolver 可查询。
- 私有 SSH catalog：旧 namespace 中存在 `tekton-hub-api-ssh-crds`；升级后 operator 在
  `artifacthub-shim-system` 创建复制 Secret，shim 同步成功。
- 只有 task 目录的旧 catalog：生成的 Pipeline 和 StepAction optional source 显示 `Ready/0`，Task source 正常发布 packages。
- 用户已手工配置 `task/team-a`：operator 跳过迁移中的 `task/team-a` entry，但继续迁移
  `team-a-pipelines` 等无冲突 entries。
- 旧 Pipeline 引用仍使用 `catalog: team-a`：shim 通过 legacy alias 返回 `team-a-pipelines` 中的 Pipeline。

## 发布步骤

1. 合入本设计文档。
2. 在 artifacthub-shim 中实现 `optional` 和 legacy catalog alias。
3. 在 tektoncd-operator 中实现迁移 helper 和 SSH Secret 规范化复制逻辑。
4. 增加 operator 与 shim 单元测试。
5. 在升级环境中验证公开 catalog、私有 SSH catalog、无旧自定义 catalog 三类场景。

## 待确认问题

- 后续是否需要支持用户通过 annotation 指定多个 legacy SSH Secret，并按 catalog name 做映射。本设计暂不支持，因为旧 Hub 标准模型没有 per-catalog Secret 字段，自动映射容易误判。
- 是否需要通过显式 annotation 支持 HTTPS username/password/token Secret 迁移。旧 Hub 标准模型没有对应字段，因此自动发现不在本次范围内。
- 后续版本是否需要提供清理迁移 ConfigMap 和复制 Secret 的工具。本需求只保证升级后继续可用，不自动清理。
