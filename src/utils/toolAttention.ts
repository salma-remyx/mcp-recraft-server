/**
 * Tool Attention — reduce the "MCP/Tools Tax".
 *
 * The Tax is the per-turn token cost of eagerly injecting every tool's full
 * JSON schema into the model context. For this server the eager payload is the
 * `tools/list` response: nine tools, each carrying a verbose `description` and
 * a property-level `inputSchema` (the `substyle` enum alone is ~600 tokens).
 *
 * Adapted from "Tool Attention Is All You Need: Dynamic Tool Gating and Lazy
 * Schema Loading for Eliminating the MCP/Tools Tax in Scalable Agentic
 * Workflows" (arXiv:2604.21816v1). This is a Mode 2 (adapted) port: the paper's
 * three-part mechanism is kept at full fidelity, while its learned summary /
 * relevance estimator is replaced by a parameter-free proxy that runs entirely
 * server-side with no model calls:
 *
 *   1. Per-tool summary      — a compact, deterministic one-line view of a tool.
 *   2. Intent-Schema-Overlap — a vocab-overlap gate ranking tools by relevance
 *                              to a user intent (proxy for the learned gate).
 *   3. Lazy schema loading   — phase 1 returns the summarized tool list (cheap);
 *                              phase 2 returns a tool's full schema on demand via
 *                              the `get_tool_schema` tool, so the model only pays
 *                              the full schema cost for the tool it actually uses.
 *
 * Gating is opt-in via RECRAFT_TOOL_ATTENTION=1; with it unset, the server
 * behaves exactly as before (full schemas in tools/list).
 */

/** Minimal view of a tool definition this server actually produces. */
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: string
    properties?: Record<string, unknown>
    required?: string[]
    [key: string]: unknown
  }
}

/** Phase-1 view of a tool: what stays in context when the Tax is being paid. */
export interface ToolSummary {
  name: string
  summary: string
  requiredParams: string[]
}

// Common English stopwords filtered out of the overlap gate so that generic
// words ("image", "use", "the") do not dominate the relevance score.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "for", "to", "of", "in", "on", "at",
  "by", "with", "from", "as", "is", "are", "be", "this", "that", "it", "you",
  "your", "i", "want", "need", "use", "using", "used", "image", "images",
  "please", "can", "will", "if", "then", "into", "set", "new", "make",
])

/** Lowercased, stopword-free alnum word tokens — the gate's vocabulary unit. */
export const tokenize = (text: string): string[] => {
  if (!text) return []
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
}

/** First declarative chunk of a description — the deterministic "summary". */
export const summarizeTool = (tool: ToolDefinition): ToolSummary => {
  const description = (tool.description ?? "").trim()
  // Take the first sentence / first line, whichever ends sooner: that is the
  // tool's purpose, and the rest is parameter guidance (loaded on demand).
  const firstLine = description.split("\n")[0] ?? ""
  const firstSentence = firstLine.split(/\.(?=\s|$)/)[0] ?? ""
  const summary = (firstSentence || tool.name).trim()
  const requiredParams = Array.isArray(tool.inputSchema?.required)
    ? [...tool.inputSchema.required]
    : []
  return { name: tool.name, summary, requiredParams }
}

/**
 * Phase-1 tool-list entry: a short description that names the parameters
 * (cheap) while eliding their descriptions and enums (the expensive part).
 * `properties` is empty so the entry stays a valid (if minimal) JSON Schema,
 * with the parameter surface carried in the description text instead.
 */
