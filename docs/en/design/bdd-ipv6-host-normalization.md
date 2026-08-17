---
title: BDD IPv6 Host Normalization for External Toolchains
status: proposed
creation-date: "2026-07-13"
last-updated: "2026-07-15"
authors:
  - Alauda DevOps
---

# BDD IPv6 Host Normalization for External Toolchains

## Summary

The artifacthub-shim catalog E2E suite builds Git URLs, registry references,
Docker authentication keys, and tool endpoints from host and port fields in
`config.yaml`. Existing cases assume that a host is a DNS name or an IPv4
literal and commonly render it as `host:port`. An unbracketed IPv6 literal is
ambiguous in that form and causes URL and image-reference parsing failures.

This design fixes the issue at the BDD configuration boundary. A test suite
explicitly declares the configuration paths that contain host values. After
BDD loads the YAML configuration, it detects IPv6 literals at those paths and
adds the brackets required when the value is embedded in an authority. IPv4
literals, DNS names, empty strings, and already bracketed IPv6 literals remain
unchanged.

The artifacthub-shim suite will declare five toolchain host fields and keep its
existing feature templates. Consumers that need the semantic host value rather
than an authority-form value must explicitly remove the outer brackets.

## Motivation

The suite currently contains many expressions equivalent to the following:

```gotemplate
{{ printf "%s:%d" .toolchains.harbor.host .toolchains.harbor.port }}
```

The expression produces valid authorities for DNS names and IPv4 literals, but
not for IPv6 literals:

| Input host | Current output | Required output |
| --- | --- | --- |
| `gitlab.example.com` | `gitlab.example.com:443` | `gitlab.example.com:443` |
| `192.0.2.10` | `192.0.2.10:443` | `192.0.2.10:443` |
| `2001:db8::10` | `2001:db8::10:443` | `[2001:db8::10]:443` |

Changing every feature and fixture to call a new template helper would create a
large mechanical diff and leave future cases exposed to the same mistake.
Inferring every YAML field named `host` would be unsafe because BDD configuration
is open-ended and some host-like values are identifiers rather than URL
authorities. An explicit suite-level field list provides a small integration
change and a predictable compatibility boundary.

## Goals

- Let each BDD suite explicitly declare configuration fields eligible for IPv6
  host normalization.
- Add brackets only to IPv6 literals and preserve existing DNS and IPv4
  behavior.
- Normalize configuration before it is exposed to template rendering, CEL, or
  BDD steps.
- Avoid bulk changes to artifacthub-shim feature files and test fixtures.
- Keep known tool limitations visible as skipped scenarios instead of masking
  them as product regressions.
- Validate the behavior in a PAC-triggered pipeline with real external-tool
  operations and an Allure report.

## Non-Goals

- BDD will not discover host fields from YAML key names or value shapes.
- BDD will not rewrite complete URL, endpoint, registry, or image-reference
  fields.
- Zoned IPv6 literals are classified and bracketed, but the validation PAC does
  not cover link-local zones or URI zone escaping.
- This change will not make a tool IPv6-capable when the tool itself rejects an
  IPv6 registry or endpoint.
- The temporary validation pipeline will not claim native IPv6-only or dual-stack
  network coverage. It validates IPv6 literal parsing and end-to-end tool
  interaction over a controlled proxy path.
- BDD will not persist the normalized values back to `config.yaml`.

## BDD API Design

The canonical implementation and review repository for this API is
`https://code.alauda.io/library/bdd`. The former GitHub repository is no longer
used for development. Its `github.com/AlaudaDevops/bdd` module path remains in
consumer imports for compatibility. artifacthub-shim consumes the GitLab-hosted
release with a Go module `replace` directive instead of relying on the former
GitHub distribution path.

BDD will add a fluent suite API:

```go
bdd.New().
    WithSuiteName("ArtifactHub-Shim").
    WithIPv6HostFields(
        "toolchains.gitlab.host",
        "toolchains.harbor.host",
        "toolchains.nexus.host",
        "toolchains.nexus_mirror.host",
        "toolchains.sonarqube.host",
    ).
    Run()
```

`WithIPv6HostFields(paths ...string)` has the following contract:

