import { describe, it } from "node:test"
import assert from "node:assert/strict"

// Imports the EXISTING call-site module (RecraftServer) — this is the
// integration target. buildImageResultContent is the wiring added there; it
// consumes the new scaffold helpers and the threaded textCallMode flag.
import { RecraftServer } from "../src/RecraftServer"
import { TEXTCALL_PLACEHOLDER, composeImageResultText, ScaffoldImage } from "../src/utils/scaffold"

type FakePreview = { type: string; data: string; mimeType: string }

const fakeImages: ScaffoldImage[] = [
  { width: 1024, height: 768, pathOrUrl: "file:///tmp/a.webp", format: "image/webp", revisedPrompt: "a red panda" },
]
const fakePreviews: FakePreview[] = [{ type: "image", data: "AAAA", mimeType: "image/webp" }]

const makeServer = (textCallMode: boolean) =>
  new RecraftServer({} as unknown as ConstructorParameters<typeof RecraftServer>[0], undefined, textCallMode)

const textOf = (result: { content?: Array<{ type: string; text?: string }> }) =>
  (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n")

const hasImage = (result: { content?: Array<{ type: string }> }) =>
  (result.content ?? []).some((c) => c.type === "image")

describe("composeImageResultText (scaffold text)", () => {
  it("emits dimensions, format, location, and intent as the load-bearing scaffold", () => {
    const text = composeImageResultText(
      [{ width: 512, height: 512, pathOrUrl: "https://x/y.webp", format: "image/webp", revisedPrompt: "a koi" }],
      "Generated 1 image.",
      false,
    )
    assert.ok(text.includes("512x512"), "dimensions must be present in the scaffold")
    assert.ok(text.includes("webp"), "format must be present in the scaffold")
    assert.ok(text.includes("https://x/y.webp"), "location must be present in the scaffold")
    assert.ok(text.includes("a koi"), "intent (revised prompt) must be present in the scaffold")
    assert.ok(!text.includes(TEXTCALL_PLACEHOLDER), "no TextCall placeholder in default mode")
  })

  it("TextCall mode emits the placeholder while keeping the scaffold", () => {
    const text = composeImageResultText(
      [{ width: 512, height: 512, pathOrUrl: "https://x/y.webp", format: "image/webp" }],
      "Generated 1 image.",
      true,
    )
    assert.ok(text.includes(TEXTCALL_PLACEHOLDER), "placeholder emitted in TextCall mode")
    assert.ok(text.includes("512x512"), "scaffold still carries the signal")
  })
})

describe("RecraftServer.buildImageResultContent (integration wiring)", () => {
  it("returns preview pixels plus scaffold text by default", () => {
    const result = makeServer(false).buildImageResultContent(fakeImages, fakePreviews, "Generated 1 image.")
    assert.equal(result.isError, false)
    assert.ok(hasImage(result), "preview pixels are returned by default")
    assert.ok(textOf(result).includes("1024x768"), "scaffold dimensions are present alongside the pixels")
  })

  it("TextCall mode omits pixels and carries the signal via the scaffold + placeholder", () => {
    const result = makeServer(true).buildImageResultContent(fakeImages, fakePreviews, "Generated 1 image.")
    assert.equal(result.isError, false)
    assert.equal(hasImage(result), false, "no preview pixels in TextCall mode")
    assert.ok(textOf(result).includes(TEXTCALL_PLACEHOLDER), "placeholder emitted in place of pixels")
    assert.ok(textOf(result).includes("1024x768"), "scaffold remains the load-bearing signal")
  })
})
