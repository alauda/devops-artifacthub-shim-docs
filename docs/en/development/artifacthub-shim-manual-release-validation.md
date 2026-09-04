# Manual Release Validation in Split-Control-Plane Environments

This guide describes how to validate an `artifacthub-shim` release when the
target ACP environment cannot run the normal release Pipeline. It preserves the
Pipeline's package, installation, test, and report contracts while running the
test harness from a trusted workstation.

Use the [automated release validation guide](artifacthub-shim-automated-release-validation.md)
for the normal multi-environment release path. Use this manual procedure only
when the Pipeline cannot run or when the global and workload APIs require
different kubeconfigs.

The procedure is intended for environments where the global cluster API and a
managed workload cluster API require different kubeconfigs. It does not replace
the security, compatibility, or release-approval gates.

## Safety and scope

- Test the frozen plugin package and test-image package produced for the release
  candidate. Do not rebuild or silently substitute images during validation.
- Use a test binary built from the exact source revision under review.
- Keep kubeconfigs, platform credentials, registry credentials, Connector
  material, and generated test configuration outside the repository.
- Never print Secret data or flattened kubeconfig contents to logs.
- Preserve manifest and image scan evidence. An unresolved Critical or High
  finding remains a release blocker even when the E2E suite passes.
- Run the complete installed-plugin suite with `TAGS='~@install'`. Narrower
  selectors are useful for diagnosis but are not equivalent release evidence.
- Retain the installed plugin after the run unless the environment owner asks
  for its removal. Remove only temporary fixtures, credentials, staging Pods,
  PVCs, and local generated configuration.

## Required inputs

Prepare the following values before changing the target environment:

| Input                             | Purpose                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------- |
| Frozen plugin version and package | Identifies the exact release candidate                                       |
| Frozen E2E image tag and package  | Supplies the runner and air-gapped fixture images                            |
| Source revision                   | Must match the prebuilt E2E binary                                           |
| Global-cluster kubeconfig         | Reads `ModulePlugin`, `ModuleConfig`, and generated `ModuleInfo` objects     |
| Workload-cluster kubeconfig       | Creates `ClusterPluginInstance` and runs E2E resources                       |
| External-toolchain test config    | Supplies GitLab, Harbor, Nexus, and SonarQube test coordinates               |
| Platform address and credentials  | Used by Violet to import packages                                            |
| Existing report Connector         | Uploads Allure artifacts without exposing object-storage credentials locally |
| Report base URL                   | Must be the same browser-visible base used by the release Pipeline           |

Use placeholders instead of environment-specific paths in reusable scripts:

```bash
# GLOBAL_KUBECONFIG accesses the ACP global cluster.
export GLOBAL_KUBECONFIG=/secure/path/global.kubeconfig
# WORKLOAD_KUBECONFIG accesses the managed workload cluster directly.
export WORKLOAD_KUBECONFIG=/secure/path/workload.kubeconfig
# BASE_TEST_CONFIG contains the existing external-toolchain test configuration.
export BASE_TEST_CONFIG=/secure/path/test-config.yaml
# PLUGIN_VERSION is the frozen version visible in ModuleConfig.
export PLUGIN_VERSION='<plugin-version>'
# E2E_TAG is the frozen auxiliary image tag imported by Violet.
export E2E_TAG='<e2e-tag>'
```

## Preflight

Confirm that both APIs are independently reachable and that the workload
cluster has the resources needed by the release suite:

```bash
kubectl --kubeconfig "$GLOBAL_KUBECONFIG" get moduleplugins
kubectl --kubeconfig "$WORKLOAD_KUBECONFIG" get nodes
kubectl --kubeconfig "$WORKLOAD_KUBECONFIG" get storageclass
kubectl --kubeconfig "$WORKLOAD_KUBECONFIG" get tektonconfig
```

Verify the candidate is available before creating an installation object:

```bash
kubectl --kubeconfig "$GLOBAL_KUBECONFIG" \
  get moduleplugin artifacthub-shim -o jsonpath='{.status.latestVersion}{"\n"}'

kubectl --kubeconfig "$GLOBAL_KUBECONFIG" \
  get "moduleconfig/artifacthub-shim-${PLUGIN_VERSION}"
```

The advertised latest version and the selected `ModuleConfig` must both match
the frozen candidate. Stop if they do not match. Creating a
`ClusterPluginInstance` otherwise may install a different version.

Also check that the target is clean or deliberately being upgraded:

```bash
kubectl --kubeconfig "$WORKLOAD_KUBECONFIG" \
  get clusterplugininstance artifacthub-shim

kubectl --kubeconfig "$GLOBAL_KUBECONFIG" get moduleinfo \
  -l cpaas.io/module-name=artifacthub-shim
```

## Import frozen packages with Violet

Use the package archives produced for the release candidate. Import both the
plugin package and the auxiliary test-image package. Prefer a platform CA file
through `SSL_CERT_FILE`; do not disable TLS verification or add credentials to a
script.

For each package, verify these phases in the Violet output:

1. Violet is ready.
2. The package is parsed successfully.
3. Authentication succeeds.
4. The push succeeds.

After the plugin package is imported, wait for the exact `ModuleConfig` shown in
the preflight commands. An auxiliary package with `isThirdParty: true` is
imported below the target registry's `3rdparty/` repository prefix. The source
repository and tag remain unchanged beneath that prefix.

## Install with two kubeconfigs

The automated release script normally assumes one gateway kubeconfig can reach
both the global and managed-cluster API routes. In a split-control-plane
environment, reproduce the platform's resource model explicitly:

1. Create the platform-managed `ClusterPluginInstance` on the workload cluster.
2. Let the cluster transformer create the corresponding `ModuleInfo` on the
   global cluster.
3. Validate the generated `ModuleInfo` and its AppRelease status from the global
   cluster.

Create the workload-side request:

```yaml
apiVersion: cluster.alauda.io/v1alpha1
kind: ClusterPluginInstance
metadata:
  name: artifacthub-shim
  labels:
    create-by: cluster-transformer
    manage-update-by: cluster-transformer
    manage-delete-by: cluster-transformer
  annotations:
    cpaas.io/display-name: artifacthub-shim
spec:
  pluginName: artifacthub-shim
```

