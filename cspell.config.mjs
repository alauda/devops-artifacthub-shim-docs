import defaultConfig from '@alauda/doom/cspell'

export default {
  ...defaultConfig,
  words: [
    ...(defaultConfig.words || []),
    'artifacthub',
    'Artifacthub',
    'ConfigMap',
    'ConfigMaps',
    'StepAction',
    'StepActions',
    'Tekton',
    'tekton',
    'TaskRun',
    'TaskRuns',
    'PipelineRun',
    'PipelineRuns',
    'hubs',
    'readyz',
    'healthz',
    'Erebus',
    'kube',
    'RBAC',
  ],
}
