/**
 * Structured-language richness scoring and prompt guidance for Recraft prompts.
 *
 * Adapted (Mode 2) from "Scaling Properties of Text Conditioning in Visual
 * Generation" (arxiv:2607.29679v1). That paper shows that converged diffusion
 * loss scales with the amount of *structured language* in a prompt, quantified
 * by two complementary measures: a white-box likelihood metric (GPG) and a
 * black-box attribute metric (ED). It also shows that prompts built from
 * semantic and geometric annotations are more "diffusable" — they yield higher
 * generation fidelity.
 *
 * This repo is an MCP server with no diffusion-training surface, so the learned
 * / likelihood-based components cannot be hosted here. The substitutions are:
 *
 *   - The white-box GPG likelihood metric (needs diffusion-model internals) is
 *     replaced by a parameter-free proxy: the count of SEMANTIC annotation cues
 *     (subject, color, lighting, mood, medium, texture) in the prompt.
 *   - The black-box ED attribute metric (needs an attribute extractor) is
 *     replaced by a parameter-free proxy: the count of GEOMETRIC annotation
 *     cues (composition, camera angle, layout, position, count) in the prompt.
 *   - The trained prompter (SFT + cold-start + verifier-gated on-policy
 *     distillation) is replaced by guidance surfaced to the LLM via the prompt
 *     parameter description (`STRUCTURED_PROMPT_GUIDANCE`) — the LLM is the
 *     de-facto prompter.
 *
 * What is kept at fidelity is the core mechanism: two complementary measures of
 * structured-language richness (semantic + geometric) and the actionable result
 * that more of it improves generation fidelity. `scorePromptStructure` exposes
 * the proxy signal the team's prompt-engineering work can score against.
 */

/** Semantic annotation cues — parameter-free proxy for the paper's GPG metric. */
export const SEMANTIC_CUES = [
  // color
  "red", "blue", "green", "yellow", "orange", "purple", "pink", "black",
  "white", "gray", "grey", "brown", "cyan", "magenta", "teal", "gold", "silver",
  "crimson", "turquoise", "pastel", "neon", "monochrome", "vibrant", "vivid",
  // lighting / mood
  "soft", "hard", "dramatic", "natural light", "warm", "cool", "golden hour",
  "backlight", "rim light", "studio light", "candlelight", "moody", "serene",
  "gloomy", "cheerful", "melancholic", "ethereal", "cozy",
  // medium / material
  "watercolor", "oil", "acrylic", "pencil", "ink", "charcoal", "digital",
  "render", "photograph", "photo", "film", "anime", "cartoon", "pixel", "voxel",
  "paper", "canvas", "wood", "metal", "glass", "fabric",
  // quality / texture
  "detailed", "intricate", "hyperrealistic", "minimalist", "ornate", "textured",
  "smooth", "glossy", "matte", "weathered",
] as const

/** Geometric / spatial annotation cues — parameter-free proxy for ED. */
export const GEOMETRIC_CUES = [
  // position
  "left", "right", "center", "centered", "top", "bottom", "upper", "lower",
  "foreground", "background", "beside", "behind", "above", "below", "between",
  "inside", "outside",
  // composition / camera
  "portrait", "landscape", "close-up", "wide shot", "full body", "overhead",
  "birds eye", "worms eye", "macro", "panorama", "symmetrical", "asymmetric",
  "diagonal", "horizontal", "vertical",
  // count
  "two", "three", "four", "five", "six", "several", "many", "pair", "trio",
  "group", "cluster", "row", "circle", "grid",
  // scale / orientation
  "large", "small", "tiny", "huge", "towering", "miniature", "facing",
  "turned", "angled", "tilted",
] as const

export interface PromptStructureScore {
  /** Number of semantic annotation cues found (GPG proxy). */
  readonly semantic: number
  /** Number of geometric annotation cues found (ED proxy). */
  readonly geometric: number
  /** Combined structured-language richness (semantic + geometric). */
  readonly total: number
  /** Raw prompt length in characters — the non-scaling baseline from the paper. */
  readonly promptLength: number
}

export interface StructureThresholds {
  readonly minSemantic: number
  readonly minGeometric: number
}

export const DEFAULT_THRESHOLDS: StructureThresholds = {
  minSemantic: 2,
  minGeometric: 1,
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function countCues(prompt: string, cues: readonly string[]): number {
  let count = 0
  for (const cue of cues) {
    const pattern = new RegExp(`\\b${escapeRegExp(cue)}\\b`, "gi")
    const matches = prompt.match(pattern)
    if (matches !== null) {
      count += matches.length
    }
  }
  return count
}

/**
 * Score a prompt's structured-language richness along the paper's two
 * complementary axes. Higher totals indicate more "diffusable" prompts.
 */
export function scorePromptStructure(prompt: string): PromptStructureScore {
  const text = prompt ?? ""
  const semantic = countCues(text, SEMANTIC_CUES)
  const geometric = countCues(text, GEOMETRIC_CUES)
  return {
    semantic,
    geometric,
    total: semantic + geometric,
    promptLength: text.length,
  }
}

/**
 * Whether a prompt carries enough structured language on both axes to be
 * considered well-structured, per the paper's emphasis that semantic AND
 * geometric annotations both matter.
 */
export function isWellStructured(
  prompt: string,
  thresholds: StructureThresholds = DEFAULT_THRESHOLDS,
): boolean {
  const score = scorePromptStructure(prompt)
  return score.semantic >= thresholds.minSemantic && score.geometric >= thresholds.minGeometric
}

/**
 * Which structured-language axes a prompt is missing. Supports the paper's
 * actionable result — "construct structured prompts with semantic and geometric
 * annotations" — by telling the prompter what to add without fabricating content.
 */
export function missingAxes(
  prompt: string,
  thresholds: StructureThresholds = DEFAULT_THRESHOLDS,
): ReadonlyArray<"semantic" | "geometric"> {
  const score = scorePromptStructure(prompt)
  const missing: Array<"semantic" | "geometric"> = []
  if (score.semantic < thresholds.minSemantic) {
    missing.push("semantic")
  }
  if (score.geometric < thresholds.minGeometric) {
    missing.push("geometric")
  }
  return missing
}

/**
 * Guidance surfaced to the LLM prompter via the `promptSimple` parameter
 * description. This is the target-native stand-in for the paper's trained
 * prompter: it steers the model that already constructs the prompt toward the
 * semantic + geometric annotation structure that scales generation fidelity.
 */
export const STRUCTURED_PROMPT_GUIDANCE =
  "For higher-fidelity results, prefer a structured prompt that combines " +
  "semantic annotations (subject, colors, lighting, mood, medium, texture) " +
  "with geometric annotations (composition, camera angle, layout, position, " +
  "count). Prompts richer in both annotation types tend to generate more " +
  "faithfully."
