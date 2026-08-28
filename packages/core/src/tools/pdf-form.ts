import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  StandardFonts,
  type PDFField,
  type PDFForm,
} from 'pdf-lib'
import { z } from 'zod'

import { BadInputError } from '../errors.js'
import { uniqueName } from '../naming.js'
import { loadPdf, PDF_MIME } from '../pdf.js'
import type { Tool } from '../registry.js'

export const FillFormParams = z.object({
  /**
   * The answers, as a JSON object of field name to value. Written by the page
   * from the fields it found in the document, or supplied directly by a script.
   */
  values: z.string().trim().min(1, { message: 'nothing to fill in' }).max(200_000),
  /**
   * On by default: the usual reason for filling a form is to send it, and a
   * recipient who can edit the answers has been sent a draft.
   */
  flatten: z.coerce.boolean().default(true),
})

export type FillFormParams = z.infer<typeof FillFormParams>

/** What kind of thing a field is, in words a page can show. */
export type FieldKind = 'text' | 'choice' | 'multiple' | 'check' | 'radio' | 'other'

export interface FormField {
  name: string
  kind: FieldKind
  /** The permitted answers, for the kinds that have them. */
  options?: string[]
  /** What it says now, so a page can show the form as it stands. */
  value?: string | string[] | boolean
}

/** Truthy in the ways a form control and a JSON payload each express yes. */
function isYes(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const said = String(value).trim().toLowerCase()
  return said === 'true' || said === 'on' || said === 'yes' || said === '1'
}

/**
 * Every field in a document, with what it will accept.
 *
 * Exported because the page needs the same list to build inputs from, and two
 * descriptions of one form would eventually disagree.
 */
export function describeForm(form: PDFForm): FormField[] {
  return form.getFields().map((field: PDFField): FormField => {
    const name = field.getName()

    if (field instanceof PDFTextField) {
      return { name, kind: 'text', value: field.getText() ?? '' }
    }
    if (field instanceof PDFDropdown) {
      return { name, kind: 'choice', options: field.getOptions(), value: field.getSelected() }
    }
    if (field instanceof PDFOptionList) {
      return { name, kind: 'multiple', options: field.getOptions(), value: field.getSelected() }
    }
    if (field instanceof PDFCheckBox) {
      return { name, kind: 'check', value: field.isChecked() }
    }
    if (field instanceof PDFRadioGroup) {
      return { name, kind: 'radio', options: field.getOptions(), value: field.getSelected() ?? '' }
    }
    return { name, kind: 'other' }
  })
}

function answer(form: PDFForm, field: PDFField, value: unknown): void {
  const name = field.getName()

  if (field instanceof PDFTextField) {
    field.setText(value === null || value === undefined ? '' : String(value))
    return
  }

  if (field instanceof PDFCheckBox) {
    if (isYes(value)) field.check()
    else field.uncheck()
    return
  }

  if (field instanceof PDFDropdown || field instanceof PDFRadioGroup) {
    const said = String(value)
    const options = field.getOptions()
    if (!options.includes(said)) {
      throw new BadInputError(
        `"${said}" is not one of the answers ${name} offers — it accepts ${options.join(', ')}`,
      )
    }
    field.select(said)
    return
  }

  if (field instanceof PDFOptionList) {
    const chosen = Array.isArray(value) ? value.map(String) : [String(value)]
    const options = field.getOptions()
    const stranger = chosen.find((one) => !options.includes(one))
    if (stranger !== undefined) {
      throw new BadInputError(
        `"${stranger}" is not one of the answers ${name} offers — it accepts ${options.join(', ')}`,
      )
    }
    field.select(chosen[0]!)
    for (const one of chosen.slice(1)) field.select(one, false)
    return
  }

  throw new BadInputError(`${name} is a kind of field this cannot fill in`)
}

export const fillForm: Tool<FillFormParams> = {
  id: 'fill-form',
  title: 'Fill a PDF form',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  params: FillFormParams,
  ui: {
    group: 'pdf-edit',
    icon: 'pen-line',
    surface: 'canvas',
    builder: 'form',
    preview: 'none',
    blurb:
      'Fill in the boxes of a form that has them, and lock the answers in. The fields come from the document itself, so what you are offered is exactly what the form asks for.',
    fields: [
      {
        // Written by the page from the fields it found. Declared, because a
        // value that exists only in the schema is dropped at intake.
        name: 'values',
        label: 'Answers',
        kind: 'hidden',
      },
      {
        name: 'flatten',
        label: 'Lock the answers in',
        kind: 'toggle',
        default: true,
        help: 'The answers become part of the page and can no longer be edited. Turn off to keep the form fillable.',
      },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    let given: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(params.values)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object')
      }
      given = parsed as Record<string, unknown>
    } catch {
      throw new BadInputError('the answers could not be read')
    }

    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      const doc = await loadPdf(input.path)
      const form = doc.getForm()
      const fields = form.getFields()

      if (fields.length === 0) {
        throw new BadInputError(
          `${input.name} has no form fields in it — there is nothing to fill in`,
        )
      }

      const byName = new Map(fields.map((field) => [field.getName(), field]))
      // A typo that silently does nothing hands back a form that looks filled
      // in and is not, which is the one outcome worth refusing over.
      for (const name of Object.keys(given)) {
        if (!byName.has(name)) {
          throw new BadInputError(
            `${input.name} has no field called "${name}" — it has ${[...byName.keys()].join(', ')}`,
          )
        }
      }

      for (const [name, value] of Object.entries(given)) {
        answer(form, byName.get(name)!, value)
      }

      /**
       * Draw the answers. Without this some viewers show a filled field as
       * empty, because the value and the picture of the value are separate
       * things in a PDF and only the latter is displayed.
       */
      const helvetica = await doc.embedFont(StandardFonts.Helvetica)
      form.updateFieldAppearances(helvetica)
      if (params.flatten) form.flatten()

      const name = uniqueName(taken, input.name)
      const dest = join(outDir, name)
      await writeFile(dest, await doc.save())
      outputs.push({
        path: dest,
        name,
        mime: PDF_MIME,
        bytes: (await stat(dest)).size,
        meta: { fields: fields.length, filled: Object.keys(given).length, locked: params.flatten },
      })
      onProgress?.((index + 1) / inputs.length)
    }

    return outputs
  },
}
