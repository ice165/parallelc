// Pre-process
export { scanRepoContext } from './pre-process/repo-scanner.js';
export type { RepoContext } from './pre-process/repo-scanner.js';
export { extractModuleMap } from './pre-process/module-map.js';
export type { ModuleBoundary } from './pre-process/module-map.js';
export { estimateTokens } from './pre-process/token-estimator.js';
export type { TokenEstimate } from './pre-process/token-estimator.js';

// Decompose
export { buildOrchestratorPrompt } from './decompose/prompt-builder.js';
export type { DecompositionInput } from './decompose/prompt-builder.js';
export { decomposeViaClaude } from './decompose/mcp-decomposer.js';
export type { DecomposerOptions, DecomposerResult } from './decompose/mcp-decomposer.js';
export { parseTaskDAG } from './decompose/response-parser.js';
export type { TaskDraft } from './decompose/response-parser.js';

// Post-validate
export { detectStalled } from './post-validate/stall-detector.js';
export type { StalledTask } from './post-validate/stall-detector.js';
export { enforceHardRules } from './post-validate/rule-engine.js';
export type { RuleResult } from './post-validate/rule-engine.js';
export { validatePaths } from './post-validate/path-validator.js';
export type { PathValidation } from './post-validate/path-validator.js';
export { validateDAG } from './post-validate/dag-validator.js';
export type { DagValidation } from './post-validate/dag-validator.js';
export { executeL1Directly } from './post-validate/l1-executor.js';
export type { L1ExecutionResult } from './post-validate/l1-executor.js';
export { confirmL3Tasks } from './post-validate/l3-confirm.js';
export type { L3Confirmation } from './post-validate/l3-confirm.js';

// Cost budget
export { CostTracker } from './cost-tracker.js';
export type { CostConfig, TokenUsage } from './cost-tracker.js';

// Repro generator
export { generateRepro } from './repro-generator.js';
export type { ReproContext } from './repro-generator.js';

// Core
export { buildDAG } from './dag-builder.js';
export type { BuildDagOptions, BuildDagResult } from './dag-builder.js';
export { recordPrediction, updatePredictionRecord, getPredictionAccuracy } from './metrics-collector.js';
export type { PredictionRecord } from './metrics-collector.js';
