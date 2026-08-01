/**
 * Prompt-design budget auditor for MCP tool descriptions.
 *
 * Adapted from "Prompt Design at Scale: How Format, Instruction Count, and
 * Context Length Shape Instruction Adherence and Hallucination in Large
 * Language Models" (arxiv:2607.19257). That paper measures three prompt-design
 * levers across five models on a contamination-free corpus:
 *
 *   1. Instruction count — perfect-response rate collapses to zero as the
 *      number of simultaneous rules carried by a prompt grows.
 *   2. Context length — recall stays near ceiling through 64–128k tokens, then
 *      degrades sharply near each model's context ceiling.
 *   3. Format — non-plain-text formats (markdown, prose, tabular) carry +22%
 *      to +37% token overhead over plain text with NO reliable adherence
 *      benefit; one 35B model even favored plain text.
 *
 * The paper's *method* is a controlled benchmark harness (VeyraBench) that an
 * MCP image server cannot host, so this module is a target-native adaptation
 * of the paper's *findings* (Mode 2 — adapted port): the learned estimators
 * and benchmark suite are replaced by transparent, parameter-free heuristics,
 * while the three measured signals are preserved as cheap proxies that run
 * over the server's own tool-description strings. The point is to surface the
 * instruction / token / format hot-spots a maintainer should consider trimming
 * — e.g. the multi-hundred-word substyle enumeration, which is exactly the
 * instruction-overload shape the paper warns degrades adherence.
 */

/** Minimal structural view of an MCP tool definition. Kept local so the
 * auditor has no hard dependency on the SDK type and stays unit-testable. */
export interface AuditableTool {
  name: string
  description: string
  inputSchema?: {
    properties?: Record<string, unknown>
  }
}

export interface DescriptionBudget {
  /** Directive / enumeration lines — proxy for the paper's instruction-count N. */
  instructionCount: number
  /** Rough token cost — proxy for the paper's context-length pressure. */
  tokenEstimate: number
  /** Estimated structural-token overhead of the current formatting vs plain text. */
  formatOverheadRatio: number
}

export interface BudgetFlag {
  tool: string
  /** Parameter name, or "" for the tool-level description. */
  param: string
  budget: DescriptionBudget
  reasons: string[]
}

export interface AuditOptions {
  /** Apply lossless compaction to the returned descriptions. Default false. */
  normalize?: boolean
  /** Force log flagged fields to stderr. Default: defer to RECRAFT_PROMPT_BUDGET_DEBUG. */
  log?: boolean
}

export interface AuditResult<T extends AuditableTool = AuditableTool> {
  tools: T[]
  flags: BudgetFlag[]
}

/**
 * A single description is "instruction-heavy" once it carries at least this
 * many directive / enumeration lines. The paper shows compliance degrades
 * monotonically with rule count; this is a conservative per-field tripwire,
 * not the paper's N≈80 collapse point (which is for an entire system prompt).
 */
export const INSTRUCTION_HEAVY_THRESHOLD = 6

/**
 * A single description becomes a token-pressure point above this rough token
 * estimate. Tool descriptions compete for the model's attention with the rest
 * of the conversation, so this is a conservative per-field budget rather than
 * the paper's whole-context ceilings (64–128k).
 */
export const TOKEN_HEAVY_THRESHOLD = 120

/**
 * Formatting is considered wasteful above this overhead ratio. The paper's
 * lower bound for non-plain formats was +22%; 10% flags anything that carries
 * real structural overhead while staying well inside the paper's range.
 */
export const FORMAT_OVERHEAD_THRESHOLD = 0.1

const DIRECTIVE_LINE = /^\s*(?:[-*+•]|\d+[.)])\s/
const DIRECTIVE_CUE =
  /\b(?:should|must|can(?:not|'t)?|need to|do not|don't|note that|if you|default is|defaults to|mutually exclusive|available only|will fail|recommended|ensure|avoid|cannot)\b/i

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function isDirectiveLine(line: string): boolean {
  return DIRECTIVE_LINE.test(line) || DIRECTIVE_CUE.test(line)
}

/**
 * Rough token estimate. ~1.3 tokens per whitespace-delimited word is a common
 * rule of thumb for mixed technical prose; structural punctuation (snake_case,
 * paths, colons) tokenizes finer, so each occurrence is counted once.
 */
export function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  const structuralPunct = (text.match(/[_/\\:]/g) || []).length
  return Math.ceil(words * 1.3) + structuralPunct
}

/** Measurement-only: collapse markdown structure to plain text for an overhead
 * ratio. Aggressive by design — never used to produce output text. */
