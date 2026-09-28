/**
 * Combo strategy presentation: the option list the strategy pickers render, the
 * English fallbacks the `combos` namespace is allowed to be missing, and the
 * key→sentence resolvers that turn a translator into a finished string.
 *
 * Extracted verbatim from `page.tsx` (which is frozen for size). Nothing here
 * touches React or the network, so the copy contract can be pinned by a suite
 * that cannot mount the page — see `tests/unit/combo-strategy-copy.test.ts`.
 *
 * The page keeps its own `t`/`tc` bindings; every resolver here takes the
 * translator as its first argument for exactly that reason.
 */

import { ROUTING_STRATEGIES } from "@/shared/constants/routingStrategies";

import {
  COMBO_DRAFT_ISSUE_MESSAGE_KEYS,
  comboDraftIssueValues,
  type ComboDraftIssue,
  type ComboDraftIssueCode,
} from "@/shared/utils/aisixCombos";
const STRATEGY_OPTIONS = ROUTING_STRATEGIES.map((strategy) => ({
  value: strategy.value,
  labelKey: strategy.labelKey,
  descKey: strategy.combosDescKey,
  icon: strategy.icon,
}));
/**
 * English fallbacks for the strings the AISIX combo contract adds, following
 * this page's existing literal-fallback idiom (see `STRATEGY_LABEL_FALLBACK`).
 * Every one of these also has a real translation in all 66 locale catalogues;
 * the literal only covers a locale that has not caught up, so it must read as a
 * finished sentence and never as a key name.
 */
const AISIX_COMBO_TEXT = {
  gatewayAdminKeyRequired:
    "The gateway answered 401: the combos surface needs an admin key. Add one to admin.admin_keys in the gateway config, then reload. The combos below are withheld, not empty.",
  gatewayWriteUnavailable:
    "This gateway refused to persist the change; the data below is what the reload will find:",
  gatewayVerbRefused:
    "The gateway does not route that HTTP verb for combos. It serves POST to create, PATCH to update and DELETE to remove.",
  draftRefused:
    "The combo was not sent: it breaks a rule the gateway enforces. See the field highlighted below.",
  contractBanner:
    "A combo here is a virtual routing model, and the gateway implements a subset of this form. It stores name, strategy and models — inside a model: model, weight, priority, tags. Every other field, and 13 of the 19 template strategies, is refused by name on save.",
  contractStrategyHint:
    "Pick one of the six strategies this gateway routes with. The other 13 template strategies are shown disabled: choosing one would be refused on save.",
  contractStrategyUnavailable: "not implemented by this gateway",
  contractRefusedFieldsTitle: "Fields this gateway refuses on save",
  contractRefusedFieldsHint:
    "Each of these is turned off in the form rather than accepted and ignored — a field that saves and does nothing reads as configured and is not.",
  contractActiveToggleReason:
    "Enable/disable is refused: the routing model has no per-combo enabled flag.",
  catalogUnavailable:
    "The direct-model list has not loaded, so a target is checked when you save rather than as you type.",
  draftIssuesTitle: "This combo cannot be saved yet:",
};

/** One English sentence per rule code, parallel to `COMBO_DRAFT_ISSUE_MESSAGE_KEYS`. */
const AISIX_COMBO_DRAFT_ISSUE_FALLBACKS: Record<ComboDraftIssueCode, string> = {
  name_required: "Give the combo a name (whitespace is not a name).",
  strategy_unsupported:
    "This routing strategy is not implemented by the gateway. Choose one of the six above.",
  models_required: "Add at least one model to route across.",
  model_required: "Each step must name a model.",
  model_not_direct:
    "{model} is not a direct model. A combo target must be a model that dispatches to an upstream of its own — not another combo, ensemble or semantic model.",
  model_duplicate: "{model} is already in this combo. A combo lists each target once.",
};

const STRATEGY_LABEL_FALLBACK = {
  "context-relay": "Context Relay",
  "reset-aware": "Reset-Aware RR",
};

const STRATEGY_DESC_FALLBACK = {
  "context-relay":
    "Priority-style routing with automatic context handoffs when account rotation happens.",
  "reset-aware":
    "Quota remaining and reset windows decide the order; similar scores rotate round-robin.",
};

