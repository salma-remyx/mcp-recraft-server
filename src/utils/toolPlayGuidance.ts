/**
 * Tool play guidance.
 *
 * Zero-shot tool-instruction refinement derived from recorded tool play:
 * each entry describes a (tool, params, outcome) trial produced while
 * exercising a tool, and the signal from those trials is folded back into
 * the descriptions the MCP client sees — no labeled data, no manual
 * rewriting of every description.
 *
 * The memory of play is per-process: trials are recorded on every tool
 * call (see the CallToolRequestSchema handler in src/index.ts) and the
 * ListToolsRequestSchema handler asks `withToolPlayHints` to fold the
 * accumulated signals into the tool descriptions it serves. Recraft API
 * errors are parsed for parameter-level causes so a hint names the exact
 * parameter that failed, the way a play-and-score pass in PLAY2PROMPT
 * isolates the instruction responsible for a failed trial.
 */

export type ToolPlayOutcome = "success" | "error"

export interface ToolPlayTrial {
  /** MCP tool name the trial was run against. */
  tool: string
  /** Parameter names the caller supplied, excluding defaults. */
  params: string[]
  outcome: ToolPlayOutcome
  /** Parameter-level cause extracted from a failed API call, if any. */
  failedParam?: string
}

export interface ToolPlayHint {
  /** Tool the hint applies to. */
  tool: string
  /** Instruction to append to that tool's description. */
  instruction: string
  /** Number of trials backing the hint. */
  trials: number
}

/** Parameter-level causes we can extract from Recraft API error text. */
const PARAM_CAUSES: Array<[RegExp, string]> = [
  [/style (?:and|or) substyle|mutually exclusive|both (?:style and style_id|styleId)/i, "style"],
  [/substyle/i, "substyle"],
  [/style_?id/i, "styleID"],
  [/\bstyle\b/i, "style"],
]

/**
 * Extract the parameter a Recraft API error blames, if the error text
 * names one. Returns undefined for network failures and other errors
 * that carry no parameter-level signal.
 */
export const paramCausedBy = (error: unknown): string | undefined => {
  let message: string
  if (error instanceof Error) {
    message = error.message
  } else if (Array.isArray(error)) {
    // A CallToolResult's content blocks, as surfaced by an isError result.
    message = error.map(item =>
      typeof item === "object" && item !== null && "text" in item ? String((item as { text: unknown }).text) : String(item)
    ).join("\n")
  } else {
    message = String(error)
  }
  for (const [pattern, param] of PARAM_CAUSES) {
    if (pattern.test(message)) {
      return param
    }
  }
  return undefined
}

/**
 * Map a play trial onto the guidance signals it supports. Successful
 * trials with parameters suggest a usage note for exactly those
 * parameters; failed trials suggest a warning naming the parameter the
 * API blamed.
 */
const playSignals = (trial: ToolPlayTrial): Array<[string, string]> => {
  if (trial.outcome === "error") {
    return trial.failedParam
      ? [[`warn:${trial.failedParam}`, trial.failedParam]]
      : []
  }
  if (trial.params.length === 0) {
    return []
  }
  return [["ok:" + trial.params.join(","), trial.params.join(", ")]]
}

const formatHint = (kind: "ok" | "warn", detail: string, trials: number): string => {
  const evidence = trials === 1 ? "1 recent call" : `${trials} recent calls`
  if (kind === "warn") {
    return `Known pitfall observed in ${evidence}: calls with \`${detail}\` failed against the API. Prefer omitting it unless the task requires it.`
  }
  return `Observed in ${evidence}: \`${detail}\` worked well together.`
}

/**
 * Refine raw tool descriptions with guidance derived from recorded play
 * trials. Returns the tools unmodified when there is nothing to report,
 * so servers that never record a trial serve the static descriptions.
 *
 * Mirrors PLAY2PROMPT's instruction-refinement output: per-tool
 * instruction deltas produced purely from tool play outcomes, no labeled
 * data. Unlike the paper there is no LLM instruction-rewriter — the
 * outcome-scored play memory is summarized into instruction templates
 * directly, which keeps the server self-contained.
 *
 * @param tools tools as declared by their modules
 * @param trials recorded play trials across all tools
 * @param maxHintsPerTool budget on hints per tool, keeping descriptions
 *   bounded instead of growing with every call
 */
export const withToolPlayHints = (
  tools: Array<{ name: string; description: string }>,
  trials: ToolPlayTrial[],
  maxHintsPerTool = 2,
): Array<{ name: string; description: string }> => {
  const signalsByTool = new Map<string, Map<string, { kind: "ok" | "warn"; detail: string; count: number }>>()
  for (const trial of trials) {
    for (const [key, detail] of playSignals(trial)) {
      const kind = key.startsWith("warn:") ? "warn" : "ok"
      const bySignal = signalsByTool.get(trial.tool) ?? new Map()
      const existing = bySignal.get(key)
      if (existing) {
        existing.count += 1
      } else {
        bySignal.set(key, { kind: kind, detail: detail, count: 1 })
      }
      signalsByTool.set(trial.tool, bySignal)
    }
  }

  return tools.map(tool => {
    const bySignal = signalsByTool.get(tool.name)
    if (!bySignal) {
      return tool
    }
    const hints = [...bySignal.values()]
      .sort((a, b) => (b.kind === "warn" ? 1 : 0) - (a.kind === "warn" ? 1 : 0) || b.count - a.count)
      .slice(0, maxHintsPerTool)
      .map(signal => formatHint(signal.kind, signal.detail, signal.count))
    if (hints.length === 0) {
      return tool
    }
    return { ...tool, description: `${tool.description}\nTool play notes: ${hints.join(" ")}` }
  })
}

/**
 * Process-local memory of tool play trials. Handlers record one trial
 * per tool call; the tools/list handler reads `trials` to refine
 * descriptions. Bounded so a long-lived server keeps only the most
 * recent trials.
 */
export class ToolPlayMemory {
  private readonly maxTrials: number
  private readonly recorded: ToolPlayTrial[] = []

  constructor(maxTrials = 50) {
    this.maxTrials = maxTrials
  }

  record = (trial: ToolPlayTrial): void => {
    this.recorded.push(trial)
    if (this.recorded.length > this.maxTrials) {
      this.recorded.splice(0, this.recorded.length - this.maxTrials)
    }
  }

  get trials(): ToolPlayTrial[] {
    return this.recorded
  }
}
