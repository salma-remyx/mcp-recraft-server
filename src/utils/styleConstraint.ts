import { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { ImageStyle, ImageSubStyle, TransformModel } from "../api"

/**
 * Deterministic style/model/substyle compatibility checker for Recraft image
 * requests. Runs BEFORE the request reaches the Recraft API and returns a
 * structured diagnosis the caller can repair from.
 *
 * Adapted (Mode 2) from the core mechanism of "Euclid-MCP: A Model Context
 * Protocol Server for Deterministic Logical Reasoning via Prolog"
 * (arXiv:2607.21412). Euclid-MCP turns compliance rules into an explicit,
 * machine-checkable rule set (its "Euclid-IR") that an agent can validate
 * against before execution, emitting human/LLM-readable proof/diagnosis
 * instead of letting invalid requests fail opaquely downstream.
 *
 * Target-native substitutions: the paper's SWI-Prolog / Euclid-IR backend and
 * Python MCP runtime are replaced by a TypeScript rule engine over the validity
 * matrix that already exists as prose in `src/utils/parameters.ts` and the
 * generated `src/api` enum models. The paper's separate benchmark/evaluation
 * framework and its full translate-run-inspect-repair MCP tool surface are out
 * of scope here — this delivers only the validate-then-diagnose step, wired
 * into the generate_image / image_to_image handlers.
 *
 * `STYLE_SUBSTYLE_MATRIX` below is the single source of truth, transcribed
 * verbatim from the `imageStyle` / `imageSubStyle` descriptions in
 * parameters.ts. A (model, style) pair is compatible iff it has an entry, and a
 * substyle is compatible iff it appears in that entry's list.
 */

type SubstylesByStyle = Partial<Record<ImageStyle, readonly ImageSubStyle[]>>

const STYLE_SUBSTYLE_MATRIX: Partial<Record<TransformModel, SubstylesByStyle>> = {
  [TransformModel.Recraftv3]: {
    [ImageStyle.RealisticImage]: [
      ImageSubStyle.BAndW, ImageSubStyle.Enterprise, ImageSubStyle.EveningLight,
      ImageSubStyle.FadedNostalgia, ImageSubStyle.ForestLife, ImageSubStyle.HardFlash,
      ImageSubStyle.Hdr, ImageSubStyle.MotionBlur, ImageSubStyle.MysticNaturalism,
      ImageSubStyle.NaturalLight, ImageSubStyle.NaturalTones, ImageSubStyle.OrganicCalm,
      ImageSubStyle.RealLifeGlow, ImageSubStyle.RetroRealism, ImageSubStyle.RetroSnapshot,
      ImageSubStyle.StudioPortrait, ImageSubStyle.UrbanDrama, ImageSubStyle.VillageRealism,
      ImageSubStyle.WarmFolk,
    ],
    [ImageStyle.DigitalIllustration]: [
      ImageSubStyle._2dArtPoster, ImageSubStyle._2dArtPoster2, ImageSubStyle.Antiquarian,
      ImageSubStyle.BoldFantasy, ImageSubStyle.ChildBook, ImageSubStyle.Cover,
      ImageSubStyle.Crosshatch, ImageSubStyle.DigitalEngraving, ImageSubStyle.EngravingColor,
      ImageSubStyle.Expressionism, ImageSubStyle.FreehandDetails, ImageSubStyle.Grain,
      ImageSubStyle.Grain20, ImageSubStyle.GraphicIntensity, ImageSubStyle.HandDrawn,
      ImageSubStyle.HandDrawnOutline, ImageSubStyle.Handmade3d, ImageSubStyle.HardComics,
      ImageSubStyle.InfantileSketch, ImageSubStyle.LongShadow, ImageSubStyle.ModernFolk,
      ImageSubStyle.Multicolor, ImageSubStyle.NeonCalm, ImageSubStyle.Noir,
      ImageSubStyle.NostalgicPastel, ImageSubStyle.OutlineDetails, ImageSubStyle.PastelGradient,
      ImageSubStyle.PastelSketch, ImageSubStyle.PixelArt, ImageSubStyle.Plastic,
      ImageSubStyle.PopArt, ImageSubStyle.PopRenaissance, ImageSubStyle.Seamless,
      ImageSubStyle.StreetArt, ImageSubStyle.TabletSketch, ImageSubStyle.UrbanGlow,
      ImageSubStyle.UrbanSketching, ImageSubStyle.YoungAdultBook, ImageSubStyle.YoungAdultBook2,
    ],
    [ImageStyle.VectorIllustration]: [
      ImageSubStyle.BoldStroke, ImageSubStyle.Chemistry, ImageSubStyle.ColoredStencil,
      ImageSubStyle.Cosmics, ImageSubStyle.Cutout, ImageSubStyle.Depressive,
      ImageSubStyle.Editorial, ImageSubStyle.EmotionalFlat, ImageSubStyle.Engraving,
      ImageSubStyle.LineArt, ImageSubStyle.LineCircuit, ImageSubStyle.Linocut,
      ImageSubStyle.MarkerOutline, ImageSubStyle.Mosaic, ImageSubStyle.Naivector,
      ImageSubStyle.RoundishFlat, ImageSubStyle.Seamless, ImageSubStyle.SegmentedColors,
      ImageSubStyle.SharpContrast, ImageSubStyle.Thin, ImageSubStyle.VectorPhoto,
      ImageSubStyle.VividShapes,
    ],
    [ImageStyle.LogoRaster]: [
      ImageSubStyle.EmblemGraffiti, ImageSubStyle.EmblemPopArt, ImageSubStyle.EmblemPunk,
      ImageSubStyle.EmblemStamp, ImageSubStyle.EmblemVintage,
    ],
  },
  [TransformModel.Recraftv2]: {
    [ImageStyle.RealisticImage]: [
      ImageSubStyle.BAndW, ImageSubStyle.Enterprise, ImageSubStyle.HardFlash,
      ImageSubStyle.Hdr, ImageSubStyle.MotionBlur, ImageSubStyle.NaturalLight,
      ImageSubStyle.StudioPortrait,
    ],
    [ImageStyle.DigitalIllustration]: [
      ImageSubStyle._2dArtPoster, ImageSubStyle._2dArtPoster2, ImageSubStyle._3d,
      ImageSubStyle._80s, ImageSubStyle.EngravingColor, ImageSubStyle.Glow,
      ImageSubStyle.Grain, ImageSubStyle.HandDrawn, ImageSubStyle.HandDrawnOutline,
      ImageSubStyle.Handmade3d, ImageSubStyle.InfantileSketch, ImageSubStyle.Kawaii,
      ImageSubStyle.PixelArt, ImageSubStyle.Plastic, ImageSubStyle.Psychedelic,
      ImageSubStyle.Seamless, ImageSubStyle.Voxel, ImageSubStyle.Watercolor,
    ],
    [ImageStyle.VectorIllustration]: [
      ImageSubStyle.Cartoon, ImageSubStyle.DoodleLineArt, ImageSubStyle.Engraving,
      ImageSubStyle.Flat2, ImageSubStyle.Kawaii, ImageSubStyle.LineArt,
      ImageSubStyle.LineCircuit, ImageSubStyle.Linocut, ImageSubStyle.Seamless,
    ],
    [ImageStyle.Icon]: [
      ImageSubStyle.BrokenLine, ImageSubStyle.ColoredOutline, ImageSubStyle.ColoredShapes,
      ImageSubStyle.ColoredShapesGradient, ImageSubStyle.DoodleFill, ImageSubStyle.DoodleOffsetFill,
      ImageSubStyle.OffsetFill, ImageSubStyle.Outline, ImageSubStyle.OutlineGradient,
      ImageSubStyle.Pictogram,
    ],
  },
}

// The Recraft API default model when a client omits `model` (see parameters.ts).
const DEFAULT_MODEL = TransformModel.Recraftv3

export interface StyleConstraintInput {
  model?: TransformModel
  style?: ImageStyle
  substyle?: ImageSubStyle
  styleID?: string
}

export interface StyleConstraintViolation {
  rule: string
  field: "model" | "style" | "substyle"
  message: string
  suggestion?: string
}

export interface StyleConstraintResult {
  ok: boolean
  violations: StyleConstraintViolation[]
}

/** Models that expose a given style, derived from the matrix above. */
function modelsForStyle(style: ImageStyle): TransformModel[] {
  return (Object.keys(STYLE_SUBSTYLE_MATRIX) as TransformModel[]).filter(
    (model) => STYLE_SUBSTYLE_MATRIX[model]?.[style] !== undefined,
  )
}

/**
 * Validate a Recraft image request against the model/style/substyle rules.
 * Pure and total: returns a structured diagnosis, never throws.
 */
export function validateStyleConstraints(input: StyleConstraintInput): StyleConstraintResult {
  const violations: StyleConstraintViolation[] = []

  // A custom styleID is opaque and the handlers drop style/substyle for it,
  // so there is nothing to check against the model/style matrix.
  if (input.styleID) {
    return { ok: true, violations }
  }

  if (!input.style) {
    if (input.substyle) {
      violations.push({
        rule: "substyle_requires_style",
        field: "substyle",
        message: `substyle "${input.substyle}" was provided without a "style".`,
        suggestion: "Provide a compatible style, or drop the substyle.",
      })
    }
    return { ok: violations.length === 0, violations }
  }

  const model = input.model ?? DEFAULT_MODEL
  // Only rule-check the documented recraftv2/v3 models. For any other model we
  // have no matrix, so we do not risk a false positive.
  if (input.model !== undefined && STYLE_SUBSTYLE_MATRIX[model] === undefined) {
    return { ok: true, violations }
  }

  const allowedSubstyles = STYLE_SUBSTYLE_MATRIX[model]?.[input.style]
  if (allowedSubstyles === undefined) {
    const supported = modelsForStyle(input.style)
    violations.push({
      rule: "style_model_compat",
      field: "style",
      message: `style "${input.style}" is not available for model "${model}".`,
      suggestion: supported.length
        ? `Use one of: ${supported.join(", ")}.`
        : `style "${input.style}" is not available for any supported model.`,
    })
  } else if (input.substyle && !allowedSubstyles.includes(input.substyle)) {
    violations.push({
      rule: "substyle_model_style_compat",
      field: "substyle",
      message: `substyle "${input.substyle}" is not available for model "${model}" with style "${input.style}".`,
      suggestion: `Available substyles: ${allowedSubstyles.join(", ")}.`,
    })
  }

  return { ok: violations.length === 0, violations }
}

/**
 * Convenience for handlers: validate the request and, on failure, render the
 * diagnosis as an MCP error result. Returns null when the request is valid so
 * the handler can proceed to the Recraft API.
 */
export function styleConstraintsErrorOrNull(input: StyleConstraintInput): CallToolResult | null {
  const result = validateStyleConstraints(input)
  if (result.ok) {
    return null
  }
  const text = "Recraft request rejected by style constraint check before calling the API:\n" +
    result.violations
      .map((v) => `- [${v.rule}] ${v.message}${v.suggestion ? ` ${v.suggestion}` : ""}`)
      .join("\n")
  return {
    content: [{ type: "text", text }],
    isError: true,
  }
}