Apply it only with the workload kubeconfig:

```bash
kubectl --kubeconfig "$WORKLOAD_KUBECONFIG" apply \
  -f clusterplugininstance.yaml
```

Do not create a second `ModuleInfo` manually. Locate the generated object by its
stable labels:

```bash
# WORKLOAD_CLUSTER_NAME is the cluster name stored on the generated ModuleInfo.
export WORKLOAD_CLUSTER_NAME='<managed-cluster-name>'

kubectl --kubeconfig "$GLOBAL_KUBECONFIG" get moduleinfo \
  -l "cpaas.io/cluster-name=${WORKLOAD_CLUSTER_NAME},cpaas.io/module-name=artifacthub-shim"
```

Installation is ready only when all of the following are true:

- `spec.version` and `status.version` equal `PLUGIN_VERSION`.
- `status.phase` is `Running`.
- Every `status.appReleases` entry has `ready: true`, `synced: true`, and
  `failed: false`.
- The API and extension Deployments on the workload cluster have all desired
  replicas ready.

This check keeps the generated object name out of automation:

```bash
kubectl --kubeconfig "$GLOBAL_KUBECONFIG" get moduleinfo \
  -l "cpaas.io/cluster-name=${WORKLOAD_CLUSTER_NAME},cpaas.io/module-name=artifacthub-shim" \
  -o json | jq -e --arg version "$PLUGIN_VERSION" '
    (.items | length) == 1 and
    .items[0].spec.version == $version and
    .items[0].status.version == $version and
    .items[0].status.phase == "Running" and
    (.items[0].status.appReleases | length) > 0 and
    all(.items[0].status.appReleases[];
      .ready == true and .synced == true and .failed == false)
  '
```

## Resolve air-gapped image references

Read the target registry address from the workload cluster instead of copying a
host from another environment:

```bash
# REGISTRY_HOST is the target ACP registry authority.
export REGISTRY_HOST="$(kubectl --kubeconfig "$WORKLOAD_KUBECONFIG" \
  -n kube-public get configmap global-info \
  -o jsonpath='{.data.registryAddress}')"
# REGISTRY_TEST includes Violet's prefix for the third-party auxiliary package.
export REGISTRY_TEST="${REGISTRY_HOST}/3rdparty"
```

Before starting E2E, verify the exact imported tags through the authenticated
registry API or a disposable pull probe. In particular, validate:

- `${REGISTRY_TEST}/alauda-pipelines-catalog/artifacthub-shim-e2e:${E2E_TAG}`
- `${REGISTRY_TEST}/base-images/busybox:<frozen-tag>`
- `${REGISTRY_TEST}/base-images/ubuntu:<frozen-tag>`

A `NotFound` error without the `3rdparty/` segment indicates a repository mapping
problem, not a failed Violet import. Fix the reference and rerun fixture setup;
do not repackage the frozen candidate.

### Restore image-baked fixture data

A source export may not contain generated fixture payloads that are created
only while building the E2E image. For example, the Maven dependency seed is
baked into `testing/maven-seed` by the E2E Containerfile. Missing this directory
causes external-toolchain preparation to fail before the suite starts.

Copy the payload from the exact frozen E2E image into the scratch source tree.
Verify every file with the image-provided `SHA256SUMS` before running the test:

```bash
# E2E_CONTAINER is a temporary Pod or local container using the frozen image.
export E2E_CONTAINER='<temporary-container>'

kubectl --kubeconfig "$WORKLOAD_KUBECONFIG" cp \
  "${E2E_CONTAINER}:/opt/artifacthub-shim/testing/maven-seed/." \
  "$SOURCE_DIR/testing/maven-seed"

cd "$SOURCE_DIR/testing/maven-seed/repository"
sha256sum -c ../SHA256SUMS
```

Delete the temporary container after the copy. Keep the seed outside Git and
remove it with the other local test material. Do not regenerate the dependency
closure from the Internet: doing so would change the frozen test input and
would not prove air-gapped behavior.

## Bootstrap missing external toolchains in the target environment

An adopted workload cluster may not have the Harbor, Nexus, or SonarQube
operators used by the release suite. Reproduce the operator package versions
and installation order from the reviewed release Pipeline instead of selecting
whatever version is newest in another environment. Reuse an existing GitLab
when it satisfies the suite's API and credential requirements; deploying a
second GitLab adds substantial setup and cleanup cost without improving the
validation.

When the workstation cannot reach the identity or upload endpoint used by
Violet, run a short-lived Violet Job inside the target environment. The Job may
download only the reviewed operator packages used by the release Pipeline and
push them to the target platform. Supply platform and registry credentials from
Kubernetes Secrets at runtime. Do not place credentials in the Job manifest,
shell arguments, ConfigMaps, logs, or retained artifacts. Record the package
name, version, digest, and successful push status, then delete the Job and its
temporary credentials.

Treat successful package upload as an asynchronous catalog operation. Before
creating a Subscription:

1. Wait for the exact operator package to appear in `PackageManifest`.
2. Confirm that the expected channel advertises the intended CSV version.
3. Create an isolated `OperatorGroup` and a Subscription pinned to that channel
   and starting CSV.
4. Wait for the expected InstallPlan and CSV instead of accepting another
   version that happens to resolve first.
5. Require the CSV to reach `Succeeded` before creating an operand custom
   resource.

Capture the exact PackageManifest, Subscription, InstallPlan, and CSV names as
evidence. If catalog reconciliation produces a different CSV, remove only the
failed Subscription and its unapproved InstallPlan, correct the catalog input,
and retry. Never delete shared catalog resources during release validation.

### Validate storage and offline operand images first

An operator package may reference optional ACP storage operators that are not
installed in a small validation environment. If the workload cluster already
has a default dynamic StorageClass, do not install an unrelated storage stack
just to reproduce another environment's topology. Prove the actual requirement
with a disposable PVC and Pod:

- the PVC becomes `Bound` through the default StorageClass;
- a Pod mounts it and can write and read a probe file;
- the PVC and probe Pod are deleted after the check.

This storage gate must pass before creating stateful Harbor, Nexus, SonarQube,
or database operands. A default StorageClass annotation alone is not sufficient
evidence that provisioning works.