const STRATEGY_GUIDANCE_FALLBACK = {
  priority: {
    when: "Use when you have one preferred model and only want fallback on failure.",
    avoid: "Avoid when you need balanced load between models.",
    example: "Example: Primary coding model with cheaper backup for outages.",
  },
  weighted: {
    when: "Use when you need controlled traffic split across models.",
    avoid: "Avoid when weights are not maintained or you need strict fairness.",
    example: "Example: 80% stable model and 20% canary model for safe rollout.",
  },
  "round-robin": {
    when: "Use when you need predictable, even request distribution.",
    avoid: "Avoid when model latency/cost differs significantly.",
    example: "Example: Same model across multiple accounts to spread throughput.",
  },
  "context-relay": {
    when: "Use when long sessions must survive account rotation without losing the working context.",
    avoid:
      "Avoid when account switching is rare or when you do not want extra summarization requests.",
    example: "Example: Codex sessions that rotate across multiple accounts near quota exhaustion.",
  },
  random: {
    when: "Use when you want a simple spread with low configuration effort.",
    avoid: "Avoid when requests must be distributed with strict guarantees.",
    example: "Example: Prototyping with equivalent models and no traffic policy.",
  },
  "least-used": {
    when: "Use when you want adaptive balancing based on recent demand.",
    avoid: "Avoid when your traffic is too low to benefit from usage balancing.",
    example: "Example: Mixed workloads where one model tends to get overloaded.",
  },
  "cost-optimized": {
    when: "Use when minimizing cost is the top priority.",
    avoid: "Avoid when pricing data is missing or outdated.",
    example: "Example: Batch or background jobs where lower cost matters most.",
  },
  "reset-aware": {
    when: "Use when multiple accounts with quota telemetry have different reset windows.",
    avoid: "Avoid when quota telemetry is unavailable for most accounts.",
    example: "Example: Prefer a 60% weekly account resetting tomorrow over 80% that resets later.",
  },
  "fill-first": {
    when: "Use when you want to drain one provider's quota fully before moving to the next.",
    avoid: "Avoid when you need request-level load balancing across providers.",
    example: "Example: Use all $200 Deepgram credits before falling to Groq.",
  },
  p2c: {
    when: "Use when you want low-latency selection using Power-of-Two-Choices algorithm.",
    avoid: "Avoid for small combos with 2 or fewer models — no benefit over round-robin.",
    example: "Example: High-throughput inference across 4+ equivalent model endpoints.",
  },
  "strict-random": {
    when: "Use when you want perfectly even spread — each model used once before repeating.",
    avoid: "Avoid when models have different quality or latency and order matters.",
    example: "Example: Multiple accounts of the same model to distribute usage evenly.",
  },
  auto: {
    when: "Use when you want multi-factor scoring based on cost, latency, and quality.",
    avoid: "Avoid when you need strict priority ordering or historical persistence.",
    example: "Example: Balance requests between models with different strengths.",
  },
  lkgp: {
    when: "Use when you want routing based on historical success rates and performance.",
    avoid: "Avoid when historical data is limited or unreliable.",
    example: "Example: Route to models with proven track records for specific tasks.",
  },
  "context-optimized": {
    when: "Use when you need to optimize for context window usage across models.",
    avoid: "Avoid when models have similar context lengths or simple tasks.",
    example: "Example: Distribute long conversations across models with large context windows.",
  },
  "quota-weighted": {
    when: "Use when several accounts of the same model have quota snapshots and concurrent traffic should land on accounts that still have leftover.",
    avoid: "Avoid when most accounts have no quota snapshots.",
    example:
      "Example: 10 Antigravity Gemini accounts with different 5h/weekly resets; skip empty ones and pick among the rest in proportion to leftover.",
  },
};

