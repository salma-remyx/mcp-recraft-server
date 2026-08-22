import { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

/**
 * Prompt adherence feedback for image_to_image.
 *
 * Adapted from "Beyond Trial-and-Error: Agentic Optimization for
 * Image-to-Video Adherence" (arXiv:2608.12290). The paper replaces blind
 * resampling with a closed loop of (a) Davidsonian Scene Graph (DSG)
 * semantic-adherence queries, (b) Common Mistake Questions (CMQ) for
 * artifact detection, and (c) structured refinement of the prompt and the
 * stochasticity hyperparameter instead of another unguided sample.
 *
 * In this MCP server the multimodal evaluator is the client, not the
 * server, so the pixel-side judge is substituted with a parameter-free
 * prompt-side proxy: the DSG decomposition is derived from the prompt's
 * own tokens, and the checks that can run without vision (ungrounded
 * references, conflicting attributes, text-rendering and negation
 * artifact risks) produce the adherence score and the refinement advice
 * handed back to the client.
 */

const STOPWORDS = new Set([
  "a", "an", "the", "of", "and", "or", "to", "at", "by", "for", "from",
  "into", "onto", "over", "up", "down", "out", "as", "is", "are", "was",
  "were", "be", "been", "very", "some", "any", "all", "there",
])

const RELATIONS = new Set([
  "in", "on", "under", "above", "behind", "beside", "near", "around",
  "between", "against", "with", "holding", "wearing", "carrying",
  "sitting", "standing", "lying", "leaning", "facing", "riding",
])

const PRONOUNS = new Set([
  "it", "its", "they", "them", "their", "this", "that", "these", "those",
  "he", "she", "his", "her", "him",
])

const COLORS = new Set([
  "red", "blue", "green", "yellow", "black", "white", "orange", "purple",
  "pink", "brown", "gray", "grey", "golden", "silver", "cyan", "magenta",
])

const COUNT_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12,
}

const TEXT_HINT = /["'“”‘’]|text|lettering|inscription|caption|label|sign\b|word/i
const NEGATION_HINT = /\b(no|without|not|except|excluding|avoid|none)\b/i
const CROWD_HINT = /\b(crowd|crowded|many|several|group of)\b/i

const MAX_CONTENT_TERMS = 24

export type SceneTriple = {
  subject: string
  relation: string
  object: string
}

export type SceneGraph = {
  nodes: string[]
  triples: SceneTriple[]
}

export type AdherenceAssessment = {
  score: number
  semanticScore: number
  artifactScore: number
  semanticQueries: string[]
  artifactQueries: string[]
  failedSemantic: string[]
  failedArtifact: string[]
  advice: string[]
}

const isContentTerm = (token: string) => token.length > 1 && !STOPWORDS.has(token)

export const extractSceneGraph = (prompt: string): SceneGraph => {
  const tokens = prompt.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean)

  // Nodes are entities; relation words are edges, so they are excluded from
  // the node set and skipped when looking for a triple's endpoints.
  const isEntityAt = (index: number) => index >= 0 && index < tokens.length
    && isContentTerm(tokens[index]) && !RELATIONS.has(tokens[index])

  const nodes: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (isEntityAt(i) && !nodes.includes(tokens[i])) {
      nodes.push(tokens[i])
    }
  }

  const nearestEntity = (from: number, step: -1 | 1): string | undefined => {
    for (let i = from; i >= 0 && i < tokens.length; i += step) {
      if (isEntityAt(i)) {
        return tokens[i]
      }
    }
    return undefined
  }

  const triples: SceneTriple[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (!RELATIONS.has(tokens[i])) {
      continue
    }
    const subject = nearestEntity(i - 1, -1)
    // Prefer the head noun of the object phrase: if the nearest entity is an
    // adjective directly followed by a noun, that noun is the object.
    const nearestAfter = nearestEntity(i + 1, 1)
    let object = nearestAfter
    if (nearestAfter) {
      const after = tokens.indexOf(nearestAfter, i + 1)
      if (after + 1 < tokens.length && isEntityAt(after + 1)) {
        object = tokens[after + 1]
      }
    }
    if (!subject || !object || subject === object) {
      continue
    }
    const triple = { subject, relation: tokens[i], object }
    if (!triples.some(t => t.subject === triple.subject && t.relation === triple.relation && t.object === triple.object)) {
      triples.push(triple)
    }
  }

  return { nodes, triples }
}

export const semanticQueriesFor = (graph: SceneGraph): string[] => [
  ...graph.nodes.map(node => `Is there ${startsWithVowel(node) ? "an" : "a"} ${node} in the image?`),
  ...graph.triples.map(t => `Is the ${t.subject} ${t.relation} the ${t.object}?`),
]

export const artifactQueries = (): string[] => [
  "Are all letters and words rendered correctly spelled?",
  "Does every person have a natural number of limbs and fingers?",
  "Is every object from the prompt present exactly once, without duplicates or omissions?",
  "Is the image free of watermarks, signatures, and frame artifacts?",
]

const startsWithVowel = (word: string) => "aeiou".includes(word[0])

const conflictingColorsOnSameNoun = (graph: SceneGraph, prompt: string): string | undefined => {
  const tokens = prompt.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    if (!COLORS.has(tokens[i])) {
      continue
    }
    const noun = tokens.slice(i + 1, i + 3).find(t => isContentTerm(t) && !COLORS.has(t))
    if (!noun) {
      continue
    }
    const other = tokens.slice(i + 1, i + 3).find(t => COLORS.has(t))
    if (other) {
      return `conflicting colors "${tokens[i]}" and "${other}" both describe "${noun}"`
    }
  }
  return undefined
}