Also enumerate every operand image from the resolved CSV, charts, and custom
resource defaults before installation. Verify image availability from the
target workload cluster, including database, cache, init, and migration images
that are not obvious from the primary operator image. Harbor and SonarQube in
particular can become partially ready when one offline middleware image is
missing. Use disposable pull probes or inspect Pod image IDs; a successful
registry API lookup from the workstation does not prove that kubelet can pull
the same reference.

Wait for each operator-controlled resource, its database, and all workload
Pods to become ready. Then run tool-specific API gates from both locations used
by the suite:

- a normal workload Pod, which proves in-cluster DNS, TLS, and service routing;
- the workstation test runner, which proves the local forwarding path.

Do not start the full suite until both paths pass repeatedly.

### Separate API routing from Harbor image-pull routing

Cluster-local Service DNS is appropriate for GitLab, Nexus, SonarQube, and
Harbor API calls made by test Pods. It is not valid for a Harbor image reference
consumed by kubelet: the node container runtime resolves and connects to that
reference outside the Pod DNS namespace.

Use a Harbor authority that every workload node can resolve and reach, such as
an approved registry address or a node-reachable endpoint derived from the
target environment. Validate it by creating a Pod whose image is pulled from
that exact authority. Do not substitute a workstation-only hosts entry as
evidence.

If the same authority must also be reachable by the local test runner in an
IPv6-only environment, add only its exact `/128` to workstation loopback and
bind a Harbor Service port-forward to the same port. This local route can also
intercept the plugin API NodePort selected by the test harness. Run a separate
watcher for `artifacthub-shim-api-nodeport` that reads its current allocation,
restarts the forward after Service or Pod replacement, and requires `/readyz`
before releasing API scenarios. The Harbor forward and the dynamic plugin API
forward solve different traffic paths and must remain independently
reconcilable.

### Use temporary administrative identities

Create test users, robot accounts, projects, repositories, groups, and tokens
with run-unique names whenever the tool API supports it. SonarQube setup may
need a manager token to create users and permission templates. Generate that
token immediately before fixture preparation, keep it only in protected
scratch configuration, and revoke it after the suite cleanup. The same rule
applies to Harbor robot credentials and any target-local Violet identity.

After the suite completes, remove run-scoped tool data first, then operands,
Subscriptions, CSVs, and namespaces created only for this validation. Preserve
shared tool instances and catalogs. Retain the installed `artifacthub-shim` and
the uploaded report unless the environment owner explicitly requests their
removal.

## Adapt an IPv6-only workload cluster

Some split-control-plane environments assign only IPv6 addresses to ordinary
Pods while external GitLab, Nexus, Harbor, and SonarQube services are reachable
only through an IPv4 or NAT64-capable node. Test connectivity from a normal
workload Pod before adding an adapter; workstation connectivity does not prove
that Pipeline Task Pods can reach the same endpoints.

Keep all adaptations in a scratch source tree and retain their diffs as test
evidence. Do not rebuild the frozen package or E2E image.

Tell the configuration generator which protocol stack the workload Pods use:

```bash
export ARTIFACTHUB_SHIM_ACP_PROTOCOL_STACK=IPv6
```

Verify that `acp.protocolStack` is `IPv6` in the generated test configuration
before the suite starts. Several Java and Maven fixtures derive their JVM
network option from this value. The default is `IPv4`; leaving it unchanged
renders `-Djava.net.preferIPv4Stack=true`, which makes the JVM ignore an
IPv6-only Nexus relay and can surface as a misleading name-resolution failure.

### Bridge the NodePort address selected by the local harness

The API scenarios construct their request URL from
`node.ip.first.readable` and the temporary `artifacthub-shim-api-nodeport`
Service. In an IPv6-only workload cluster, that node address can be valid
inside the environment but unroutable from the workstation running the test
binary. The resulting `network is unreachable` error is a harness routing
failure, not an API failure.

After the suite creates the NodePort Service, take the exact IPv6 address from
the failed request and confirm that its port matches the Service. Add only that
address as a temporary `/128` on loopback, then bind a port-forward to the same
address and port:

```bash
# NODE_IPV6 is the exact bracketed host, without brackets, selected by the test.
export NODE_IPV6='<node-ipv6>'
# NODE_PORT is the named HTTP NodePort created by the API scenario background.
export NODE_PORT="$(kubectl --kubeconfig "$WORKLOAD_KUBECONFIG" \
  -n artifacthub-shim-system get service artifacthub-shim-api-nodeport \
  -o jsonpath='{.spec.ports[?(@.name=="http")].nodePort}')"

ip -6 address add "${NODE_IPV6}/128" dev lo
kubectl --kubeconfig "$WORKLOAD_KUBECONFIG" \
  -n artifacthub-shim-system port-forward \
  service/artifacthub-shim-api-nodeport "${NODE_PORT}:80" \
  --address="$NODE_IPV6"
```

Verify `/readyz` through that exact endpoint before allowing the suite to
continue. Keep the forward running for all NodePort-based scenarios. If a run
finishes and its cleanup deletes the Service, read the newly allocated NodePort
and restart the forward before retrying; do not assume the old port is reused.

For repeated runs, start a loopback-only supervisor before the suite. It should
watch for the Service, reconcile the forward whenever its allocated NodePort
changes, and stop the old process when the Service disappears. A forward can
also remain pinned to a replaced API Pod, so restart it after a fixture
Deployment rollout even when the NodePort is unchanged. Require `/readyz` to
pass through the reconciled endpoint before accepting any API scenario result.

After the harness cleanup has finished, stop the port-forward and remove only
the address added above:

```bash
ip -6 address delete "${NODE_IPV6}/128" dev lo
```

Do not add a broader IPv6 prefix, alter the workstation's default route, or
expose the forward on an externally reachable interface.

### Reuse a pre-provisioned GitLab

When GitLab cannot be deployed by the release harness, use a pre-provisioned
test instance. Read its API token and Git credentials at runtime from the
environment's Secret or protected test configuration. Never copy them into the
source tree or command logs.

Prefer running `prepare-gitlab-data` against that instance. It creates a
run-unique user, group, and project and writes the cleanup state consumed on
exit; it does not deploy another GitLab. The unique group also makes the
SonarQube automatic-project key unique, which is required when other release
tests share the same SonarQube server.

