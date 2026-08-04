import assert from "node:assert/strict"

// Imports from NON-NEW modules in src/ — this is what proves the wiring.
import { generateImageHandler } from "../src/tools/GenerateImage"
import { imageToImageHandler } from "../src/tools/ImageToImage"
import { validateStyleConstraints } from "../src/utils/styleConstraint"
import { ImageStyle, ImageSubStyle, TransformModel } from "../src/api"
import type { RecraftServer } from "../src/RecraftServer"

// The style check runs before any `server.api` access, so a no-op stand-in is
// enough: if validation ever stops short-circuiting, these tests will reach the
// mock and fail loudly instead of hitting the network.
const noServer = {} as unknown as RecraftServer

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  const first = result.content?.find((c) => c.type === "text")
  return first?.text ?? ""
}

async function main(): Promise<void> {
  // --- Integration: the wiring in generate_image short-circuits invalid
  //     model+style combos BEFORE the Recraft API is called. ---
  // "icon" is only available for recraftv2, so icon + recraftv3 must be
  // rejected up front with our diagnosis (not an opaque API failure).
  const rejected = await generateImageHandler(noServer, {
    prompt: "a glowing icon",
    style: ImageStyle.Icon,
    model: TransformModel.Recraftv3,
  })
  assert.equal(rejected.isError, true, "icon + recraftv3 should be rejected before the API call")
  const rejectedText = textOf(rejected)
  assert.match(rejectedText, /style_model_compat/, "diagnosis should name the fired rule")
  assert.match(rejectedText, /icon/, "diagnosis should name the offending style")

  // --- Integration: image_to_image wiring also short-circuits. ---
  // "logo_raster" is only available for recraftv3, so logo_raster + recraftv2
  // is rejected before the input image is even downloaded.
  const i2iRejected = await imageToImageHandler(noServer, {
    imageURI: "https://example.com/input.png",
    prompt: "a logo",
    strength: 0.5,
    style: ImageStyle.LogoRaster,
    model: TransformModel.Recraftv2,
  })
  assert.equal(i2iRejected.isError, true, "logo_raster + recraftv2 should be rejected before the API call")
  assert.match(textOf(i2iRejected), /style_model_compat/)

  // --- A valid combo is NOT flagged (no false positives that would break
  //     working requests). ---
  const valid = validateStyleConstraints({
    style: ImageStyle.RealisticImage,
    model: TransformModel.Recraftv3,
    substyle: ImageSubStyle.Hdr,
  })
  assert.equal(valid.ok, true, "realistic_image + recraftv3 + hdr is a valid combination")
  assert.equal(valid.violations.length, 0)

  // --- substyle not valid for the (model, style) pair is flagged. ---
  const badSubstyle = validateStyleConstraints({
    style: ImageStyle.RealisticImage,
    model: TransformModel.Recraftv2,
    substyle: ImageSubStyle.ForestLife, // only available for recraftv3
  })
  assert.equal(badSubstyle.ok, false)
  assert.equal(badSubstyle.violations[0]?.rule, "substyle_model_style_compat")

  // --- substyle without a style is flagged. ---
  const substyleNoStyle = validateStyleConstraints({ substyle: ImageSubStyle.Hdr })
  assert.equal(substyleNoStyle.ok, false)
  assert.equal(substyleNoStyle.violations[0]?.rule, "substyle_requires_style")

  // --- A styleID makes style/substyle opaque, so nothing is flagged. ---
  const styleIdOnly = validateStyleConstraints({
    styleID: "abc-123",
    style: ImageStyle.Icon,
    model: TransformModel.Recraftv3,
  })
  assert.equal(styleIdOnly.ok, true, "a custom styleID bypasses the matrix check")
}

main().then(() => console.log("styleConstraint tests passed")).catch((err) => {
  console.error("styleConstraint tests FAILED:", err)
  process.exit(1)
})
