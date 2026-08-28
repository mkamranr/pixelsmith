// Filling in a form's own boxes.
//
// The fields belong to the document, not to the tool: a form asks what it asks.
// So they are read out of the uploaded PDF and offered as ordinary inputs, and
// what you type is collected into the one field the tool declares.
//
// Two halves on purpose. Reading the document needs pdf.js and a real file;
// turning a list of fields into inputs needs neither. They meet at a
// `pixelsmith:formfields` event, which is also how the second half is tested
// without the first.
'use strict'
;(function () {
  var root = document.querySelector('[data-form-fill]')
  if (!root) return

  var form = root.closest('form')
  var list = root.querySelector('[data-form-fields]')
  var status = root.querySelector('[data-form-status]')
  var field = form && form.querySelector('[name="values"]')
  if (!form || !list || !field) return

  var answers = Object.create(null)

  function say(message) {
    if (status) status.textContent = message
  }

  function write() {
    var given = Object.create(null)
    var count = 0
    Object.keys(answers).forEach(function (name) {
      var value = answers[name]
      // An untouched text box is not an answer: sending '' would blank a field
      // the form came with filled in.
      if (value === '' || value === null || value === undefined) return
      given[name] = value
      count += 1
    })

    field.value = count ? JSON.stringify(given) : ''
    say(count ? count + (count === 1 ? ' box filled' : ' boxes filled') : '')
  }

  function label(text, control, id) {
    var wrapper = document.createElement('div')
    wrapper.className = 'field'
    var name = document.createElement('label')
    name.setAttribute('for', id)
    name.textContent = text
    wrapper.appendChild(name)
    wrapper.appendChild(control)
    return wrapper
  }

  /**
   * One control per field, of the kind the field actually is. A dropdown gets a
   * dropdown with the document's own options: typing an answer a form cannot
   * accept is a mistake worth making impossible rather than reporting later.
   */
  function controlFor(spec, index) {
    var id = 'ff-' + index
    var name = spec.name

    if (spec.kind === 'check') {
      var box = document.createElement('input')
      box.type = 'checkbox'
      box.id = id
      box.checked = spec.value === true
      if (box.checked) answers[name] = true
      box.addEventListener('change', function () {
        answers[name] = box.checked
        write()
      })
      var toggle = label(spec.label || name, box, id)
      toggle.className = 'field field-toggle'
      return toggle
    }

    if ((spec.kind === 'choice' || spec.kind === 'radio') && (spec.options || []).length) {
      var select = document.createElement('select')
      select.id = id
      var blank = document.createElement('option')
      blank.value = ''
      blank.textContent = '—'
      select.appendChild(blank)
      spec.options.forEach(function (option) {
        var node = document.createElement('option')
        node.value = option
        node.textContent = option
        select.appendChild(node)
      })
      if (spec.value) {
        select.value = String(spec.value)
        answers[name] = String(spec.value)
      }
      select.addEventListener('change', function () {
        answers[name] = select.value
        write()
      })
      return label(spec.label || name, select, id)
    }

    var input = document.createElement('input')
    input.type = 'text'
    input.id = id
    if (spec.value) {
      input.value = String(spec.value)
      answers[name] = String(spec.value)
    }
    input.addEventListener('input', function () {
      answers[name] = input.value
      write()
    })
    return label(spec.label || name, input, id)
  }

  function render(fields) {
    list.textContent = ''
    answers = Object.create(null)

    if (!fields.length) {
      // write() last would clear this: it sets the status to the number filled,
      // which is none.
      write()
      say('This document has no form fields in it, so there is nothing to fill in.')
      return
    }

    fields.forEach(function (spec, index) {
      if (!spec || !spec.name) return
      list.appendChild(controlFor(spec, index))
    })
    root.hidden = false
    write()
  }

  document.addEventListener('pixelsmith:formfields', function (event) {
    render((event.detail && event.detail.fields) || [])
  })

  // ---- reading the document -----------------------------------------------

  var fileInput = form.querySelector('[data-file-input]')
  if (!fileInput) return

  function loadPdfjs() {
    return import(root.getAttribute('data-pdfjs')).then(function (pdfjs) {
      pdfjs.GlobalWorkerOptions.workerSrc = root.getAttribute('data-pdfjs-worker')
      return pdfjs
    })
  }

  /**
   * pdf.js reports form fields as widget annotations. The shapes differ by kind:
   * `Tx` is text, `Ch` a list, and `Btn` is either a checkbox or one option of a
   * radio group — the group is assembled from the options that share a name.
   */
  function fieldsOf(doc) {
    var found = []
    var seen = Object.create(null)
    var chain = Promise.resolve()

    for (var number = 1; number <= doc.numPages; number += 1) {
      chain = chain.then(
        (function (pageNumber) {
          return function () {
            return doc.getPage(pageNumber).then(function (page) {
              return page.getAnnotations({ intent: 'any' }).then(function (annotations) {
                annotations.forEach(function (item) {
                  if (item.subtype !== 'Widget' || !item.fieldName) return
                  var name = item.fieldName

                  if (item.fieldType === 'Btn' && item.radioButton) {
                    if (!seen[name]) {
                      seen[name] = { name: name, kind: 'radio', options: [], value: item.fieldValue || '' }
                      found.push(seen[name])
                    }
                    if (item.buttonValue && seen[name].options.indexOf(item.buttonValue) === -1) {
                      seen[name].options.push(item.buttonValue)
                    }
                    return
                  }

                  if (seen[name]) return

                  if (item.fieldType === 'Btn') {
                    seen[name] = { name: name, kind: 'check', value: item.fieldValue === 'Off' ? false : Boolean(item.fieldValue) }
                  } else if (item.fieldType === 'Ch') {
                    seen[name] = {
                      name: name,
                      kind: 'choice',
                      options: (item.options || []).map(function (option) {
                        return option.exportValue || option.displayValue
                      }),
                      value: item.fieldValue || '',
                    }
                  } else {
                    seen[name] = { name: name, kind: 'text', value: item.fieldValue || '' }
                  }
                  found.push(seen[name])
                })
              })
            })
          }
        })(number),
      )
    }

    return chain.then(function () {
      return found
    })
  }

  function readStaged() {
    var file = fileInput.files && fileInput.files[0]
    if (!file) return
    say('Looking for the boxes…')

    file
      .arrayBuffer()
      .then(function (bytes) {
        return loadPdfjs().then(function (pdfjs) {
          return pdfjs.getDocument({
            data: new Uint8Array(bytes),
            standardFontDataUrl: root.getAttribute('data-pdfjs-fonts'),
            cMapUrl: root.getAttribute('data-pdfjs-cmaps'),
          }).promise
        })
      })
      .then(fieldsOf)
      .then(function (fields) {
        document.dispatchEvent(
          new CustomEvent('pixelsmith:formfields', { detail: { fields: fields } }),
        )
      })
      .catch(function () {
        // The tool still works for a script that knows the field names, and the
        // document may simply not be readable here.
        say('The boxes in this document could not be read here.')
      })
  }

  fileInput.addEventListener('change', readStaged)
  if (fileInput.files && fileInput.files.length) readStaged()
})()
