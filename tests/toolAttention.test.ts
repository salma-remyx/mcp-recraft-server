import { test } from "node:test"
import assert from "node:assert/strict"

// Import the (non-new) call-site module to exercise the wiring end to end.
import { buildListToolsResponse } from "../src/index"
// Real tool definitions from existing (non-new) modules.
import { generateImageTool } from "../src/tools/GenerateImage"
import { removeBackgroundTool } from "../src/tools/RemoveBackground"
import { getUserTool } from "../src/tools/GetUser"
// Helpers + the shared type from the new capability module.
import {
  gateTools,
  getToolSchemaHandler,
  intentSchemaOverlap,
  summarizeToolEntry,
  type ToolDefinition,
} from "../src/utils/toolAttention"

const realTools: ToolDefinition[] = [generateImageTool, removeBackgroundTool, getUserTool]

const withFlag = async <T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> => {
  const previous = process.env.RECRAFT_TOOL_ATTENTION
  if (value === undefined) {
    delete process.env.RECRAFT_TOOL_ATTENTION
  } else {
    process.env.RECRAFT_TOOL_ATTENTION = value
  }
  try {
    return await fn()
  } finally {
    if (previous === undefined) {
      delete process.env.RECRAFT_TOOL_ATTENTION
    } else {
      process.env.RECRAFT_TOOL_ATTENTION = previous
    }
  }
}

test("tools/list is unchanged when Tool Attention is disabled", async () => {
  await withFlag(undefined, () => {
    const { tools } = buildListToolsResponse()
    // Full, verbose description is present and no lazy-loader tool is exposed.
    assert.ok(tools.some((t) => t.name === "generate_image"))
    assert.equal(tools.find((t) => t.name === "get_tool_schema"), undefined)
    const generate = tools.find((t) => t.name === "generate_image")
    assert.equal(generate?.description, generateImageTool.description)
  })
})

test("tools/list returns summaries + get_tool_schema when enabled (phase 1)", async () => {
  await withFlag("1", () => {
    const { tools } = buildListToolsResponse()
    assert.ok(tools.some((t) => t.name === "get_tool_schema"))
    const generate = tools.find((t) => t.name === "generate_image")
    // Summary is strictly shorter than the full description (the Tax deferred).
    assert.ok(generate.description.length < generateImageTool.description.length)
    // Parameter-level schema is elided; the model fetches it on demand.
    assert.deepEqual(generate.inputSchema.properties, {})
    assert.match(generate.description, /get_tool_schema/)
  })
})

test("get_tool_schema restores the full schema for a named tool (phase 2)", async () => {
  const ok = getToolSchemaHandler(realTools, { tool_name: "generate_image" })
  assert.equal(ok.isError, false)
  assert.match(ok.content[0].text, new RegExp(generateImageTool.description.slice(0, 20)))
  // The expensive substyle enum is back, proving the full schema was restored.
  assert.match(ok.content[0].text, /substyle|subStyle/)

  const missing = getToolSchemaHandler(realTools, { tool_name: "no_such_tool" })
  assert.equal(missing.isError, true)
})

test("intent-schema-overlap gate ranks the relevant tool first", () => {
  const intent = "please remove the background from this photo"
  // The background tool overlaps more with the intent than the text-to-image tool.
  assert.ok(intentSchemaOverlap(intent, removeBackgroundTool) > intentSchemaOverlap(intent, generateImageTool))
  const ranked = gateTools(intent, realTools)
  assert.equal(ranked[0].name, "remove_background")
  // Tools with no token overlap are dropped.
  assert.ok(!ranked.some((t) => t.name === "get_user"))
})

test("summarizeToolEntry emits a valid object-typed schema", () => {
  const entry = summarizeToolEntry(generateImageTool)
  assert.equal(entry.inputSchema.type, "object")
  assert.deepEqual(entry.inputSchema.properties, {})
})
