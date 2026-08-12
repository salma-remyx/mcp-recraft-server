import { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { GenerateImageResponse, Image } from "./api"
import { RecraftApi } from "./RecraftApi"
import { existsSync, mkdirSync } from "fs"
import { downloadImagesAndMakePreviews } from "./utils/response"
import { composeImageResultText, ScaffoldImage, toScaffoldImages } from "./utils/scaffold"

export class RecraftServer {
  api: RecraftApi
  private imageStorageDirectory: string | undefined
  private initialized: boolean = false
  textCallMode: boolean

  constructor(api: RecraftApi, imageStorageDirectory: string | undefined, textCallMode: boolean = false) {
    this.api = api
    this.imageStorageDirectory = imageStorageDirectory
    this.textCallMode = textCallMode
  }

  get isLocalResultsStorage(): boolean {
    return !!this.imageStorageDirectory
  }

  initializeIfNeeded = () => {
    if (this.initialized) {
      return
    }
    this.initialized = true

    if (this.imageStorageDirectory && !existsSync(this.imageStorageDirectory)) {
      mkdirSync(this.imageStorageDirectory, { recursive: true })
    }
  }

  transformGenerateImageResponseToCallToolResult = async (result: GenerateImageResponse): Promise<CallToolResult> => {
    const {downloadedImages: images, previews} = await downloadImagesAndMakePreviews(this.imageStorageDirectory, result.data)

    const pathOrUrlDesc = this.isLocalResultsStorage ? 'path' : 'URL'

    const ending = `${images.length === 1 ? '' : 's'}`
    const message = `Generated ${images.length} image${ending}.\n` +
     `Original image${ending} ${images.length === 1 ? 'is' : 'are'} saved to:\n${images.map(({pathOrUrl}) => `- ${pathOrUrl}`).join('\n')}` +
     (this.textCallMode
       ? ''
       : `\nBelow you can see lower quality preview${ending} of generated image${ending}.` +
         `${previews.length < images.length ? `\nNote: last ${images.length - previews.length} images are not shown due to message limit, but you can still find them by given ${pathOrUrlDesc}s.` : ''}`)

    return this.buildImageResultContent(toScaffoldImages(images), previews, message)
  }

  // Build the MCP tool-result content for a set of downloaded images. Always
  // emits the textual scaffold (dimensions, format, location, intent) — the
  // load-bearing signal per the Tool-Call Scaffold Hypothesis — so the client
  // model can reason over metadata even when previews are dropped. In TextCall
  // mode the preview pixels are omitted and the scaffold carries the signal.
  buildImageResultContent = (
    images: ScaffoldImage[],
    previews: Array<{ type: string; data: string; mimeType: string }>,
    preamble: string,
  ): CallToolResult => {
    const text = composeImageResultText(images, preamble, this.textCallMode)
    const content = []
    content.push({
      type: 'text',
      text,
    })
    if (!this.textCallMode) {
      content.push(...previews)
    }

    return {
      content: content,
      isError: false
    } as CallToolResult
  }

  transformSingleImageOperationToCallToolResult = async (image: Image, message: string): Promise<CallToolResult> => {
    const {downloadedImages, previews} = await downloadImagesAndMakePreviews(this.imageStorageDirectory, [image])

    const imageData = downloadedImages[0]

    const pathOrUrlDesc = this.isLocalResultsStorage ? 'local path' : 'URL'

    const totalMessage = message + '\n' +
      `Resulting image is saved to:\n- ${imageData.pathOrUrl}\n` +
      (this.textCallMode
        ? ''
        : previews.length == 0
          ? `Note: preview image is not shown due to message limit, but you can find the resulting image by ${pathOrUrlDesc}.`
          : `Below you can see the lower quality preview image of the result.`)

    return this.buildImageResultContent(toScaffoldImages(downloadedImages), previews, totalMessage)
  }
}
