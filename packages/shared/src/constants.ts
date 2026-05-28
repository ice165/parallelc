export const EXIT_SUCCESS = 0;
export const EXIT_CHECKPOINT = 10;
export const EXIT_TIMEOUT = 11;
export const EXIT_HOOK_BLOCKED = 12;
export const EXIT_RATE_LIMIT = 13;
export const EXIT_TAMPER = 14;

export const EXIT_CODE_LABELS: Record<number, string> = {
  [EXIT_SUCCESS]: 'EXIT_SUCCESS',
  [EXIT_CHECKPOINT]: 'EXIT_CHECKPOINT',
  [EXIT_TIMEOUT]: 'EXIT_TIMEOUT',
  [EXIT_HOOK_BLOCKED]: 'EXIT_HOOK_BLOCKED',
  [EXIT_RATE_LIMIT]: 'EXIT_RATE_LIMIT',
  [EXIT_TAMPER]: 'EXIT_TAMPER',
};

// CEO review constants
export const MAX_CEO_ROUNDS = 3;
export const CEO_PASS_THRESHOLD = 80;
export const CEO_ESCALATE_THRESHOLD = 50;
export const MAX_CEO_COST_PER_DAG = 1.00;
export const MAX_CEO_COST_PER_SESSION = 5.00;
export const MAX_REVIEW_OUTPUT_TOKENS = 4096;
export const CEO_SKIP_CLARITY_SCORE = 95;
export const CEO_SKIP_F1BETA_SCORE = 0.85;