Skip GitLab data creation only when the pre-provisioned group is exclusively
reserved for this run and no concurrent validation can derive the same
SonarQube project key:

```bash
# This flag selects the reviewed scratch-only helper overlay for an exclusive group.
export ARTIFACTHUB_SHIM_USE_EXISTING_GITLAB=true
```

The GitLab CLI's new-user flow can require a PAT with `sudo` scope. Do not
broaden a token only for this validation. If the token owner can create groups
and projects but cannot impersonate another user, create a run-unique group as
that owner and pre-create these fixed fixture projects:

- `testing-pipeline-buildah-v2`
- `testing-pipeline-git-clone`
- `python-e2e-demo-v2`
- `testing-pipeline-sonarqube`
- `testing-pipeline-maven`
- `java-e2e-demo-v2`
- `testing-pipeline-git-version`

Write only the new group path into a mode-`0600` copy of the external-toolchain
configuration. Validate the configured Git credentials with `git ls-remote`
against one empty project before starting E2E. Record the group ID and delete
that exact group after the harness cleanup has completed.

If an exclusive group must be reused for another attempt, inventory projects
through that group's API scope and reset only those projects before seeding.
At minimum, remove protected-branch and protected-tag rules from their default
branches and tags; several seed fixtures deliberately use force-push to make a
rerun deterministic. Recreating the exact isolated group is safer when its
contents are not known. Never broaden this cleanup to similarly named groups.

Do not delete a fixed project merely because its key collides: it may belong to
another active run. Create isolated GitLab data instead, and verify cleanup
deletes only the generated user, group, projects, and matching SonarQube
objects. If the local harness needs the in-cluster GitLab Service, expose it
with a loopback-only `kubectl port-forward` and a temporary hosts-file entry.

### Add IPv6 listeners to the Git mock

The frozen Git mock image can remain unchanged when its generated Nginx
configuration listens only on IPv4. Apply a reviewed scratch-only init overlay
that adds `[::]` listeners for the HTTP, HTTPS, and alternate ports while
retaining the original IPv4 listeners. Confirm both the readiness probe and a
Service request succeed over IPv6 before starting the suite.

### Bridge IPv6 Pods to IPv4 toolchains

Use a temporary TCP pass-through proxy only after confirming that the selected
node has the required IPv4 or NAT64 egress. The proxy should:

- run with `hostNetwork` on that verified node;
- forward raw TCP without terminating TLS, so the original certificate and
  hostname checks remain effective;
- expose one ClusterIP Service for each external toolchain; and
- use explicit resource limits, readiness probes, and a temporary ConfigMap.

Cluster DNS can temporarily map each external toolchain hostname to its proxy
Service. Record the exact original CoreDNS hosts data before modifying it. The
proxy itself must use a separate temporary upstream resolver that bypasses
those overrides; otherwise resolving the original hostname loops back into the
proxy Service. Pin that resolver to a node with working upstream DNS, then set
the proxy Deployment's `dnsConfig.nameservers` to the resolver Pod address.

If the resolver Pod is recreated, update the proxy nameserver and roll out the
proxy again. Require ten consecutive rounds in which every toolchain endpoint
passes from a normal Pod before treating the bridge as ready.

### Backhaul through the workstation when nodes have no egress

Do not use the node proxy design when none of the workload nodes can reach the
external toolchains. A trusted workstation that already reaches those services
through an enterprise HTTP proxy can provide a temporary reverse backhaul:

1. Run a normal-network relay Deployment in the workload cluster. It exposes
   one raw TCP listener per toolchain and a separate backhaul listener.
2. Publish the toolchain listeners through ClusterIP Services used by the
   temporary DNS overrides. Do not create a NodePort, LoadBalancer, or Ingress
   for the backhaul.
3. Reach the backhaul Service only with a loopback-bound `kubectl port-forward`
   from the workstation.
4. Run a local agent that maintains a bounded connection pool to that loopback
   port. On activation, the agent opens an HTTP `CONNECT` stream through the
   workstation's enterprise proxy to the selected external toolchain.
5. Bridge bytes without terminating TLS. The Task Pod must still use the
   original hostname, SNI value, certificate policy, and application
   credentials.

Use a random token of at least 32 bytes to authenticate agent registrations.
Store it in a temporary Kubernetes Secret, pass it to the relay and agent only
through environment variables, and never place it in arguments or logs. Keep
each backhaul port-forward on loopback, and keep both the queue and worker count
bounded.

Health checks use few short connections and do not size the pool for image
builds. Two concurrent Buildah or Skopeo operations can open enough parallel
Registry streams to exhaust a small pool and surface as TLS handshake timeouts
or an HTTP fallback error. For release-test concurrency 2, a proven bounded
layout is a relay queue of 32 connections shared by all mappings, sharded into
four independent loopback port-forwards and four agents with pool size 8. The
separate forwards avoid concentrating every registration stream in one
long-lived `kubectl port-forward`. Roll out the relay, recreate all four
forwards and agents against the new Pod, then require two simultaneous copies
of the exact frozen fixture image to succeed before E2E. Keep the configured
upper bound; do not replace the pool with unbounded worker creation.

If bounded capacity is healthy but concurrent Maven, Registry, and SonarQube
transfers still produce connection refusals, TLS EOFs, or HTTP/2 stream resets,
do not replay bytes inside the raw relay. Run the complete selector with local
harness concurrency 1 and record that environment-specific deviation with the
report. This preserves every scenario while avoiding simultaneous long
transfers through an egress path that cannot sustain release-Pipeline
concurrency.

The workstation agent should also retry a failed upstream HTTP `CONNECT` a
small, bounded number of times before acknowledging activation to the relay.
Use a per-attempt timeout that keeps all attempts inside the relay's activation
deadline. This retry is safe only before the agent acknowledges the stream,
because no application bytes have been accepted yet. Never retry or replay a
partially transferred Registry layer, Nexus PUT, or SonarQube request inside a
raw TCP relay.

The relay can be compiled in an init container from a small reviewed source
ConfigMap by using the exact frozen E2E image, which already contains the Go
toolchain. Keep that source and its binary in scratch storage as test evidence;
do not add the environment-specific relay, token, or addresses to the release
candidate.