function measurePlainTokens(text: string): number {
  const plain = text
    .replace(/^[\t ]*(?:[-*+•]|\d+[.)]|#{1,6})[\t ]+/gm, "")
    .replace(/[*_`>#|-]/g, " ")
  return estimateTokens(plain)
}

export function analyzeDescription(text: string): DescriptionBudget {
  const lines = splitLines(text)
  const instructionCount = lines.filter(isDirectiveLine).length
  const tokenEstimate = estimateTokens(text)
  const plainTokens = measurePlainTokens(text)
  const formatOverheadRatio = plainTokens > 0 ? tokenEstimate / plainTokens - 1 : 0
  return { instructionCount, tokenEstimate, formatOverheadRatio }
}

/**
 * Losslessly compact a description's formatting: drop redundant markdown list
 * markers and collapse blank runs. Words, enumeration tokens (e.g. snake_case
 * substyle names) and all semantic content are preserved — only the structural
 * overhead the paper found carries no adherence benefit is removed.
 */
export function compactDescription(text: string): string {
  return text
    .replace(/^(\s*)[-*+•]\s+/gm, "$1")
    .replace(/^(\s*)\d+[.)]\s+/gm, "$1")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

interface AnalyzedField {
  param: string
  budget: DescriptionBudget
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function analyzeTool(tool: AuditableTool): AnalyzedField[] {
  const fields: AnalyzedField[] = []
  if (tool.description) {
    fields.push({ param: "", budget: analyzeDescription(tool.description) })
  }
  const props = tool.inputSchema?.properties
  if (isPlainObject(props)) {
    for (const [name, schema] of Object.entries(props)) {
      if (
        isPlainObject(schema) &&
        typeof schema.description === "string" &&
        schema.description.length > 0
      ) {
        fields.push({ param: name, budget: analyzeDescription(schema.description) })
      }
    }
  }
  return fields
}

function flagField(tool: string, field: AnalyzedField): BudgetFlag | null {
  const reasons: string[] = []
  const { instructionCount, tokenEstimate, formatOverheadRatio } = field.budget
  if (instructionCount >= INSTRUCTION_HEAVY_THRESHOLD) {
    reasons.push(
      `${instructionCount} directive lines (compliance degrades as instruction count grows)`,
    )
  }
  if (tokenEstimate >= TOKEN_HEAVY_THRESHOLD) {
    reasons.push(`~${tokenEstimate} tokens of context pressure for one field`)
  }
  if (formatOverheadRatio >= FORMAT_OVERHEAD_THRESHOLD) {
    reasons.push(
      `~${Math.round(formatOverheadRatio * 100)}% structural format overhead (no adherence benefit)`,
    )
  }
  if (reasons.length === 0) return null
  return { tool, param: field.param, budget: field.budget, reasons }
}

function compactTool<T extends AuditableTool>(tool: T): T {
  const description = compactDescription(tool.description)
  const props = tool.inputSchema?.properties
  if (!isPlainObject(props)) {
    return { ...tool, description } as T
  }
  const properties: Record<string, unknown> = {}
  for (const [name, schema] of Object.entries(props)) {
    if (isPlainObject(schema) && typeof schema.description === "string") {
      properties[name] = {
        ...schema,
        description: compactDescription(schema.description),
      }
    } else {
      properties[name] = schema
    }
  }
  return { ...tool, description, inputSchema: { ...tool.inputSchema, properties } } as T
}

/**
 * Audit an array of MCP tool definitions for prompt-design budget hot-spots.
 * Non-mutating by default: it returns the same tool array plus the flags it
 * found. With `normalize: true` it returns losslessly-compacted copies (only
 * description strings change) so the server can hand leaner descriptions to the
 * model — the format choice the paper found carries no adherence benefit.
 *
 * Logging is opt-in via `log: true` or the `RECRAFT_PROMPT_BUDGET_DEBUG=1` env
 * var (off by default to avoid spamming chatty ListTools callers).
 */
export function auditToolDescriptions<T extends AuditableTool>(
  tools: T[],
  options: AuditOptions = {},
): AuditResult<T> {
  const normalize = options.normalize === true
  const flags: BudgetFlag[] = []
  for (const tool of tools) {
    for (const field of analyzeTool(tool)) {
      const flag = flagField(tool.name, field)
      if (flag) flags.push(flag)
    }
  }

  const envDebug = process.env.RECRAFT_PROMPT_BUDGET_DEBUG === "1"
  if ((options.log === true || (options.log === undefined && envDebug)) && flags.length > 0) {
    for (const flag of flags) {
      const where = flag.param ? `${flag.tool}.${flag.param}` : flag.tool
      console.error(`[prompt-budget] ${where}: ${flag.reasons.join("; ")}`)
    }
  }

  const result = normalize ? tools.map(compactTool) : tools
  return { tools: result, flags }
}