- Paths use dot-separated map keys rooted at `config.Config.Data`.
- Multiple calls accumulate paths. Duplicate paths are harmless and are
  normalized once.
- Empty paths, missing path components, and non-string leaf values are
  configuration errors. BDD logs the failing path and exits before starting the
  Godog suite.
- An empty string is a valid string value and remains unchanged, preserving the
  current optional-toolchain configuration behavior.
- Paths address maps only; sequence indexing and wildcard expansion are not
  supported.
- Suites that do not call `WithIPv6HostFields` retain the existing behavior.

BDD applies normalization after `config.LoadConfig` succeeds and before calling
`config.WithConfig`. This guarantees that template variables, built-in steps,
shared extensions, cleanup logic, and CEL expressions observe the same value.

### Normalization semantics

The implementation uses `net/netip` to identify IP literals. Detection and
rewriting follow these rules:

| Configured value | In-memory value | Notes |
| --- | --- | --- |
| `2001:db8::10` | `[2001:db8::10]` | Raw IPv6 literal |
| `[2001:db8::10]` | `[2001:db8::10]` | Idempotent |
| `fe80::1%eth0` | `[fe80::1%eth0]` | Zone is preserved; URI consumers still encode `%` as `%25` |
| `::ffff:192.0.2.10` | `[::ffff:192.0.2.10]` | IPv4-mapped IPv6 is treated as IPv6 |
| `192.0.2.10` | `192.0.2.10` | IPv4 is unchanged |
| `gitlab.example.com` | `gitlab.example.com` | DNS name is unchanged |
| `` | `` | Empty optional value is unchanged |

The parser is used only for classification. BDD preserves the original spelling
inside the brackets instead of canonicalizing the address. Values that are not
recognized as IP literals remain unchanged because valid DNS names also fail IP
literal parsing.

The BDD change will include table-driven unit tests for raw and bracketed IPv6,
IPv4, DNS, empty values, zones, IPv4-mapped IPv6, malformed values, duplicate
paths, missing paths, and non-string fields. It will be released as BDD v1.23.0
before artifacthub-shim consumes the API.

## artifacthub-shim Integration

The artifacthub-shim test module will upgrade from BDD v1.22.2 to v1.23.0 and
replace that logical module with the GitLab release:

```go
replace github.com/AlaudaDevops/bdd => code.alauda.io/library/bdd v1.23.0
```

It will also declare these paths in `testing/main_test.go`:

- `toolchains.gitlab.host`
- `toolchains.harbor.host`
- `toolchains.nexus.host`
- `toolchains.nexus_mirror.host`
- `toolchains.sonarqube.host`

No bulk rewrite of existing `host:port`, Git URL, registry reference, or Docker
authentication templates is required. For an IPv6 configuration, the existing
templates will naturally render values such as:

- `https://user:password@[2001:db8::10]:443/group/repository.git`
- `[2001:db8::20]:8443/project/image:tag`
- `[2001:db8::20]` and `[2001:db8::20]:8443` Docker authentication keys

IPv4 and DNS-based configurations produce byte-for-byte equivalent rendered
values.

### Raw-host exceptions

The configured value becomes an authority-form host for all declared paths.
Callers that use a host as an identifier or TLS server name must remove exactly
one matching pair of outer brackets:

- `generate-tls-cert-secret.sh` must keep brackets when building the OpenSSL
  `-connect host:port` target, but remove them for `-servername` because TLS SNI
  expects the raw server name.
- The SonarQube auto-project-key assertion must compare against the unbracketed
  `host` because the project key is an identifier derived from the parsed
  repository URL, not a URL authority. Test preparation pre-creates that exact
  key and uses a narrowly anchored permission-template pattern. Because
  sonarqube-cli v0.3.0 does not make that template membership effective for the
  generated scan user, preparation also grants that user the project-level
  `user`, `codeviewer`, and `scan` permissions explicitly. It then revokes and
  reissues the same named `USER_TOKEN` after the grants, verifies that the token
  resolves to the generated login and can read the pre-created project, and
  atomically replaces the token in the generated test configuration. Reusing
  the login and token name preserves the existing sonarqube-cli cleanup state.
  The Task credential workspace exposes only `sonar.token=<USER_TOKEN>`,
  matching the supported contract for SonarScanner CLI 8.1 and SonarQube
  Community Build 26.1 without also setting legacy login fields. A project
  analysis token is intentionally not used: it can submit analysis but cannot
  read the measures consumed by the Task's follow-up analysis step.