### Use an approved integration cluster as the egress hop

An enterprise proxy may pass health checks but still terminate long Registry,
Maven, or SonarQube transfers. When that behavior persists, an explicitly
approved integration cluster can replace the enterprise proxy as the upstream
hop. Use this only when a selected integration node has verified direct access
to every required toolchain and the environment owner permits the temporary
workload.

Create the adapter in a dedicated namespace. Pin one TCP pass-through
Deployment to the verified node and use `hostNetwork` only for the required
egress. The container must run as a non-root user, drop all capabilities,
disable privilege escalation, use a read-only root filesystem and the runtime
default seccomp profile, and expose only the required TCP listeners. Forward
encrypted streams without terminating TLS or changing SNI, certificates, or
application credentials.

Use the `Recreate` Deployment strategy for a single-replica host-network
adapter with fixed listen ports. The default rolling strategy creates the new
Pod before stopping the old one, so both Pods contend for the same node ports
and can generate a large number of failed replacements. Keep one ready replica
and verify the selected node after every recreation.

The adapter may retry an upstream TCP dial only while no upstream connection
has been established and no application byte has been forwarded. Use a small,
bounded attempt count, short dial timeouts, and a total delay that remains
inside the client's TLS-handshake deadline. Once a stream has reached an
upstream connection, never reconnect or replay it inside the adapter; let the
application report or safely retry the operation instead.

Publish the adapter only as a ClusterIP Service. Reach it from the trusted
workstation with loopback-bound `kubectl port-forward` processes, then connect
the authenticated workload-cluster relay agents to those loopback ports. Do
not create a NodePort, LoadBalancer, Ingress, or externally bound listener in
the integration cluster. Keep all integration-cluster manifests, binaries,
tokens, kubeconfigs, and endpoint mappings in scratch storage rather than the
release repository.

If the trusted workstation already has an explicitly approved route to the
selected node's host-network listeners, the relay agents may use that route
directly instead of carrying long TLS streams through `kubectl port-forward`.
Do not add a route, firewall exception, or public listener for this purpose.
Verify that only the three required adapter ports are reachable, retain the
original application hostname and TLS SNI, and repeat every short- and
long-transfer gate through the direct path. This option removes the API-server
port-forward stream from the data path; it does not relax the adapter's
non-root, capability, seccomp, or cleanup requirements.

Treat this path as ready only after all of the following gates pass without a
relay, DNS, agent, or port-forward restart:

- ten consecutive health-check rounds for Nexus, Harbor, and SonarQube from an
  ordinary workload Pod;
- the same ten consecutive rounds from the workstation path used by fixture
  preparation;
- at least three consecutive complete copies of the frozen Harbor fixture
  image; and
- one representative large SonarQube download and one Maven dependency
  download.

A simultaneous failure at the integration node and both downstream paths is
an upstream availability window, not proof that the adapter is defective.
Wait for recovery and restart every gate from round one. After the release
harness has removed its external fixtures, stop the loopback forwards and
relay agents, delete the dedicated integration-cluster namespace, and verify
that no adapter resource remains.

Avoid routing workstation-originated bulk transfers back through the cluster.
If the workstation can reach an external Nexus, Harbor, or SonarQube endpoint
through its enterprise proxy, leave that hostname out of `NO_PROXY` for the
local harness. The proxy then ignores the temporary hosts-file address and
connects to the real endpoint, while Task Pods still follow cluster DNS through
the relay. Keep only services that truly require a local forward, such as an
in-cluster GitLab fixture, in `NO_PROXY`. This split prevents large fixture
image layers from being carried through a long-lived `kubectl port-forward`
stream. Verify the three external health endpoints with the resulting proxy
environment before fixture preparation.

An enterprise proxy can still reset one long Registry upload even when ordinary
API calls are healthy. If repeated `skopeo copy` attempts fail on the same large
layer with EOF, connection-reset, or 502 responses, pull the exact platform from
the frozen image into a local OCI layout. Upload each unchanged
content-addressed blob through the Registry v2 chunked-upload API with a bounded
chunk size, then PUT the original OCI manifest under the required fixture tag.
Verify every blob digest and use the manifest's media type in the final HEAD
request. Do not rebuild, unpack, recompress, or otherwise alter a frozen layer;
that would invalidate the release input. Keep the OCI index, upload log, and
final manifest verification with the run evidence, then remove the local OCI
layout during cleanup.

Run `kubectl port-forward` and the local agent under restart supervisors. A
port-forward created against a Service can remain pinned to a Pod that was
later replaced. After every relay rollout, restart both the backhaul forward
and the toolchain forwards. Remove failed temporary relay Pods before
restarting, or resolve the single current Running Pod explicitly, so
`kubectl port-forward service/...` cannot select historical Pods.

Treat a restarted backhaul forward as a relay-state event, not merely a local
listener event. The relay queue can still contain authenticated TCP
connections that belonged to the exited forward. A supervisor may restore the
local port immediately while new clients continue receiving EOF from those
stale queue entries. Before accepting traffic again, either recreate the
temporary relay or make its activation loop discard failed backhauls and try
the next registered connection inside one bounded activation deadline. This
retry is safe only before the relay has forwarded client bytes. Confirm that
the expected bounded agent pool has registered again, then repeat the full
toolchain gate.

Require ten consecutive rounds in which Nexus, Harbor, and SonarQube all pass.
Run the gate from an ordinary workload Pod and from the workstation path used
by local fixture preparation. A workstation-only check proves the enterprise
proxy path but does not prove that cluster DNS, Services, and the relay path are
correct. Restart the gate from round one after any relay, agent, forward, or DNS
change.

For a local harness, distinct addresses from the `127.0.0.0/8` loopback range
allow multiple HTTPS Services to retain port 443 simultaneously:

```bash
# LOOPBACK_ADDRESS is unique for each toolchain and never listens externally.
export LOOPBACK_ADDRESS='<127.x.y.z>'
# PROXY_SERVICE is the corresponding workload-cluster proxy Service.
export PROXY_SERVICE='<toolchain-proxy-service>'

kubectl --kubeconfig "$WORKLOAD_KUBECONFIG" \
  -n artifacthub-shim-system port-forward \
  "service/${PROXY_SERVICE}" 443:443 \
  --address="$LOOPBACK_ADDRESS"
```