const ADVANCED_FIELD_HELP_FALLBACK = {
  maxRetries: "How many retries are attempted before failing the request.",
  retryDelay: "Initial delay between retries. Higher values reduce burst pressure.",
  concurrencyPerModel:
    "Round-robin combo/model limit: max simultaneous requests sent to each model target. This is separate from any provider account-only cap.",
  queueTimeout:
    "How long a request can wait for a round-robin model slot before timing out. This queue is separate from any account-only concurrency cap.",
  stickyLimit:
    "Round-robin sticky batch size: consecutive successful requests sent to one target before rotating to the next. Empty inherits the global Sticky Limit setting; 1 disables batching (pure one-request rotation).",
  stickyWeightedLimit:
    "Weighted sticky batch size: consecutive successful requests sent to the selected weighted target before drawing again. Empty or 1 keeps the current per-request weighted draw.",
  failoverBeforeRetry:
    "When enabled, a 429 from the upstream triggers immediate target failover instead of retrying the same URL first.",
  maxSetRetries:
    "Number of times to retry the full target set when every target fails. 0 = no set-level retry.",
  setRetryDelayMs:
    "Delay between set-level retry attempts, giving transient issues time to resolve.",
  nestedComboMode:
    "How references to other combos are handled. Flatten expands a combo ref into this combo's target list (legacy). Execute treats a combo ref as a black-box target: the parent strategy selects the child combo, then the child runs its own strategy and retries.",
  reasoningTransportFallback:
    "What to do when the next combo target cannot accept the original reasoning transport. Drop is the default: it removes reasoning state and tries the target. Skip leaves the request body untouched and falls through.",
};
const STRATEGY_RECOMMENDATIONS_FALLBACK = {
  priority: {
    title: "Fail-safe baseline",
    description: "Use one primary model and keep fallback chain short and reliable.",
    tips: [
      "Put your most reliable model first.",
      "Keep 1-2 backup models with similar quality.",
      "Use safe retries to absorb transient provider failures.",
    ],
  },
  weighted: {
    title: "Controlled traffic split",
    description: "Great for canary rollouts and gradual migration between models.",
    tips: [
      "Start with conservative split like 90/10.",
      "Keep the total at 100% and auto-balance after changes.",
      "Monitor success and latency before increasing canary weight.",
    ],
  },
  "round-robin": {
    title: "Predictable load sharing",
    description: "Best when models are equivalent and you need smooth distribution.",
    tips: [
      "Use at least 2 models.",
      "Set concurrency limits to avoid burst overload.",
      "Use queue timeout to fail fast under saturation.",
    ],
  },
  "context-relay": {
    title: "Session continuity first",
    description:
      "Best when account rotation is expected and the next account must inherit a condensed task summary.",
    tips: [
      "Use with providers that rotate accounts for the same model family.",
      "Keep the handoff threshold below the hard quota cutoff to give the summary time to generate.",
      "Set a dedicated summary model only when the primary model is too expensive or unstable.",
    ],
  },
  random: {
    title: "Quick spread with low setup",
    description: "Use when you need simple distribution without strict guarantees.",
    tips: [
      "Use models with similar latency profiles.",
      "Keep retries enabled to absorb random misses.",
      "Prefer this for experimentation, not strict SLAs.",
    ],
  },
  "least-used": {
    title: "Adaptive balancing",
    description: "Routes to less-used models to reduce hotspots over time.",
    tips: [
      "Works better under continuous traffic.",
      "Combine with health checks for safer balancing.",
      "Track per-model usage to validate distribution gains.",
    ],
  },
  "cost-optimized": {
    title: "Budget-first routing",
    description: "Routes to lower-cost models when pricing metadata is available.",
    tips: [
      "Ensure pricing coverage for all selected models.",
      "Keep a quality fallback for hard prompts.",
      "Use for batch/background jobs where cost is the main KPI.",
    ],
  },
  "reset-aware": {
    title: "Reset-aware account rotation",
    description: "Balances remaining provider quota against reset timing.",
    tips: [
      "Use explicit account steps or account-tag routing for providers with quota telemetry.",
      "Tune session vs weekly weights when short-term exhaustion is more risky.",
      "Keep the tie band small so equivalent accounts still rotate fairly.",
    ],
  },
  "fill-first": {
    title: "Quota drain strategy",
    description: "Exhausts one provider's quota before moving to the next in chain.",
    tips: [
      "Order models by free quota size — biggest first.",
      "Enable health checks to skip drained providers.",
      "Ideal for free-tier stacking (Deepgram → Groq → NIM).",
    ],
  },
  p2c: {
    title: "Power-of-Two-Choices",
    description:
      "Picks the less-loaded of two random candidates per request — low latency at scale.",
    tips: [
      "Use with 4+ models for best effect.",
      "Requires latency telemetry enabled in Settings.",
      "Great replacement for round-robin in high-throughput combos.",
    ],
  },
  "strict-random": {
    title: "Shuffle deck distribution",
    description: "Each model is used exactly once per cycle before reshuffling.",
    tips: [
      "Use at least 2 models for meaningful distribution.",
      "Ideal for same-model accounts to evenly spread quota.",
      "Guarantees no model is skipped or repeated within a cycle.",
    ],
  },
  auto: {
    title: "Multi-factor optimization",
    description: "Routes based on real-time scoring of cost, latency, quality, and health.",
    tips: [
      "Let the engine balance across multiple factors automatically.",
      "Monitor which factors drive routing decisions in the logs.",
      "Use for complex workloads where no single factor dominates.",
    ],
  },
  lkgp: {
    title: "History-based routing",
    description: "Routes based on historical success rates and persistent performance data.",
    tips: [
      "Let success history accumulate before relying on this strategy.",
      "Models with better track records get preference over time.",
      "Ideal for stable workloads with consistent model availability.",
    ],
  },
  "context-optimized": {
    title: "Context-aware distribution",
    description: "Routes to optimize context window usage and conversation continuity.",
    tips: [
      "Best for long conversations that span multiple requests.",
      "Selects models with appropriate context capacity automatically.",
      "Use when context limits are a bottleneck for your workload.",
    ],
  },
  "quota-weighted": {
    title: "Quota-weighted account spread",
    description:
      "Drops exhausted accounts, keeps a 1% soft floor, then picks the first target in proportion to leftover divided by in-flight load. Existing conversations stay pinned.",
    tips: [
      "Keep session stickiness on (the default). New conversations spread by leftover and in-flight load; an existing conversation stays on its account until that account is empty, then rebinds.",
      "Needs per-account quota snapshots. Missing snapshots stay eligible but only at the reset-aware missing-quota score (0.5).",
      "The 1% floor is a last-resort pool. An empty A pool still serves B instead of returning 404.",
    ],
  },
};
function getStrategyMeta(strategy) {
  return STRATEGY_OPTIONS.find((s) => s.value === strategy) || STRATEGY_OPTIONS[0];
}

