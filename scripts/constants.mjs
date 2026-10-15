export const MODULE_ID = "claude-gm-lite";

export const MODELS = {
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-haiku-5-5": "Claude Haiku 5.5"
};



export const EFFORTS = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

/** Server-side refusal fallback ("default" form) — Claude API only, not offered for Haiku 5.5. */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const MODELS_WITH_FALLBACK = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

export const MAX_STEPS = 25;

/** Per-request overrides: /claude! (strong) and /ia (quick). cli = `claude --model` alias, api = model id. */
export const SHORTCUTS = {
  normal: {},
  strong: { cli: "opus", api: "claude-opus-5-5", effort: "high" },
  quick: { cli: "haiku", api: "claude-haiku-5-5", effort: "low" },
  // Player requests that need real reasoning (level-up choices).
  playerDeep: { cli: "sonnet", api: "claude-sonnet-5-5", effort: "medium" }
};
