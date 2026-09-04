# Automated Release Validation Across ACP Environments

This guide captures the reusable operating practices for validating an
`artifacthub-shim` release candidate with the `plugin-release-test` Pipeline
across multiple ACP environments. It covers artifact reuse, environment gates,
test observability, report acceptance, failure recovery, and resolver
provenance.

Use the [manual release validation guide](artifacthub-shim-manual-release-validation.md)
only when the Pipeline cannot run or when the global and workload APIs require
different kubeconfigs.

## Validation matrix

Use environments with different topology and network paths. A representative
four-environment release matrix is:

| Environment | Control path | Final topology | Environment source | Lifecycle |
| ----------- | ------------ | -------------- | ------------------ | --------- |
| env1 | SOCKS | 2 Regions / 6 Machines | Existing-environment reuse | Provider-managed |
| env2 | Direct | 1 Region / 5 Machines | Fresh CTYun environment | 8 hours from creation |
| env3 | SOCKS | 3 Regions / 6 Machines | Existing-environment reuse | Provider-managed |
| env4 | Direct | 2 Regions / 5 Machines | Fresh CTYun environment | 8 hours from creation |

The acceptance baseline for each environment is the complete installed-plugin
suite selected with `~@install`. In the validated matrix, all four environments
completed the suite with 189 of 189 scenarios passing. A smaller diagnostic
selection is not equivalent release evidence.

SOCKS is part of the control path for env1 and env3. It must not become the
transport for plugin-package or image bytes. Package distribution continues
through regional object storage and Violet so the procedure remains valid for
air-gapped environments.

## Freeze the release inputs

Record the following inputs before starting any environment:

- Plugin source revision, package, and release version.
- Catalog runtime revision or immutable digest.
- E2E image tag and immutable digest.
- Operator and external tool versions required by the test matrix.
- Pipeline and Task resolver provenance.

Pass only the E2E image tag to the Pipeline. Retain its digest as audit
evidence, but do not construct a `tag@digest` value because the downstream
package and image-import contracts expect a tag.

Upload a large plugin or E2E artifact once. Wait until the first PipelineRun
proves that the artifact is visible, then start the other environments in
parallel. Every later PipelineRun must report `package-action=reused`; an
unexpected upload is a reason to stop that run before it duplicates or replaces
the frozen artifact.

## Run environments in parallel

env1 through env4 can progress independently. A failure in one environment
must not cancel healthy PipelineRuns in the other environments. Observe the
PipelineRuns, TaskRuns, Pods, release-test Plans, and Environments every three
to five minutes. Some provider and regional synchronization operations produce
no log output for extended periods, so silence alone is not a failure signal.

An environment is ready for downstream installation only when all of these
conditions are true:

- The release-test Plan reports `TestFinished`.
- The Environment reports `Ready`.
- The expected Region and Machine counts match the matrix and every object is
  Ready.
- The environment failure count is zero.
- `platform_info` is readable without printing addresses, credentials, proxy
  settings, or Secret data.

Set the ArtifactHub environment's CPU and memory overcommit ratios through
Pipeline parameters. The reusable Pipeline keeps conservative defaults of
CPU `3` and memory `3`; the ArtifactHub PipelineRun overrides them with the
validated CPU `5` and memory `10` values rather than hard-coding component
policy into shared Tasks.

## Gate installation and testing

Do not start the release suite as soon as the Environment becomes Ready. Verify
the complete dependency chain first:

1. The main plugin package, Operator dependency package, and E2E image-only
   package are synchronized to every target Region and imported by Violet.
2. Storage is Ready and usable from nodes selected for builds.
3. The v4.13 Operator main resource and the Operator-managed `TektonConfig`
   have converged.
4. GitLab, Harbor, Nexus, and SonarQube report Ready at their frozen versions.
5. The target `ModulePlugin` version is Ready, the CPI spec is correct, and
   `ModuleInfo` reports `Running`.
6. The `run-tests` TaskRun has started only after all preceding gates pass.

TopoLVM needs an end-to-end capacity check. Ready custom resources and CSI Pods
are insufficient: confirm that a build-compatible node is in the selected
topology, that a matching `deviceClass` is advertised there, and that the
intersection has positive allocatable capacity.

Treat required Secrets as a three-state bootstrap input: present, absent, or
unreadable. Reuse a present valid Secret, create an absent one through the
authorized bootstrap path, and fail explicitly when it is unreadable. Do not
collapse authorization errors into the absent state.

## Respect environment lifetime during retries