Map the original hostname to that loopback address in a clearly marked,
temporary hosts-file block. Keeping the original hostname preserves TLS and
the test configuration. Never bind these forwards to a non-loopback address.

If the workstation exports `HTTP_PROXY` or `HTTPS_PROXY`, the client may ignore
the hosts-file mapping and send toolchain requests to that proxy. Add every
mapped toolchain hostname and loopback address to both proxy-bypass variables
for the test process:

```bash
# TOOLCHAIN_NO_PROXY lists only the hostnames mapped to local port-forwards.
export TOOLCHAIN_NO_PROXY='<gitlab-host>,<nexus-host>,<harbor-host>,<sonarqube-host>,127.0.0.1,127.0.0.2,127.0.0.3,127.0.0.4,localhost'
export NO_PROXY="${NO_PROXY:+${NO_PROXY},}${TOOLCHAIN_NO_PROXY}"
export no_proxy="$NO_PROXY"
```

Run ten consecutive health-check rounds with these variables before starting
fixtures.
If the proxy Pod has been replaced, restart the matching `kubectl port-forward`;
a live port-forward process can still be pinned to an obsolete Pod.

### Align Tekton coscheduling for multi-PVC tasks

The OCI cache round-trip binds separate source and cache PVCs to one TaskRun.
Tekton rejects that shape with `more than one PersistentVolumeClaim is bound`
when `feature-flags.coschedule` is `workspaces`. This is an environment runtime
setting, not a cache Task or Artifact Hub failure.

During an exclusive validation window, record the original value, temporarily
select PipelineRun-level coscheduling, and restart only the Pipelines
controller:

```bash
export ORIGINAL_COSCHEDULE="$(kubectl --kubeconfig "$WORKLOAD_KUBECONFIG" \
  -n tekton-pipelines get configmap feature-flags \
  -o jsonpath='{.data.coschedule}')"

kubectl --kubeconfig "$WORKLOAD_KUBECONFIG" -n tekton-pipelines \
  patch configmap feature-flags --type merge \
  -p '{"data":{"coschedule":"pipelineruns"}}'
kubectl --kubeconfig "$WORKLOAD_KUBECONFIG" -n tekton-pipelines \
  rollout restart deployment/tekton-pipelines-controller
kubectl --kubeconfig "$WORKLOAD_KUBECONFIG" -n tekton-pipelines \
  rollout status deployment/tekton-pipelines-controller --timeout=5m
```

After the suite and its TaskRuns finish, restore the exact recorded value and
roll out the controller again. Do not leave a cluster-wide feature-flag change
behind or alter coscheduling while unrelated PipelineRuns are active.

## Run the installed-plugin suite locally

Build the test binary from the exact source revision and record its checksum.
Place it at `/tools/bin/artifacthub-shim.e2e.test`, which is the path consumed by
`testing/hack/run-release-test.sh`. Ensure `allure`, `kubectl`, `jq`, `yq`,
`skopeo`, and the test's normal tool dependencies are installed locally.

Pin the Allure generator to the reviewed Allure 2 version used by the release
tooling. The harness invokes `allure generate --clean`, and the report upload
contract requires `widgets/summary.json`, `data/behaviors.json`, and
`data/test-cases/*.json`. Allure 3 does not accept the same `--clean` option and
generates a different directory layout. A suite can therefore pass completely
while the outer runner fails only during report generation. Check the major
version before the run and use an internally mirrored Allure 2 distribution;
do not publish an Allure 3 report as release-Pipeline evidence.

Start every attempt from a clean source export. Fixture preparation with
`processPlaceholders: true` can render image references and temporary
credentials into files supplied through a `localPath`. Those files are valid
only for the run that created the external Harbor robot or other fixture
identity. Reusing the rendered source after cleanup can make image builds
succeed with new workspace credentials while deployed workloads keep an old
`imagePullSecret` and fail with `ImagePullBackOff`.

Before creating a new result or state directory, restore every rendered
fixture from the frozen source revision and verify the fixture tree against
that revision. In particular, Secret manifests must contain configuration
placeholders rather than rendered base64 authentication values. Revoke any
run-scoped credential that was written to a retained scratch file, remove the
sensitive failed results and logs, and never upload them. Keeping Allure and
state directories separate is necessary but is not sufficient when the source
tree itself was rendered in place.

Run the same selector and concurrency used for release validation:

The normal release default may run multiple scenarios concurrently. Use
concurrency `1` when an adopted toolchain cannot isolate asynchronous project,
repository, or permission-template deletion between scenarios. Record the
override and its reason in the evidence; serial execution changes duration but
does not narrow the required `~@install` selector. Return to the reviewed
release concurrency after the toolchain can prove run-level isolation.

```bash
# RESULT_ROOT keeps report artifacts outside the Git worktree.
export RESULT_ROOT=/secure/scratch/artifacthub-shim-release-result
# SOURCE_DIR is a clean export of the exact revision under test.
export SOURCE_DIR=/secure/scratch/artifacthub-shim-source

KUBECONFIG="$WORKLOAD_KUBECONFIG" \
BASE_TEST_CONFIG="$BASE_TEST_CONFIG" \
SOURCE_DIR="$SOURCE_DIR" \
REGISTRY_TEST="$REGISTRY_TEST" \
TAGS='~@install' \
ARTIFACTHUB_SHIM_RELEASE_TEST_CONCURRENCY=1 \
ARTIFACTHUB_SHIM_ACP_PROTOCOL_STACK=IPv6 \
ARTIFACTHUB_SHIM_SOURCE_REGISTRY_SKIP_TLS_VERIFY=true \
ARTIFACTHUB_SHIM_BUSYBOX_SOURCE_IMAGE="${REGISTRY_TEST}/base-images/busybox:<frozen-tag>" \
ARTIFACTHUB_SHIM_UBUNTU_SOURCE_IMAGE="${REGISTRY_TEST}/base-images/ubuntu:<frozen-tag>" \
ARTIFACTHUB_SHIM_E2E_SOURCE_IMAGE="${REGISTRY_TEST}/alauda-pipelines-catalog/artifacthub-shim-e2e:${E2E_TAG}" \
ARTIFACTHUB_SHIM_GIT_MOCK_IMAGE="${REGISTRY_TEST}/alauda-pipelines-catalog/artifacthub-shim-e2e:${E2E_TAG}" \
RELEASE_TEST_RESULT_ROOT="$RESULT_ROOT" \
RELEASE_TEST_REPORT_DIR="$RESULT_ROOT/allure-report" \
bash "$SOURCE_DIR/testing/hack/run-release-test.sh"
```

