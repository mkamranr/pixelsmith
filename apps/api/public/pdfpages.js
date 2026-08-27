// Page thumbnails for the PDF workspace.
//
// A PDF has no single image to preview, and most of these tools ask which pages
// to act on — so the pages are drawn here, in the browser, and clicking them
// fills in the page field. pdf.js is served from this host: there is no CDN on
// an air-gapped network.
//
// Everything here is enhancement. The form is a plain multipart POST, the page
// field can always be typed into by hand, and with this file absent the tool
// still works.
'use strict'
;(function () {
  var root = document.querySelector('[data-pdf-pages]')
  if (!root) return

  var form = root.closest('form')
  var input = form && form.querySelector('[data-file-input]')
  var grid = root.querySelector('[data-pdf-grid]')
  var hint = root.querySelector('[data-pdf-hint]')
  var actions = root.querySelector('[data-pdf-actions]')
  if (!form || !input || !grid) return

  /** Thumbnails wide enough to read a heading on, narrow enough to fit a row. */
  var THUMB_WIDTH = 150

  /**
   * A ceiling on how many pages are drawn. Rendering a thousand-page scan in
   * the browser would lock the tab up; the page field still accepts any range.
   */
  var MAX_THUMBS = 200

  var pageField = form.querySelector('[name="pages"]')
  /** Selected page numbers in the order they were clicked, which is the order
   *  a reordering tool will apply. */
  var chosen = []
  var buttons = []

  function label(count) {
    if (!chosen.length) {
      return pageField
        ? 'Click pages to choose them. Leaving none chosen uses all ' + count + '.'
        : count + (count === 1 ? ' page' : ' pages') + '.'
    }
    return chosen.length + ' of ' + count + ' chosen: ' + chosen.join(', ')
  }

  function sync(count) {
    if (pageField) pageField.value = chosen.join(',')
    buttons.forEach(function (button, index) {
      var at = chosen.indexOf(index + 1)
      button.setAttribute('aria-pressed', at === -1 ? 'false' : 'true')
      button.classList.toggle('is-chosen', at !== -1)
      var badge = button.querySelector('[data-pdf-order]')
      if (badge) {
        // The click order is shown, because for reordering it is the point.
        badge.textContent = at === -1 ? '' : String(at + 1)
        badge.hidden = at === -1
      }
    })
    if (hint) hint.textContent = label(count)
  }

  function toggle(pageNumber, count) {
    var at = chosen.indexOf(pageNumber)
    if (at === -1) chosen.push(pageNumber)
    else chosen.splice(at, 1)
    sync(count)
  }

  function thumb(pageNumber, canvas, count) {
    var item = document.createElement('li')
    item.className = 'pdf-page'

    var button = document.createElement('button')
    button.type = 'button'
    button.className = 'pdf-page-button'
    button.setAttribute('aria-pressed', 'false')
    button.setAttribute('aria-label', 'Page ' + pageNumber)
    if (!pageField) button.disabled = true

    var order = document.createElement('span')
    order.className = 'pdf-page-order'
    order.setAttribute('data-pdf-order', '')
    order.hidden = true

    var number = document.createElement('span')
    number.className = 'pdf-page-number'
    number.textContent = String(pageNumber)

    button.appendChild(canvas)
    button.appendChild(order)
    button.appendChild(number)
    button.addEventListener('click', function () {
      toggle(pageNumber, count)
    })

    item.appendChild(button)
    buttons.push(button)
    return item
  }

  function loadPdfjs() {
    return import(root.getAttribute('data-pdfjs')).then(function (pdfjs) {
      pdfjs.GlobalWorkerOptions.workerSrc = root.getAttribute('data-pdfjs-worker')
      return pdfjs
    })
  }

  function drawPage(doc, pageNumber) {
    return doc.getPage(pageNumber).then(function (page) {
      var natural = page.getViewport({ scale: 1 })
      var viewport = page.getViewport({ scale: THUMB_WIDTH / natural.width })
      var canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      canvas.className = 'pdf-page-canvas'
      return page
        .render({ canvasContext: canvas.getContext('2d'), viewport: viewport })
        .promise.then(function () {
          page.cleanup()
          return canvas
        })
    })
  }

  function reset() {
    chosen = []
    buttons = []
    grid.textContent = ''
    if (pageField) pageField.value = ''
  }

  function show(file) {
    reset()
    root.hidden = false
    if (hint) hint.textContent = 'Reading ' + file.name + '…'
    if (actions) actions.hidden = true

    file
      .arrayBuffer()
      .then(function (bytes) {
        return loadPdfjs().then(function (pdfjs) {
          return pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise
        })
      })
      .then(function (doc) {
        var count = doc.numPages
        var shown = Math.min(count, MAX_THUMBS)
        // One page at a time: rendering them all at once is what makes a
        // browser tab stop responding.
        var chain = Promise.resolve()
        for (var pageNumber = 1; pageNumber <= shown; pageNumber++) {
          chain = chain.then(
            (function (number) {
              return function () {
                return drawPage(doc, number).then(function (canvas) {
                  grid.appendChild(thumb(number, canvas, count))
                })
              }
            })(pageNumber)
          )
        }
        return chain.then(function () {
          if (actions && pageField) actions.hidden = false
          sync(count)
          if (shown < count && hint) {
            hint.textContent =
              'Showing the first ' + shown + ' of ' + count + ' pages. Type a range to use the rest.'
          }
          return doc.destroy()
        })
      })
      .catch(function () {
        // A password-protected or damaged file cannot be previewed. The server
        // will say so properly on submit; this is only the preview.
        root.hidden = true
        if (hint) hint.textContent = ''
      })

    if (actions) {
      actions.onclick = null
    }
  }

  function firstPdf(files) {
    for (var i = 0; i < files.length; i++) {
      var file = files[i]
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return file
    }
    return null
  }

  input.addEventListener('change', function () {
    var file = input.files && firstPdf(input.files)
    if (file) show(file)
    else {
      root.hidden = true
      reset()
    }
  })

  if (actions) {
    var all = actions.querySelector('[data-pdf-all]')
    var none = actions.querySelector('[data-pdf-none]')
    if (all) {
      all.addEventListener('click', function () {
        chosen = buttons.map(function (_, index) {
          return index + 1
        })
        sync(buttons.length)
      })
    }
    if (none) {
      none.addEventListener('click', function () {
        chosen = []
        sync(buttons.length)
      })
    }
  }
})()