function getStrategyLabel(t, strategy) {
  const key = getStrategyMeta(strategy).labelKey;
  return getI18nOrFallback(t, key, STRATEGY_LABEL_FALLBACK[strategy] || strategy);
}

function getStrategyDescription(t, strategy) {
  const key = getStrategyMeta(strategy).descKey;
  return getI18nOrFallback(
    t,
    key,
    STRATEGY_DESC_FALLBACK[strategy] || STRATEGY_DESC_FALLBACK.priority || strategy
  );
}

function getStrategyBadgeClass(strategy) {
  if (strategy === "weighted") return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
  if (strategy === "round-robin") return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
  if (strategy === "context-relay")
    return "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400";
  if (strategy === "random") return "bg-purple-500/15 text-purple-600 dark:text-purple-400";
  if (strategy === "least-used") return "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400";
  if (strategy === "cost-optimized") return "bg-teal-500/15 text-teal-600 dark:text-teal-400";
  if (strategy === "reset-aware") return "bg-lime-500/15 text-lime-700 dark:text-lime-300";
  if (strategy === "fill-first") return "bg-orange-500/15 text-orange-600 dark:text-orange-400";
  if (strategy === "p2c") return "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400";
  return "bg-blue-500/15 text-blue-600 dark:text-blue-400";
}

function getI18nOrFallback(t, key, fallback, values = undefined) {
  try {
    if (typeof t.has === "function" && t.has(key)) return t(key, values);
  } catch {}
  return fallback;
}

/**
 * One pre-flight refusal, as the operator reads it.
 *
 * The rule→key mapping lives in the shared module as data (`COMBO_DRAFT_ISSUE_
 * MESSAGE_KEYS`) so a test can pin it; this is only the lookup, because the
 * translator itself is a React hook that node:test cannot mount.
 */
function describeComboDraftIssue(t, issue: ComboDraftIssue): string {
  const key = COMBO_DRAFT_ISSUE_MESSAGE_KEYS[issue.code];
  if (!key) {
    // An unmapped code is a bug in this file, not a user-facing case; showing
    // the code is louder than silently showing nothing.
    return String(issue.code);
  }
  const values = comboDraftIssueValues(issue);
  const fallback = AISIX_COMBO_DRAFT_ISSUE_FALLBACKS[issue.code];
  return getI18nOrFallback(t, key, fallback, Object.keys(values).length > 0 ? values : undefined);
}
function getStrategyGuideText(t, strategy, field) {
  const strategyFallback =
    STRATEGY_GUIDANCE_FALLBACK[strategy] || STRATEGY_GUIDANCE_FALLBACK.priority;
  const key = `strategyGuide.${strategy}.${field}`;
  return getI18nOrFallback(t, key, strategyFallback[field]);
}

function getStrategyRecommendationText(t, strategy, field) {
  const strategyFallback =
    STRATEGY_RECOMMENDATIONS_FALLBACK[strategy] || STRATEGY_RECOMMENDATIONS_FALLBACK.priority;

  if (field === "tips") {
    return strategyFallback.tips.map((tip, index) =>
      getI18nOrFallback(t, `strategyRecommendations.${strategy}.tip${index + 1}`, tip)
    );
  }

  return getI18nOrFallback(
    t,
    `strategyRecommendations.${strategy}.${field}`,
    strategyFallback[field]
  );
}
} from "@/shared/utils/aisixCombos";