- The SonarQube auto-project-key scenario still clones `refs/heads/maven`, but
  it does not pass that Git ref as `sonarBranchName`. The scenario validates
  automatic project-key derivation rather than branch analysis, and SonarQube
  Community Build supports analysis of the main branch only. Omitting the
  optional Scanner parameter keeps the clone fixture unchanged and records the
  result against the project's main branch; this scenario does not validate
  multi-branch analysis.
- Future raw-host consumers must perform the same explicit conversion rather
  than adding parallel `rawHost` fields to `config.yaml`.

These are narrow semantic exceptions. They do not change the decision to keep
the existing authority-oriented feature templates unchanged.

### Test report credential handling

The SonarQube scenario renders the generated scanner token into a Kubernetes
Secret. BDD attaches imported resources to the test report and also collects
resource YAML during failure diagnostics. BDD v1.23.0 must therefore redact the
values under `data` and `stringData` whenever the resource kind is `Secret`,
including Secret items nested in Kubernetes List objects. Redaction is applied
to a deep copy used only for attachments and diagnostic logs; the original
object keeps its real values for Kubernetes creation and assertion processing.
Secret API and admission errors also use a safe outward-facing message while
preserving their unwrap chain for programmatic checks, so a server response
cannot echo credential values into Godog or Allure output. The artifacthub-shim
compatibility tests render the real SonarQube credential fixture with a sentinel
token and verify that the report contains only `[REDACTED]` while the source
Secret remains unchanged.

## Known IPv6 Exclusions

