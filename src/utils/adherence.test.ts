import { strict as assert } from "assert"
import { unlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { fileURLToPath } from "url"
import { imageToImageHandler } from "../tools/ImageToImage"
import { RecraftServer } from "../RecraftServer"
import { assessImageToImagePrompt, extractSceneGraph, isAdherenceFeedbackEnabled } from "./adherence"

// Minimal 1x1 PNG, so downloadImage and the sharp-based preview path run for real.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

const withTempImage = (run: (imageURI: string) => Promise<void>) => {
  const filePath = path.join(tmpdir(), `adherence-test-${process.pid}.png`)
  writeFileSync(filePath, Buffer.from(TINY_PNG_BASE64, "base64"))
  return run(`file://${filePath}`).finally(() => unlinkSync(filePath))
}

const pngUrl = (data: string) => `data:image/png;base64,${data}`

const stubServer = (resultData: Array<{ url?: string; b64Json?: string }>): RecraftServer => {
  const server = new RecraftServer({} as never, undefined)
  ;(server as unknown as { api: unknown }).api = {
    imageApi: {
      imageToImage: async () => ({ data: resultData }),
    },
  }
  return server
}

const resultText = async (server: RecraftServer, args: Record<string, unknown>) => {
  const result = await imageToImageHandler(server, args)
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n")
}

const main = async () => {
  // extractSceneGraph: DSG-style decomposition of the prompt itself.
  const graph = extractSceneGraph("a cat sitting on a wooden chair")
  assert.ok(graph.nodes.includes("cat"), `expected "cat" node, got ${graph.nodes.join(",")}`)
  assert.ok(graph.nodes.includes("chair"), `expected "chair" node, got ${graph.nodes.join(",")}`)
  assert.ok(
    graph.triples.some((t) => t.subject === "cat" && t.object === "chair"),
    `expected cat->chair triple, got ${JSON.stringify(graph.triples)}`,
  )

  // A clean, grounded prompt scores 1.0 and emits no feedback.
  const clean = assessImageToImagePrompt({ prompt: "a red bicycle leaning on a brick wall", strength: 0.5, style: "realistic_image" })
  assert.equal(clean.score, 1, `clean prompt should score 1, got ${clean.score}`)
  assert.ok(clean.semanticQueries.length > 0, "semantic queries should be non-empty")
  assert.ok(clean.artifactQueries.length > 0, "artifact queries should be non-empty")

  // Ungrounded pronouns, negation and rendered text each reduce the score.
  const risky = assessImageToImagePrompt({ prompt: 'a cat holding a sign, it is not wearing "WELCOME" text', strength: 0.8 })
  assert.ok(risky.score < clean.score, `risky prompt should score below clean, got ${risky.score}`)
  assert.ok(risky.failedSemantic.length > 0, "expected a failed semantic check")
  assert.ok(risky.failedArtifact.length > 0, "expected a failed artifact check")
  assert.ok(risky.advice.length > 0, "expected refinement advice")
  assert.ok(
    risky.advice.some((item) => item.includes("strength")),
    "expected strength-band advice for an ambiguous prompt at high strength",
  )

  // High strength with a preserved style and an ambiguous prompt yields style guidance.
  const styleCase = assessImageToImagePrompt({ prompt: "it looks nicer", strength: 0.9, style: "digital_illustration" })
  assert.ok(
    styleCase.advice.some((item) => item.includes("0.40")),
    "expected advice to drop strength to <= 0.40",
  )

  // Feedback is opt-out via env var, on by default.
  assert.equal(isAdherenceFeedbackEnabled(), true)
  const previous = process.env.RECRAFT_ADHERENCE_FEEDBACK
  process.env.RECRAFT_ADHERENCE_FEEDBACK = "0"
  assert.equal(isAdherenceFeedbackEnabled(), false)
  if (previous === undefined) {
    delete process.env.RECRAFT_ADHERENCE_FEEDBACK
  } else {
    process.env.RECRAFT_ADHERENCE_FEEDBACK = previous
  }

  // End-to-end through the wired call site: image_to_image returns the
  // generated-image message plus an adherence panel for a risky prompt.
  await withTempImage(async (imageURI) => {
    const server = stubServer([{ url: pngUrl(TINY_PNG_BASE64) }])

    const riskyText = await resultText(server, {
      imageURI,
      prompt: 'a cat holding a sign, it is not wearing "WELCOME" text',
      strength: 0.8,
    })
    assert.ok(riskyText.includes("Generated 1 image"), `expected success message, got: ${riskyText}`)
    assert.ok(riskyText.includes("adherence score"), `expected adherence panel, got: ${riskyText}`)
    assert.ok(riskyText.includes("- "), "expected bulleted refinement advice")

    const cleanText = await resultText(server, {
      imageURI,
      prompt: "a red bicycle leaning on a brick wall",
      strength: 0.5,
      style: "realistic_image",
    })
    assert.ok(cleanText.includes("Generated 1 image"), `expected success message, got: ${cleanText}`)
    assert.ok(!cleanText.includes("adherence score"), `expected no adherence panel, got: ${cleanText}`)
  })

  console.log("adherence integration tests passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
