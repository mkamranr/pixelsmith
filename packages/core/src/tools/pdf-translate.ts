import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { z } from 'zod'

import { BadInputError, LlmUnavailableError } from '../errors.js'
import { chatWithLlm, readLlmSettings, type LlmSettings } from '../llm.js'
import { deriveName, uniqueName } from '../naming.js'
import { writeTextDocument } from '../pdf-document.js'
import { extractPdfText } from '../pdf-text.js'
import { PDF_MIME } from '../pdf.js'
import type { Tool } from '../registry.js'
import { splitForModel } from './pdf-summarise.js'

export const TranslatePdfParams = z.object({
  /**
   * Required: there is no sensible default target, and guessing one would
   * produce a document nobody asked for.
   */
  language: z.string().trim().min(2, { message: 'name the language to translate into' }).max(40),
  /**
   * Whether to keep the original alongside. Off by default — most people want
   * the translation, and a side-by-side doubles the length.
   */
  keepOriginal: z.coerce.boolean().default(false),
})

export type TranslatePdfParams = z.infer<typeof TranslatePdfParams>

const SYSTEM =
  'You translate documents faithfully. Translate everything given to you, ' +
  'preserve paragraph breaks, and reply with the translation alone — no ' +
  'commentary, no notes, no explanation of what you did.'

export const translatePdf: Tool<TranslatePdfParams> = {
  id: 'translate-pdf',
  title: 'Translate PDF',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  requires: 'llm',
  params: TranslatePdfParams,
  ui: {
    group: 'pdf-read',
    icon: 'message-square',
    surface: 'canvas',
    preview: 'none',
    blurb:
      'Translate the words of a document into another language. The text is sent to the language model configured on this server and nowhere else. A long document is translated in parts and joined back together — the layout is not reproduced, only the writing.',
    fields: [
      {
        name: 'language',
        label: 'Into',
        kind: 'text',
        help: 'The language to translate into — Arabic, French, Urdu.',
      },
      {
        name: 'keepOriginal',
        label: 'Keep the original alongside',
        kind: 'toggle',
        default: false,
        help: 'Each part followed by its translation, for checking against.',
      },
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
          `${input.name} has no text to translate. If it is a scan, run OCR PDF over it first.`,
        )
      }

      /**
       * Every part is kept.
       *
       * Summarising reduces, so a part that contributes little is no loss.
       * Translating must not: a translation missing its second half looks
       * complete, which is worse than one that failed.
       */
      const parts = splitForModel(text)
      const done: string[] = []

      for (const [at, part] of parts.entries()) {
        const translated = await chatWithLlm(llm, [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content:
              `Translate the following into ${params.language}. ` +
              `${parts.length > 1 ? `This is part ${at + 1} of ${parts.length} of one document. ` : ''}` +
              `Reply with the translation only.\n\n${part}`,
          },
        ])

        done.push(params.keepOriginal ? `${part.trim()}\n\n${translated.trim()}` : translated.trim())
        // The last step is laying the document out, so the bar does not sit at
        // 100% while that happens.
        onProgress?.(((index + (at + 1) / (parts.length + 1)) / inputs.length))
      }

      const body = done.join('\n\n')
      const suffix = `-${params.language.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
      const name = uniqueName(taken, deriveName(input.name, { ext: 'pdf', suffix }))
      const dest = join(outDir, name)
      await writeFile(
        dest,
        await writeTextDocument({
          title: `Translation — ${params.language}`,
          notes: [
            input.name,
            ...(parts.length > 1 ? [`Translated in ${parts.length} parts.`] : []),
          ],
          body,
        }),
      )
      outputs.push({
        path: dest,
        name,
        mime: PDF_MIME,
        bytes: (await stat(dest)).size,
        meta: { parts: parts.length, characters: text.length },
      })

      /** The same translation as text, so the results page can show it. */
      const textName = uniqueName(taken, deriveName(input.name, { ext: 'txt', suffix }))
      const textDest = join(outDir, textName)
      await writeFile(textDest, `${body}\n`, 'utf8')
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
