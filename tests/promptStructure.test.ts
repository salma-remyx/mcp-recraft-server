import { test } from "node:test"
import assert from "node:assert/strict"

// Import from a NON-NEW module: the prompt-guidance call site that was edited
// to wire in the structured-prompt guidance. Proves the integration landed.
import { PARAMETERS } from "../src/utils/parameters"
// Import the new capability module.
import {
  scorePromptStructure,
  isWellStructured,
  missingAxes,
  STRUCTURED_PROMPT_GUIDANCE,
} from "../src/utils/promptStructure"

test("promptSimple description carries the structured-prompt guidance (wiring)", () => {
  const description: string = PARAMETERS.promptSimple.description
  // The guidance export is appended to the existing description verbatim.
  assert.ok(description.includes(STRUCTURED_PROMPT_GUIDANCE))
  // The original guidance is still present alongside the new addition.
  assert.ok(description.includes("1 to 1024 characters"))
})

test("structured prompt scores higher than a bare prompt on both axes", () => {
  const bare = scorePromptStructure("a cat")
  const structured = scorePromptStructure(
    "a close-up portrait of two cats, warm golden hour light, soft pastel tones, centered composition",
  )
  assert.equal(bare.total, 0)
  assert.ok(structured.semantic >= 2, `semantic=${structured.semantic}`)
  assert.ok(structured.geometric >= 1, `geometric=${structured.geometric}`)
  assert.ok(structured.total > bare.total)
})

test("isWellStructured requires both semantic and geometric richness", () => {
  assert.equal(isWellStructured("a cat"), false)
  // Semantically rich but no geometric cues is still not well-structured.
  assert.equal(isWellStructured("warm soft moody watercolor"), false)
  assert.equal(
    isWellStructured("two cats, warm golden hour, soft watercolor, centered close-up portrait"),
    true,
  )
})

test("missingAxes reports the annotation family a prompt lacks", () => {
  assert.deepEqual(missingAxes("a cat"), ["semantic", "geometric"])
  assert.deepEqual(missingAxes("warm soft moody watercolor"), ["geometric"])
  assert.deepEqual(missingAxes("two cats, warm golden hour, centered close-up"), [])
})
