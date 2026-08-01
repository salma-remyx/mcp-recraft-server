import { describe, it } from "node:test"
import assert from "node:assert/strict"

// Imports from NON-NEW modules — proves the auditor grounds its findings on
// the server's real description strings rather than synthetic fixtures.
import { PARAMETERS } from "./parameters"
import { imageToImageTool } from "../tools/ImageToImage"

import {
  analyzeDescription,
  auditToolDescriptions,
  compactDescription,
  estimateTokens,
  INSTRUCTION_HEAVY_THRESHOLD,
  TOKEN_HEAVY_THRESHOLD,
} from "./descriptionBudget"

describe("descriptionBudget — prompt-design audit (adapted from arxiv:2607.19257)", () => {
  it("flags the real substyle enumeration as an instruction/token overload hotspot", () => {
    const budget = analyzeDescription(PARAMETERS.imageSubStyle.description)

    // Instruction-count lever: the paper shows instruction adherence collapses
    // as the number of simultaneous rules grows. The substyle description is a
    // textbook overload case (many directive + enumeration lines).
    assert.ok(
      budget.instructionCount >= INSTRUCTION_HEAVY_THRESHOLD,
      `expected >= ${INSTRUCTION_HEAVY_THRESHOLD} directive lines, got ${budget.instructionCount}`,
    )

    // Context-length lever: one parameter field carrying heavy token pressure.
    assert.ok(
      budget.tokenEstimate >= TOKEN_HEAVY_THRESHOLD,
      `expected >= ${TOKEN_HEAVY_THRESHOLD} estimated tokens, got ${budget.tokenEstimate}`,
    )
  })

  it("does not flag a compact, single-purpose description", () => {
    const budget = analyzeDescription(PARAMETERS.numberOfImages.description)
    assert.ok(
      budget.instructionCount < INSTRUCTION_HEAVY_THRESHOLD,
      `expected < ${INSTRUCTION_HEAVY_THRESHOLD} directive lines, got ${budget.instructionCount}`,
    )
    assert.ok(
      budget.tokenEstimate < TOKEN_HEAVY_THRESHOLD,
      `expected < ${TOKEN_HEAVY_THRESHOLD} estimated tokens, got ${budget.tokenEstimate}`,
    )
  })

  it("compactDescription is lossless and does not increase token cost", () => {
    const original = PARAMETERS.imageSubStyle.description
    const compacted = compactDescription(original)

    // Lossless: enumerated substyle tokens are preserved verbatim.
    assert.ok(compacted.includes("pixel_art"))
    assert.ok(compacted.includes("b_and_w"))
    assert.ok(compacted.includes("realistic_image"))

    // Format lever: structural overhead removed — the paper found no adherence
    // benefit to markdown list markers, only token cost.
    assert.ok(
      estimateTokens(compacted) <= estimateTokens(original),
      "compaction must not increase the token estimate",
    )
  })

  it("auditToolDescriptions flags the substyle field end-to-end on a real tool", () => {
    const { flags, tools } = auditToolDescriptions([imageToImageTool], { log: false })

    const substyleFlag = flags.find((flag) => flag.param === "substyle")
    assert.ok(substyleFlag, "expected a budget flag for the substyle parameter")
    assert.ok(substyleFlag!.reasons.length > 0)

    // Non-normalizing path is non-mutating: the same tool objects come back.
    assert.strictEqual(tools[0], imageToImageTool)
  })

  it("normalize returns losslessly-compacted descriptions that preserve enum tokens", () => {
    // The tool's substyle description appends a style-preservation warning to
    // the shared PARAMETERS text, so compare compaction against the tool's own
    // original field — not the bare PARAMETERS string.
    const originalSubDescription = imageToImageTool.inputSchema.properties.substyle.description
    const { tools } = auditToolDescriptions([imageToImageTool], {
      normalize: true,
      log: false,
    })
    const compactedDescription = tools[0].inputSchema.properties.substyle.description

    assert.ok(compactedDescription.includes("pixel_art"))
    assert.ok(
      estimateTokens(compactedDescription) <= estimateTokens(originalSubDescription),
      "compaction must not increase the token estimate",
    )
  })
})