[DEVOPS-44328](https://jira.alauda.cn/browse/DEVOPS-44328) records the known
Skopeo limitation for IPv6-form registry addresses. The PAC validation also
confirmed that Buildah v0.10 with `buildah:v1.33` rejects the same bracketed
registry authority before a build starts. Buildah and Skopeo registry
operations are therefore the known exclusions for this change.

### Validation compatibility matrix

| Tool path | Scenario or probe | Expected IPv6 result | Rationale |
| --- | --- | --- | --- |
| GitLab | `tektoncd-task-gitlab-cli-001` and repository setup push | Supported | GitLab requests use the normalized bracketed authority through the validation proxy. |
| Harbor | Authenticated Crane metadata probe and k3s image-pull Job | Supported by the validation harness | These checks prove the bracketed registry authority independently of catalog Task client limitations. |
| Nexus | `tektoncd-task-nexus-upload-roundtrip-001` | Supported | Upload and download operations use the normalized Nexus authority. |
| Nexus Mirror | `tektoncd-task-nodejs-publish` | Supported | Node.js package publication and mirror access use the normalized authority. |
| SonarQube | `tektoncd-pipeline-sonarqube-001` | Supported | The scan uses the IPv6 SonarQube endpoint; its prerequisite Git clone reaches the GitLab IPv6 endpoint directly. |
| Buildah v0.10 / `buildah:v1.33` | `tektoncd-pipeline-buildah-001` and `tektoncd-pipeline-buildah-002` | Skipped | A clean `[IPv6]:port/repository:tag` is rejected as `invalid reference format` before `buildah bud` starts. |
| Skopeo | `tektoncd-task-skopeo-copy-results-registry-001` and `catalog-resolver-skopeo-copy-with-image-001` | Skipped | The Task client does not support the bracketed IPv6 registry authority. |

The affected Buildah and Skopeo scenarios carry an `@ipv6-unsupported` tag and
execute the BDD v1.22+ scenario-skip step before a PipelineRun or TaskRun is
created:

```gherkin
并且 满足 CEL 表达式则跳过当前用例
    | cel                                         | reason                                      |
    | toolchains.harbor.host.startsWith("[")     | The Task does not support IPv6 registries   |
```

The declared host is bracketed before CEL evaluation, so `startsWith("[")`
identifies IPv6 literals without misclassifying DNS or IPv4 authorities that
contain a port. Resolver scenarios use the same rule against `registry.test`,
which is configured as a complete bracketed IPv6 registry authority.

The exclusion applies to:

- Both Buildah v0.10 pipeline scenarios. They use the same Harbor image
  reference, so the build-only and build-plus-inspection paths fail at the same
  reference-validation boundary.
- The standalone `skopeo-copy` scenario that reads from or writes to the Harbor
  registry.
- The resolver matrix entry that actually executes `skopeo-copy` with registry
  transport. That row must be separated into its own scenario so the tag and CEL
  skip are scoped only to the unsupported behavior.

Skopeo use in test preparation or assertion code is not a product capability
test. IPv6 helper paths will move to Crane so supported Task scenarios are not
skipped because of the test harness. The existing Skopeo fallback remains for
DNS or IPv4 HTTPS registries that require skipped certificate verification,
because Crane cannot express that transport policy. Crane must be built into the
E2E image; the pipeline must not download it at runtime, preserving air-gap
behavior.

Crane's `--insecure` flag selects plain HTTP and applies to every reference in a
single invocation. Cross-registry fixture synchronization therefore pulls the
source into a temporary tar or OCI layout with the source's normal TLS policy,
then pushes it separately with the destination policy. Plain HTTP IPv6 proxies
use `--insecure` only for destination login and push. Trusted HTTPS needs no
flag. An IPv6 HTTPS registry configured with `skipTLSVerify: true` is rejected
with a clear harness error because the Crane CLI cannot express HTTPS with
certificate verification disabled without also selecting HTTP; the temporary
validation proxy uses HTTP or a trusted certificate.

## PAC IPv6 Validation

A temporary PAC pipeline, triggered by `/e2e-ipv6`, will validate the change
before merge. It will reuse the existing CTYun VM integration environment,
branch E2E image build, catalog test preparation, and Allure upload tasks.

The validation flow is:

1. Provision the normal external GitLab, Harbor, Nexus, Nexus Mirror, and
   SonarQube test services and prepare credentials through their original
   endpoints.
2. Deploy a temporary multi-port HTTP reverse proxy on the disposable VM host
   network with dynamically selected high ports.
   Each listener maps one IPv6-facing tool endpoint to its original service,
   supplies the expected upstream Host/SNI value, and rewrites redirect or
   authentication headers when required. In particular, GitLab `Location` and
   Harbor `WWW-Authenticate` realm values must remain reachable through the
   proxy.
3. Expose the proxy through a canonical hexadecimal IPv4-mapped IPv6 literal,
   such as `::ffff:c000:20a`. Toolchain `host` fields contain the unbracketed
   literal so the BDD API is responsible for normalization. Complete `endpoint`
   and registry authority fields use syntactically valid bracketed values. The
   equivalent dotted form, such as `::ffff:192.0.2.10`, remains covered by BDD
   unit tests, but is not used in Kubernetes image references because common
   distribution parsers only allow hexadecimal digits and colons inside the
   bracketed IPv6 authority.
4. Run a direct connectivity probe from the E2E execution environment before
   the BDD suite. This proves that the mapped IPv6 authorities and response
   rewrites work outside the disposable k3s pod network.
5. Expose a sixth, route-restricted HTTP forward listener through a ClusterIP
   Service. The disposable Tekton `config-defaults` PodTemplate injects
   `HTTP_PROXY`, `http_proxy`, and narrowly scoped `NO_PROXY` values into every
   TaskRun step. A temporary Java HTTP proxy option covers clients such as
   SonarScanner that do not directly consume the conventional environment
   variables. HTTPS proxy variables are intentionally absent because the
   validation endpoints use plain HTTP and the proxy does not implement
   `CONNECT`.
6. Create a real Tekton TaskRun that first proves direct IPv4 host-network
   access, then accesses all five bracketed IPv6 authorities through the
   ClusterIP forward proxy. It also verifies GitLab `Location`, Harbor bearer
   realm rewriting, and that `NO_PROXY` does not contain the VM address or a
   broad private CIDR that could bypass the mapped IPv6 route.
7. Register the Harbor authority as a plain-HTTP mirror in the disposable
   k3s `registries.yaml`, then run a real image-pull Job using the bracketed
   registry key.
8. Execute supported scenarios with `@ipv6-unsupported` excluded. This run must
   cover real GitLab operations, Nexus upload or dependency access, and
   SonarQube access. The preceding Crane and image-pull checks retain explicit
   Harbor authority coverage without relying on an incompatible catalog Task.
9. Execute only `@ipv6-unsupported` scenarios in a second run and verify that
   the CEL condition records the two Buildah and two Skopeo cases as Skipped
   rather than Failed.
10. Merge both result sets, generate one Allure report, upload it through the
   existing report task, and clean up the proxy and temporary resources in the
   pipeline `finally` path.

The host-network listeners are reachable from the outer E2E container, but the
disposable k3s pod network is IPv4-only and cannot directly establish the same
IPv4-mapped IPv6 connection. The ClusterIP forward proxy bridges that test
environment limitation without changing the IPv6 authority seen by application
clients. It accepts only configured tool authorities, which prevents the
temporary Service from becoming a general in-cluster proxy. The helper removes
its Kubernetes namespace during normal cleanup; the existing CTYun pipeline
`finally` task destroys the VM and therefore resets both the Tekton defaults and
the runtime mirror configuration even when the test process is interrupted.

The catalog `git-clone` 0.10 image reports `Out of memory` when its
Git 2.54/libcurl 8.21 stack receives a bracketed IPv6 repository URL through an
HTTP proxy that returns any response, including 200, 302, 401, or 403. A failed
proxy connection instead produces the expected connection error, and the Pod
is not OOM-killed. The failure is therefore specific to the proxied path: the
client misparses the non-git HTTP body that the proxy returns, not the IPv6
authority itself. A direct IPv6 connection to GitLab returns a valid
`git-upload-pack` advertisement that the client parses correctly, so the clone
step relies on direct IPv6 reachability to GitLab rather than routing through the
IPv4-only forward proxy. This suite therefore assumes the runner can reach the
GitLab endpoint over IPv6 directly for the prerequisite clone; no preserved
fallback endpoint is configured. GitLab IPv6 coverage remains explicit through
the setup push and the `gitlab-cli` scenario, and the SonarQube operation under
test uses its IPv6 endpoint. Buildah is excluded independently because its image
reference parser rejects the bracketed Harbor authority before the build starts.

The temporary PAC definition is removed after the validation evidence is
captured. No credentials, fixed internal addresses, kubeconfigs, or proxy
artifacts are committed.

## Acceptance Criteria

- BDD unit tests prove that only declared IPv6 host fields receive one pair of
  brackets and that missing or mistyped declarations fail before suite startup.
- artifacthub-shim retains its existing feature-template structure; only the
  suite declaration, documented raw-host exceptions, and explicit known-
  incompatibility skips require case changes.
- Existing IPv4 and DNS test configurations continue to render and pass without
  behavioral changes.
- BDD attachments and failure diagnostics never contain rendered Kubernetes
  Secret values, and redaction does not mutate the object submitted to the
  cluster.
- Declared IPv6 host fields render valid Git URLs, image references, and Docker
  authentication keys when existing templates compose the authority. Complete
  endpoint and registry fields are supplied by the caller in bracketed form,
  for example `http://[2001:db8::10]:8080`.
- Supported GitLab, Nexus, and SonarQube scenarios pass through the temporary
  IPv6 proxy. Authenticated Crane and k3s image-pull checks separately prove the
  bracketed Harbor authority.
- A real TaskRun proves that the default PodTemplate injects the forward proxy
  without adding the mapped IPv6 target or broad CIDRs to `NO_PROXY`, while a
  separate Job proves that k3s can pull from the bracketed Harbor authority.
- The two Skopeo limitations documented by DEVOPS-44328 and the two Buildah
  limitations confirmed by PAC match their exact case IDs and scenario names
  as Skipped in Allure and do not hide failures in supported scenarios.
- The final Allure report and pipeline URL are retained as implementation
  evidence, while the temporary PAC pipeline and proxy resources are removed.
