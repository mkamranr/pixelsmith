import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { BadInputError, LlmUnavailableError } from '../errors.js'
import { chatWithLlm, readLlmSettings, type LlmSettings } from '../llm.js'
import { PDF_MIME } from '../pdf.js'
import { writeTextDocument } from '../pdf-document.js'
import { extractPdfText } from '../pdf-text.js'
import { deriveName, uniqueName } from '../naming.js'
import type { Tool } from '../registry.js'

/**
 * How much document text goes into one request.
 *
 * A model's context is finite and a document is not. Twenty-odd thousand
 * characters is roughly six thousand tokens — comfortable for the 8k contexts
 * that small local models ship with, and well short of the limit on larger ones.
 */
const PART_BUDGET = 24_000

/** A ceiling on the work one job will do, so a book cannot occupy a worker. */
const MAX_PARTS = 24

/** A phrase the combining prompt carries and a part prompt does not. */
const COMBINE_PROMPT = 'These are summaries of one document, in order.'

const LENGTHS = {
  brief: 'a single short paragraph',
  standard: 'about three paragraphs',
  detailed: 'roughly a page, with the main points as a list',
} as const


export const SummarisePdfParams = z.object({
  length: z.enum(['brief', 'standard', 'detailed']).default('standard'),
  /** Blank means the language the document is written in. */
  language: z.string().trim().max(60).optional(),
  /** An optional steer: what the reader cares about. */
  focus: z.string().trim().max(300).optional(),
})

export type SummarisePdfParams = z.infer<typeof SummarisePdfParams>

/** Split text into parts that fit a request, preferring paragraph breaks. */
export function splitForModel(text: string, budget = PART_BUDGET): string[] {
  if (text.length <= budget) return [text]

  const parts: string[] = []
  let rest = text

  while (rest.length > budget && parts.length < MAX_PARTS - 1) {
    // Cut at the last paragraph or sentence break inside the budget, so a part
    // does not end mid-thought. A wall of text with neither gets a hard cut.
    const window = rest.slice(0, budget)
    const at = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '))
    const cut = at > budget * 0.5 ? at + 1 : budget
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut)
  }

  if (rest.trim() !== '') parts.push(rest.trim())
  return parts
}

function instruction(params: SummarisePdfParams): string {
  const bits = [`Write ${LENGTHS[params.length]}.`]
  if (params.language) bits.push(`Write it in ${params.language}.`)
  if (params.focus) bits.push(`The reader cares most about: ${params.focus}.`)
  bits.push('Use only what the document says. Do not add anything it does not.')
  return bits.join(' ')
}

export const summarisePdf: Tool<SummarisePdfParams> = {
  id: 'summarise-pdf',
  title: 'Summarise PDF',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  requires: 'llm',
  params: SummarisePdfParams,
  ui: {
    group: 'pdf-read',
    icon: 'summary',
    surface: 'canvas',
    preview: 'none',
    blurb:
      'Read a long document and write what it says. The text is sent to the language model configured on this server and nowhere else — a long document is summarised in parts, then those summaries are summarised together.',
    fields: [
      { name: 'length', label: 'How long', kind: 'segmented', default: 'standard',
        options: [
          { value: 'brief', label: 'A paragraph' },
          { value: 'standard', label: 'A few paragraphs' },
          { value: 'detailed', label: 'A page' },
        ] },
      { name: 'language', label: 'Language', kind: 'text',
        help: 'Leave blank to use the language the document is written in.' },
      { name: 'focus', label: 'What matters most', kind: 'text',
        help: 'Optional. For example: costs and deadlines.' },
    ],
  },

  async run({ inputs, outDir, params, settings, onProgress }) {
    if (!settings.dataDir) {
      throw new LlmUnavailableError('one is not configured on this server yet')
    }
    const llm: LlmSettings | null = await readLlmSettings(settings.dataDir)

    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      const pages = await extractPdfText(input.path)
      const text = pages.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()

      if (text === '') {
        throw new BadInputError(
          `${input.name} has no text to summarise. If it is a scan, run OCR PDF over it first.`,
        )
      }

      const parts = splitForModel(text)
      const guidance = instruction(params)
      let summary: string

      if (parts.length === 1) {
        summary = await chatWithLlm(llm, [
          { role: 'system', content: 'You summarise documents faithfully and plainly.' },
          { role: 'user', content: `${guidance}\n\nThe document:\n\n${parts[0]}` },
        ])
      } else {
        const partial: string[] = []
        for (const [at, part] of parts.entries()) {
          partial.push(
            await chatWithLlm(llm, [
              { role: 'system', content: 'You summarise documents faithfully and plainly.' },
              {
                role: 'user',
                content:
                  `This is part ${at + 1} of ${parts.length} of one document. ` +
                  `Summarise this part on its own, keeping any figures and dates.\n\n${part}`,
              },
            ]),
          )
          onProgress?.((at + 1) / (parts.length + 1))
        }

        summary = await chatWithLlm(llm, [
          { role: 'system', content: 'You summarise documents faithfully and plainly.' },
          {
            role: 'user',
            content:
              `${COMBINE_PROMPT} Write one summary of the whole document from them. ` +
              `${guidance}\n\n${partial.map((s, at) => `Part ${at + 1}:\n${s}`).join('\n\n')}`,
          },
        ])
      }

      const name = uniqueName(taken, deriveName(input.name, { ext: 'pdf', suffix: '-summary' }))
      const dest = join(outDir, name)
      await writeFile(
        dest,
        await writeTextDocument({
          title: 'Summary',
          notes: [
            input.name,
            ...(parts.length > 1 ? [`Summarised in ${parts.length} parts, then combined.`] : []),
          ],
          body: summary,
        }),
      )

      outputs.push({
        path: dest,
        name,
        mime: PDF_MIME,
        bytes: (await stat(dest)).size,
        meta: { parts: parts.length, characters: text.length },
      })

      /**
       * The same summary as plain text, so the results page can show it. A
       * summary that can only be read by downloading a PDF and opening it
       * somewhere else is the point of asking for one left undone — and the
       * text is what anyone wants to paste into a message anyway.
       */
      const textName = uniqueName(taken, deriveName(input.name, { ext: 'txt', suffix: '-summary' }))
      const textDest = join(outDir, textName)
      await writeFile(textDest, `${summary.trim()}\n`, 'utf8')
      outputs.push({
        path: textDest,
        name: textName,
        mime: 'text/plain',
        bytes: (await stat(textDest)).size,
      })
      onProgress?.((index + 1) / inputs.length)
    }

    return outputs
  },
}

