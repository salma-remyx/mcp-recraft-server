import assert from "assert"
import { imageToImageTool } from "../tools/ImageToImage"
import { generateImageTool } from "../tools/GenerateImage"
import { getUserTool } from "../tools/GetUser"
import { PARAMETERS, STYLE_PRESERVATION_WARNING } from "./parameters"
import { paramCausedBy, withToolPlayHints, ToolPlayMemory } from "./toolPlayGuidance"

// The wiring in src/index.ts serves the real tool declarations through
// withToolPlayHints, so the hints must compose with the descriptions the
// tool modules build from the PARAMETERS constants.
const declaredTools = [
  generateImageTool,
  imageToImageTool,
  getUserTool,
]

const recordThenList = (trials: Parameters<ToolPlayMemory["record"]>[0][]) =>
  withToolPlayHints(declaredTools, trials)
    .find(tool => tool.name === imageToImageTool.name)?.description ?? ""

const run = () => {
  // A failed trial that the API blamed on `style` adds a pitfall note to
  // exactly that tool's description, after the declared description.
  const description = recordThenList([
    { tool: "image_to_image", params: ["imageURI", "prompt", "strength", "style"], outcome: "error", failedParam: "style" },
  ])
  assert.ok(description.startsWith(imageToImageTool.description), "declared description must be preserved as the prefix")
  assert.match(description, /Known pitfall observed in 1 recent call/)
  assert.match(description, /`style` failed/)

  // Hints stay on their own tool: get_user is untouched.
  const untouched = withToolPlayHints(declaredTools, [
    { tool: "image_to_image", params: ["style"], outcome: "error", failedParam: "style" },
  ]).find(tool => tool.name === getUserTool.name)
  assert.strictEqual(untouched?.description, getUserTool.description)

  // No trials at all -> static descriptions are served unchanged.
  assert.deepStrictEqual(withToolPlayHints(declaredTools, []), declaredTools)

  // Successful play with parameters yields a positive usage note.
  assert.match(recordThenList([
    { tool: "image_to_image", params: ["style", "substyle"], outcome: "success" },
  ]), /`style, substyle` worked well/)

  // Trials without parameters (pure defaults) carry no instruction.
  assert.deepStrictEqual(
    withToolPlayHints(declaredTools, [{ tool: "generate_image", params: [], outcome: "success" }]),
    declaredTools,
  )

  // Repeated play strengthens the count instead of stacking duplicates.
  const memory = new ToolPlayMemory()
  for (let i = 0; i < 3; i++) {
    memory.record({ tool: "image_to_image", params: ["styleID"], outcome: "error", failedParam: "styleID" })
  }
  const [hint] = withToolPlayHints(declaredTools, memory.trials, 1)
    .map(tool => tool.description.match(/Known pitfall observed in (\d+) recent calls?/)?.[1])
    .filter(Boolean)
  assert.strictEqual(hint, "3")

  // Memory is bounded: the newest trial survives, the oldest is dropped.
  const bounded = new ToolPlayMemory(2)
  for (const tool of ["get_user", "generate_image", "image_to_image"]) {
    bounded.record({ tool: tool, params: ["style"], outcome: "error", failedParam: "style" })
  }
  assert.deepStrictEqual(bounded.trials.map(trial => trial.tool), ["generate_image", "image_to_image"])

  // paramCausedBy extracts the blamed parameter from Recraft API error
  // text, which is what turns an isError result into a targeted hint.
  assert.strictEqual(paramCausedBy(new Error("Invalid parameters: style and style_id are mutually exclusive")), "style")
  assert.strictEqual(paramCausedBy(new Error("substyle is not available for the specified style")), "substyle")
  assert.strictEqual(paramCausedBy("Invalid style_id format"), "styleID")
  assert.strictEqual(paramCausedBy(new Error("connect ECONNREFUSED")), undefined)

  // The handler hands paramCausedBy the isError result's content blocks,
  // so the cause must be extractable from a text block too.
  assert.strictEqual(
    paramCausedBy([{ type: "text", text: "Error generating image: Error: style and style_id are mutually exclusive" }]),
    "style",
  )
  assert.strictEqual(paramCausedBy([{ type: "text", text: "Error generating image: fetch failed" }]), undefined)

  // The style-preservation guidance the hints compose with is still the
  // one the image_to_image schema carries.
  assert.ok(imageToImageTool.inputSchema.properties.style.description.includes(STYLE_PRESERVATION_WARNING))
  assert.ok(PARAMETERS.imageStyle.description.length > 0)
}

run()
console.log("toolPlayGuidance tests passed")
