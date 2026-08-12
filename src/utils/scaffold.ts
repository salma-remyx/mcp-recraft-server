// Textual scaffold for Recraft image tool results.
//
// Adapted from "Thinking With Tools, Not With Pixels: Tool Calls as Text
// Scaffolds for Visual Reasoning" (arXiv:2608.09682). The paper's Tool-Call
// Scaffold Hypothesis: the structured text emitted at tool-call time (tool
// name, coordinates/dimensions, target/style descriptors, intent) is the
// load-bearing signal for downstream visual reasoning, while the returned
// pixels are a largely redundant carrier. TextCall keeps the scaffold and
// replaces returned images with the placeholder `[Image output skipped]`,
// preserving accuracy while cutting latency by eliminating the pixel return.
//
// In this MCP server the "tool call" maps to the tool result returned to the
// MCP client: the scaffold is the structured metadata (dimensions, format,
// location, revised prompt) and the "returned pixels" are the preview image
// payloads already attached to results. `buildImageScaffold` always emits
// that metadata so the client model can reason over it even when previews are
// downsampled away by the message-size limit. `composeImageResultText`
// additionally emits the TextCall placeholder per image when pixel omission
// is opted into.

export const TEXTCALL_PLACEHOLDER = "[Image output skipped]"

export type ScaffoldImage = {
  width: number
  height: number
  pathOrUrl: string
  format?: string
  revisedPrompt?: string
}

// Structural shape of a downloaded image as produced by
// downloadImagesAndMakePreviews (src/utils/response.ts). Declared locally so
// this module stays decoupled from the response builder's inferred type.
export type ScaffoldSource = {
  width: number
  height: number
  pathOrUrl: string
  revisedPrompt?: string
  previewData: { mimeType: string }
}

const formatLabel = (format?: string): string => {
  if (!format) return ""
  const slash = format.lastIndexOf("/")
  return slash >= 0 ? format.slice(slash + 1) : format
}

export const scaffoldEntry = (image: ScaffoldImage, index: number): string => {
  const fmt = formatLabel(image.format)
  const descriptor = `${image.width}x${image.height}${fmt ? ` ${fmt}` : ""}`
  const head = `- image ${index + 1}: ${descriptor} -> ${image.pathOrUrl}`
  return image.revisedPrompt ? `${head}\n  intent: ${image.revisedPrompt}` : head
}

// One structured line per image: dimensions, format, location, and the
// model's revised prompt (intent descriptor) when present. These fields are
// already computed downstream but were previously discarded from the result
// text, leaving the pixels as the only signal.
export const buildImageScaffold = (images: ScaffoldImage[]): string => {
  if (images.length === 0) return ""
  return "Textual scaffold (dimensions, format, location, intent):\n" +
    images.map((image, i) => scaffoldEntry(image, i)).join("\n")
}

export const toScaffoldImages = (images: ScaffoldSource[]): ScaffoldImage[] =>
  images.map(({ width, height, pathOrUrl, revisedPrompt, previewData }) => ({
    width,
    height,
    pathOrUrl,
    revisedPrompt,
    format: previewData.mimeType,
  }))

// Compose the full text block for an image tool result. Always includes the
// scaffold (the load-bearing signal). When `textCallMode` is set the returned
// pixels are intentionally omitted and a `[Image output skipped]` placeholder
// is emitted per image instead (TextCall). Pixel inclusion itself is left to
// the caller so the preview payloads keep their original shape; this function
// only owns the text.
export const composeImageResultText = (
  images: ScaffoldImage[],
  preamble: string,
  textCallMode: boolean,
): string => {
  const parts: string[] = [preamble]
  const scaffold = buildImageScaffold(images)
  if (scaffold) parts.push(scaffold)
  if (textCallMode) {
    const placeholders = images.map(() => TEXTCALL_PLACEHOLDER).join("\n")
    if (placeholders) parts.push(placeholders)
  }
  return parts.join("\n\n")
}