The runner enforces a six-hour Go test timeout and cleans its generated
configuration and fixtures on exit. If the process is interrupted, confirm the
cleanup completed before retrying. Do not reuse an old `allure-results`
directory.

Keep the toolchain bridge and local forwards running until the harness cleanup
has removed the run-scoped Nexus, Harbor, SonarQube, and GitLab data. Removing
connectivity first strands external fixtures and makes the cleanup result
ambiguous.

### Sanitize Allure attachments before upload

The suite can attach rendered manifests, command output, or external-tool
responses to Allure. Those attachments may contain a run-scoped password,
token, registry authorization value, or database credential even when the
release progress log itself is sanitized. Treat the raw `allure-results` and
generated report as protected data until they pass a credential scan.

Build the scan set in memory from the protected base configuration, generated
runtime configuration, portable kubeconfig, and run-scoped cleanup state.
Include exact non-empty secret values and the encoded forms that can occur in a
Kubernetes Secret, Registry authorization field, or URL. Never print the scan
values or place them in command arguments, a ConfigMap, or a retained file.

If the raw result contains a known credential:

1. Preserve the raw directory only in mode-`0700` scratch storage while the
   sanitized copy is built.
2. Copy the complete results into a separate upload root.
3. Replace exact known values only in text attachments with a stable
   `[REDACTED]` marker. Do not use a broad pattern that can alter assertions,
   status fields, UUIDs, or case names.
4. Generate a new Allure report from the sanitized results.
5. Require zero matches for every raw and encoded credential in both the
   sanitized results and report.
6. Confirm the regenerated summary, behavior tree, case count, statuses, and
   `~@install` selector still match the raw run.

Upload only the sanitized result and report directories. After remote integrity
verification succeeds, delete the credential-bearing raw Allure data, generated
configuration, and local run state. Redaction protects report transport; it
does not turn a failed or incomplete suite into valid evidence.

## Upload the report through the existing Connector

Keep object-storage credentials out of the workstation. Use a temporary PVC in
a trusted build cluster and the catalog `s3-cli` Task `0.1` with the same
object-storage Connector and report base URL as the normal release Pipeline.

1. Create a dedicated PVC with enough space for `allure-results` and
   `allure-report`.
2. Mount it in a disposable staging Pod and copy both directories from
   `RESULT_ROOT`.
3. Delete the staging Pod so the PVC can be mounted by the TaskRun.
4. Run the Hub-resolved `s3-cli` Task with:
   - catalog `extras`, kind `task`, name `s3-cli`, version `0.1`;
   - the PVC as the `source` workspace;
   - the existing object-storage Connector with
     `configuration.names: aws-env` as the `credentials` workspace;
   - a script that mirrors both directories to
     `e2e-report/artifacthub-shim/<Asia-Shanghai timestamp>/`;
   - the existing report base URL written to `$S3_CLI_LINK_FILE`.
5. Read `results.report-url` from the completed TaskRun.

Use a unique timestamp for every manual run. Never overwrite a previous report
prefix. After upload, delete the TaskRun, staging Pod, and PVC; retain the S3
objects.

Distinguish the report origin from the complete browser-visible target. The S3
script above already creates this object prefix:

```text
e2e-report/artifacthub-shim/<Asia-Shanghai timestamp>/
```

If the supplied report value is only an origin, append that complete prefix to
it. If the supplied value already ends in `/e2e-report/artifacthub-shim`, append
only the timestamp and `allure-report/index.html`. Do not append the prefix to a
value that already contains it. Require the final URL path to contain exactly
one `e2e-report/artifacthub-shim` segment before publishing the Task result.

For example, when the protected runtime supplies the complete target:

```bash
# REPORT_TARGET already ends in /e2e-report/artifacthub-shim.
export REPORT_TARGET='<report-origin>/e2e-report/artifacthub-shim'
# REPORT_TIME is the same Asia/Shanghai timestamp used in the S3 object prefix.
export REPORT_TIME='<YYYYmmddHHMMSS>'

printf '%s\n' \
  "${REPORT_TARGET%/}/${REPORT_TIME}/allure-report/index.html" \
  > "$S3_CLI_LINK_FILE"
```

## Verify report integrity

An HTTP 200 for `index.html` is necessary but insufficient. Validate all four
report surfaces from the uploaded prefix:

- `allure-report/index.html`
- `allure-report/widgets/summary.json`
- `allure-report/data/behaviors.json`
- at least one case detail referenced by
  `allure-report/data/test-cases/*.json`

Confirm the authoritative test totals in `widgets/summary.json` match the local
Allure results and that the report contains the selected `~@install` suite. A
minimal static page or a report copied from an earlier run is not valid release
evidence.

## Clean up environment adapters

After the harness has completed its own external-data cleanup, remove the
environment adapters in this order:

1. Stop all loopback-only port forwards.
2. Stop the local backhaul agent and remove its in-memory token.
3. Remove only the marked temporary entries from the workstation hosts file.
4. Restore the exact original CoreDNS hosts data and wait for the DNS rollout.
5. Delete the temporary proxy or relay Deployment, Services, ConfigMaps, and
   backhaul Secret.
6. Delete failed adapter Pods, staging Pods, upload TaskRuns, and upload PVCs.
7. Remove generated kubeconfigs, credentials, test configuration, Maven seed,
   and scratch patches from the workstation.

An interruption can occur after an external resource is created but before its
cleanup state file is written. Before retrying, search Nexus, Harbor, and
SonarQube for the exact run identifiers from the interrupted log. Delete only
those run-scoped objects, then verify the search returns zero matches. Do not
remove similarly named shared toolchain resources.

For SonarQube, check both projects and permission templates. A stale
auto-derived project or a second matching permission template can make the next
preparation fail even though ordinary health checks pass. Delete only the
projects, templates, users, and groups whose exact keys belong to the failed
run, then repeat the zero-match check.