export const summarizeToolEntry = (tool: ToolDefinition): {
  name: string
  description: string
  inputSchema: { type: "object"; properties: Record<string, unknown> }
} => {
  const { summary, requiredParams } = summarizeTool(tool)
  const paramNames = Object.keys(tool.inputSchema?.properties ?? {})
  const hints = [
    paramNames.length ? `params: ${paramNames.join(", ")}` : "",
    requiredParams.length ? `required: ${requiredParams.join(", ")}` : "",
  ].filter(Boolean).join("; ")
  const description = hints
    ? `${summary} (${hints}). Call get_tool_schema for full parameter details.`
    : summary
  // MCP tool schemas require `type: "object"`; property-level schemas are
  // intentionally elided here and returned on demand by get_tool_schema.
  return {
    name: tool.name,
    description,
    inputSchema: { type: "object", properties: {} },
  }
}

/**
 * Intent-Schema-Overlap gate score in [0, 1] — the Jaccard similarity between
 * the intent's tokens and the tool's signature tokens (name + description +
 * parameter names). Higher means more relevant. Zero means no overlap.
 */
export const intentSchemaOverlap = (intent: string, tool: ToolDefinition): number => {
  const intentTokens = new Set(tokenize(intent))
  if (intentTokens.size === 0) return 0
  const toolTokens = new Set([
    ...tokenize(tool.name),
    ...tokenize(tool.description ?? ""),
    ...tokenize(Object.keys(tool.inputSchema?.properties ?? {}).join(" ")),
  ])
  if (toolTokens.size === 0) return 0
  let intersection = 0
  for (const token of intentTokens) {
    if (toolTokens.has(token)) intersection += 1
  }
  return intersection / (intentTokens.size + toolTokens.size - intersection)
}

/**
 * Gate: rank tools by relevance to an intent, most relevant first, dropping
 * tools with no token overlap. When `topK` is given, return only the top-K.
 */
export const gateTools = (
  intent: string,
  tools: ToolDefinition[],
  topK?: number,
): ToolDefinition[] => {
  const ranked = tools
    .map((tool) => ({ tool, score: intentSchemaOverlap(intent, tool) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name),
    )
    .map((entry) => entry.tool)
  return typeof topK === "number" ? ranked.slice(0, topK) : ranked
}

/** Look up the full definition of a tool by name (phase-2 source of truth). */
export const fullSchemaFor = (
  tools: ToolDefinition[],
  name: string,
): ToolDefinition | undefined => tools.find((tool) => tool.name === name)

/**
 * The phase-2 on-demand tool, appended to the summarized tools/list so the model
 * can pull a single tool's full schema only when it has decided to use it.
 */
export const getToolSchemaTool = {
  name: "get_tool_schema",
  description:
    "Return the full input schema (every parameter with its type, enum, and " +
    "description) for a single Recraft tool. Call this once you have chosen a " +
    "tool from the summarized list and need its complete parameter details " +
    "before invoking it.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: {
        type: "string",
        description:
          "Name of the tool to load the full schema for, exactly as listed in tools/list.",
      },
    },
    required: ["tool_name"],
  },
}

/** Phase-2 handler: returns the full schema of the requested tool, or an error. */
export const getToolSchemaHandler = (
  tools: ToolDefinition[],
  args: Record<string, unknown>,
) => {
  const name = String(args?.tool_name ?? "").trim()
  const tool = fullSchemaFor(tools, name)
  if (!tool) {
    return {
      content: [
        { type: "text" as const, text: `Unknown tool name: ${name || "(empty)"}` },
      ],
      isError: true,
    }
  }
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          },
          null,
          2,
        ),
      },
    ],
    isError: false,
  }
}

/** Opt-in flag for the lazy-schema tools/list behavior. */
export const isToolAttentionEnabled = (): boolean =>
  process.env.RECRAFT_TOOL_ATTENTION === "1" ||
  process.env.RECRAFT_TOOL_ATTENTION === "true"

/**
 * Rough token estimate (chars/4 heuristic) for a tool payload — used to
 * quantify how much of the Tools Tax a summarized list defers to phase 2.
 */
export const estimateTokens = (tools: ToolDefinition[]): number =>
  Math.ceil(
    tools.reduce((total, tool) => total + JSON.stringify(tool).length, 0) / 4,
  )