CTYun environments such as env2 and env4 are reclaimed eight hours after
creation. Start a complete suite only when at least four hours remain. Recreate
an older environment rather than launching a suite that cannot finish before
reclamation.

When preparation fails before the Environment becomes Ready:

1. Preserve the redacted first error and the state of the Plan, Environment,
   Region, and Machine objects.
2. Delete only the owner chain created by that PipelineRun.
3. Wait until all four object kinds reach zero for that environment.
4. For CTYun, wait the complete 300-second provider quota-release window.
5. Start a fresh PipelineRun with a new name and the same frozen artifacts.

If provider `CreateFailed` events keep increasing while the expected topology
does not progress, the run can be classified early as a provider-capacity
failure and recreated after the cleanup gates. Waiting for an otherwise
inevitable Pipeline timeout adds no evidence.

When a downstream task fails after the Environment is Ready, reuse the existing
environment only if its remaining lifetime is sufficient. Generate the
existing-environment Secret in memory, bind it to the exact replacement
PipelineRun owner UID, preserve SOCKS for env1 and env3, preserve direct access
for env2 and env4, keep package mode set to reuse, leave explicit package URLs
empty, and continue to pass the E2E tag without a digest suffix.

Do not delete a failed PipelineRun until every TaskRun is terminal and the
Tekton Results records needed for audit and diagnosis are complete.

## Preserve live test output

The `run-tests` log must stream the necessary redacted raw BDD stdout line by
line. Fixed phase names, step numbers, step status, and aggregate progress are
useful supplemental signals, but they must not replace the runner's original
test output. Redaction must remove credentials and infrastructure details
without hiding the failure context required for diagnosis.

Live output is progress evidence only. The generated Allure data remains the
authority for final counts and case outcomes.

## Accept only authoritative reports

Upload reports to shared object storage rather than a service exposed from the
temporary target environment. An authoritative suite report must declare:

```text
report_authoritative=true
report_kind=suite
```

A harness failure may publish diagnostic output, but it must be labelled:

```text
report_authoritative=false
report_kind=harness-fallback
```

Never count a fallback report as release evidence. For an authoritative report,
verify all of the following:

- The entry point renders a complete Allure application rather than a health
  response or placeholder page.
- `summary.json`, recursive `behaviors.json` leaves, and every referenced case
  detail are readable.
- Summary totals equal the recursive behavior-leaf count.
- Total, passed, failed, broken, and skipped counts are recorded.
- The Environment widget has non-empty values for the ACP version, environment
  name and type, access-entry classification, ArtifactHub plugin version,
  GitLab version, Harbor version, Nexus version, SonarQube version,
  `tektoncd-operator` version, PipelineRun name, and PipelineRun provenance.

Do not copy report addresses, platform addresses, proxies, credentials, case
text, or attachment contents into chat, webhooks, or progress documents.

## Diagnose before changing code

Use evidence in this order:

1. Current Pod logs while the workload still exists.
2. Tekton Results after Pods or TaskRuns have been garbage-collected.
3. Allure summary, recursive behaviors, case details, and redacted attachments.

Classify the first actionable failure as environment infrastructure,
ArtifactHub product behavior, or test automation before proposing a code
change. Update the report-attribution record first. If product behavior or an
API changes, also review the repository's `spec/` documentation. Do not rewrite
tracked feature files or test data at runtime to make a failure pass.

## Prove resolver provenance

A commit-scoped Cluster Resolver is suitable for pre-merge validation. Do not
refresh shared namespace-local Catalog resources while active PipelineRuns may
still resolve them.

The delivery gate is stricter: switch the PipelineRef to the published Hub
resolver using catalog `extra-pipelines`, kind `pipeline`, name
`plugin-release-test`, and version `0.1`. Run a reuse smoke test and record
PipelineRun and TaskRun provenance proving that the Pipeline and all Tasks
came from Hub rather than namespace-local resources. The resolved Pipeline
continues to load its component Tasks from the `extras` Task catalog.

The four-environment matrix establishes the behavior of the frozen,
commit-scoped runtime. It must not be described as proof of final Hub resolver
provenance until that smoke test passes.

## Clean up without losing audit evidence

After the Hub resolver smoke test succeeds, remove the temporary release-test
Pipeline, its temporary Catalog Tasks, one-time diagnostic resources,
owner-bound existing-environment Secrets, and unowned task-specific Secrets.

Retain successful acceptance environments for their agreed lifetime, plus the
PipelineRun and Tekton Results records and the shared authoritative reports
needed for release audit.