Verify no marked hosts-file entry or adapter resource remains. Retain the
installed plugin and uploaded S3 report as release evidence unless the
environment owner explicitly requests their removal.

## Troubleshooting

| Symptom                                                                  | Likely cause                                                                                                           | Action                                                                                                                                                      |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API discovery hangs before installation                                  | One kubeconfig cannot route to both control planes                                                                     | Use separate global and workload kubeconfigs                                                                                                                |
| No generated `ModuleInfo`                                                | Cluster transformer did not accept the workload request                                                                | Check `ClusterPluginInstance` status and transformer events                                                                                                 |
| Generated version is unexpected                                          | Candidate was not the advertised version at creation time                                                              | Remove only the failed test installation, correct catalog state, and retry                                                                                  |
| Test image pull returns `NotFound`                                       | Violet third-party repository prefix is missing                                                                        | Add `/3rdparty` to `REGISTRY_TEST` and verify tags                                                                                                          |
| Git mock is running but never ready on an IPv6-only cluster              | The frozen helper image's Nginx configuration listens only on IPv4                                                     | Add reviewed `[::]` listeners through a scratch-only fixture overlay, retain its diff as evidence, and do not change the frozen package or test binary      |
| Java or Maven reports that an IPv6-only Nexus host is unknown            | The generated ACP protocol stack retained its `IPv4` default, so the fixture set `java.net.preferIPv4Stack=true`       | Set `ARTIFACTHUB_SHIM_ACP_PROTOCOL_STACK=IPv6`, regenerate the test configuration, and verify the rendered TaskRun uses `java.net.preferIPv6Addresses=true` |
| Local API checks report `network is unreachable` for a node IPv6 address | The local harness constructs NodePort URLs from a node address that is routable only inside the target environment     | Add that exact address as a temporary loopback `/128`, bind a port-forward to the current NodePort, and remove both after harness cleanup                   |
| Local API `/readyz` changes to `connection refused` after a rollout       | The old forward still targets a deleted Pod or a NodePort allocated to an earlier run                                  | Reconcile the forward from the current Service and Pod before accepting API results; do not retain forwards for obsolete NodePorts                         |
| Proxy starts but cannot resolve an external toolchain                    | Its resolver follows the temporary cluster DNS override                                                                | Point the proxy to the separate upstream resolver Pod and roll out the proxy again                                                                          |
| Proxy fails after the resolver Pod is recreated                          | The proxy retains the previous resolver Pod address                                                                    | Refresh `dnsConfig.nameservers`, roll out the proxy, and repeat endpoint health checks                                                                      |
| No workload node can reach the external toolchains                       | The environment has no usable node-level IPv4 or NAT64 egress                                                          | Use the authenticated reverse backhaul through a trusted workstation and its enterprise HTTP proxy                                                          |
| Backhaul clients receive an immediate TLS EOF                            | A port-forward remains pinned to a replaced or failed relay Pod                                                        | Remove failed temporary relay Pods, restart the backhaul and toolchain forwards against the current Running Pod, and reconnect the agent                    |
| A large fixture image repeatedly fails with EOF or 502                   | The enterprise proxy resets one long Registry layer upload                                                             | Preserve the frozen OCI bytes, upload missing blobs with bounded Registry v2 chunks, PUT the unchanged manifest, and verify its original media type         |
| Concurrent image builds fail during the Registry TLS handshake           | The backhaul pool is sized for health checks rather than parallel layer transfers                                      | Increase the bounded relay queue and agent pool together, restart both sides, and validate two concurrent frozen-image copies before retrying               |
| A Nexus PUT receives HTTP 000 and a connection reset before transfer     | The workstation proxy rejected or timed out one upstream `CONNECT`, and the raw relay closed the unacknowledged stream | Retry only the pre-acknowledgement `CONNECT` with bounded attempts inside the activation deadline; never replay application data                            |
| A cache TaskRun says more than one PVC is bound                          | Tekton uses workspace-level coscheduling, which rejects a TaskRun that binds both source and cache PVCs                | In an exclusive window, record the original flag, use `coschedule=pipelineruns` for the suite, then restore the exact value                                 |
| Local checks time out or GitLab returns 502                              | The workstation proxy bypasses the loopback hosts-file mapping                                                         | Add every mapped hostname to `NO_PROXY` and `no_proxy`, restart stale port-forwards, and repeat ten consecutive health-check rounds                         |
| GitLab fixture creation returns `insufficient_scope: sudo`               | The new-user flow impersonates a generated user                                                                        | Keep the existing token scope; create a run-unique group and fixed projects as the token owner, then use the isolated group path                            |
| Git Version seed force-push is rejected as a protected branch            | A reused isolated project retained default-branch or tag protection from an earlier attempt                            | Reset protection only inside the exact test group, or recreate that isolated group, before rerunning the seed                                               |
| Fixture preparation fails before suite start                             | Imported helper image or external toolchain is unavailable                                                             | Fix the fixture input; do not classify it as a product test failure                                                                                         |
| Maven seed is reported missing                                           | The scratch source export omitted an image-baked fixture                                                               | Copy it from the exact frozen E2E image, verify `SHA256SUMS`, and keep it outside Git                                                                       |
| SonarQube says a project key matches multiple templates                  | An interrupted run left a template before its state file was saved                                                     | Delete the exact run-scoped templates, projects, users, and groups; verify zero matches before retrying                                                     |
| Suite fails but report generation succeeds                               | One or more BDD scenarios failed                                                                                       | Use Allure case details and captured step output for diagnosis                                                                                              |
| Report index works but data pages are empty                              | Upload was partial, stale, or not an Allure report                                                                     | Verify summary, behaviors, and case-detail objects before publishing the URL                                                                                |

## Evidence checklist

Record the following without credentials or internal infrastructure details:

- source revision and E2E binary checksum;
- plugin version and frozen package references;
- imported auxiliary image tag;
- `ModuleInfo` version, phase, and AppRelease readiness;
- test selector (`~@install`), concurrency, start/end time, and exit status;
- local Allure result counts;
- uploaded report URL and the four integrity checks;
- manifest and image security evidence, including unresolved blockers;
- cleanup status for temporary local and Kubernetes resources.