export const assessImageToImagePrompt = (args: {
  prompt: string
  strength: number
  style?: string
  substyle?: string
  styleID?: string
}): AdherenceAssessment => {
  const { prompt, strength, style, substyle, styleID } = args
  const graph = extractSceneGraph(prompt)

  const semanticQueries = semanticQueriesFor(graph)
  const artifactQueriesList = artifactQueries()
  const failedSemantic: string[] = []
  const failedArtifact: string[] = []
  const advice: string[] = []

  const lower = prompt.toLowerCase()
  const pronoun = graph.nodes.length === 0 ? undefined : [...lower.matchAll(/\b[a-z]+\b/g)].map(m => m[0]).find(t => PRONOUNS.has(t))
  if (graph.nodes.length === 0) {
    failedSemantic.push("the prompt has no concrete content terms to ground a scene graph")
    advice.push("name at least one concrete subject in the prompt, e.g. \"a red bicycle leaning on a brick wall\"")
  } else {
    if (pronoun) {
      failedSemantic.push(`reference "${pronoun}" is not grounded in the scene graph`)
      advice.push(`replace "${pronoun}" with the noun it refers to, so every subject is explicit`)
    }
    const colorConflict = conflictingColorsOnSameNoun(graph, prompt)
    if (colorConflict) {
      failedSemantic.push(colorConflict)
      advice.push("keep one attribute per subject; conflicting attributes split the model's attention")
    }
    if (graph.nodes.length > MAX_CONTENT_TERMS) {
      failedSemantic.push(`prompt carries ${graph.nodes.length} content terms, which dilutes adherence`)
      advice.push(`trim the prompt to the ${MAX_CONTENT_TERMS} terms that must appear, and move the rest to a follow-up edit`)
    }
  }

  if (TEXT_HINT.test(prompt)) {
    failedArtifact.push("prompt asks for rendered text, a frequent source of garbled glyphs")
    advice.push("keep any quoted text under 3 words and place it in quotes on its own")
  }
  if (NEGATION_HINT.test(prompt)) {
    failedArtifact.push("prompt uses negation, which often renders the excluded object")
    advice.push("state what should be present instead of what should not")
  }
  const countEntry = Object.keys(COUNT_WORDS).find(word => new RegExp(`\\b${word}\\b`).test(lower))
  if (countEntry && COUNT_WORDS[countEntry] > 6) {
    failedArtifact.push(`prompt requests ${COUNT_WORDS[countEntry]} instances, which risks duplication or omission`)
    advice.push("lower the requested count to at most 6 per subject for reliable results")
  }
  if (CROWD_HINT.test(prompt)) {
    failedArtifact.push("prompt implies an unbounded number of people, a common limb-distortion trigger")
    advice.push("bound the number of people explicitly, e.g. \"three people\"")
  }

  const semanticScore = clamp(1 - 0.25 * failedSemantic.length)
  const artifactScore = clamp(1 - 0.34 * failedArtifact.length)
  const score = clamp(0.6 * semanticScore + 0.4 * artifactScore)

  const preservesStyle = !!(style || substyle || styleID)
  if (preservesStyle && semanticScore < 1 && strength > 0.4) {
    advice.push(`strength ${strength.toFixed(2)} is high while the prompt is ambiguous; drop it to <= 0.40 so the reference image carries the scene`)
  }
  if (artifactScore < 1 && strength > 0.6) {
    advice.push(`strength ${strength.toFixed(2)} amplifies artifact risk; regenerate in the 0.30-0.60 band before going higher`)
  }

  return {
    score,
    semanticScore,
    artifactScore,
    semanticQueries,
    artifactQueries: artifactQueriesList,
    failedSemantic,
    failedArtifact,
    advice,
  }
}

const clamp = (value: number) => Math.max(0, Math.min(1, value))

export const formatAdherenceFeedback = (assessment: AdherenceAssessment): string => {
  if (assessment.score >= 1) {
    return ""
  }

  const lines = [
    `Prompt adherence score ${assessment.score.toFixed(2)} (semantic ${assessment.semanticScore.toFixed(2)}, artifact ${assessment.artifactScore.toFixed(2)}).`,
  ]
  if (assessment.failedSemantic.length > 0) {
    lines.push(`Semantic checks failed: ${assessment.failedSemantic.join("; ")}.`)
  }
  if (assessment.failedArtifact.length > 0) {
    lines.push(`Artifact checks failed: ${assessment.failedArtifact.join("; ")}.`)
  }
  if (assessment.advice.length > 0) {
    lines.push("Before regenerating, refine the prompt and strength instead of resampling blindly:")
    lines.push(...assessment.advice.map(item => `- ${item}`))
  }
  return lines.join("\n")
}

export const isAdherenceFeedbackEnabled = (): boolean => process.env.RECRAFT_ADHERENCE_FEEDBACK !== "0"

export const appendAdherenceFeedback = (result: CallToolResult, feedback: string): CallToolResult => {
  if (!feedback) {
    return result
  }
  return {
    ...result,
    content: [
      ...result.content,
      { type: 'text', text: feedback },
    ],
  }
}
