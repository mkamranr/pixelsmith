// Editing a document on the page itself.
//
// The page is rendered at a readable size and the edit is made on it directly:
// drag out the area to keep, move it, pull its handles. The numbers in the panel
// are the same numbers — they are what gets posted, and they stay editable — so
// with this file absent the tool still works, just by typing.
//
// Written to serve several tools. `crop` is one rectangle; `boxes` and `place`
// will hang off the same viewer.
'use strict'
;(function () {
  var form = document.querySelector('[data-pdf-edit]')
  if (!form) return

  var mode = form.getAttribute('data-pdf-edit-mode') || 'crop'
  var input = form.querySelector('[data-file-input]')
  var dropzone = form.querySelector('[data-dropzone]')
  var viewer = form.querySelector('[data-pdf-viewer]')
  var holder = form.querySelector('[data-pdf-holder]')
  var canvas = form.querySelector('[data-pdf-canvas]')
  var overlay = form.querySelector('[data-pdf-overlay]')
  var rail = form.querySelector('[data-pdf-rail]')
  var railList = form.querySelector('[data-pdf-rail-list]')
  if (!input || !canvas || !overlay) return

  var pageLabel = form.querySelector('[data-pdf-page-label]')
  var zoomLabel = form.querySelector('[data-pdf-zoom-label]')
  var nameLabel = form.querySelector('[data-pdf-name]')
  var hint = form.querySelector('[data-pdf-hint]')

  var fields = {
    x: form.querySelector('[name="x"]'),
    y: form.querySelector('[name="y"]'),
    width: form.querySelector('[name="width"]'),
    height: form.querySelector('[name="height"]'),
    pages: form.querySelector('[name="pages"]'),
  }

  var MIN_SIZE = 0.02
  var ZOOM_STEP = 1.25
  var ZOOM_MIN = 0.25
  var ZOOM_MAX = 4
  var RAIL_WIDTH = 96

  var doc = null
  var pageCount = 0
  var current = 1
  var zoom = 1
  var pdfjsPromise = null
  /** The area to keep, as fractions of the page from its top left. */
  var rect = { x: 0, y: 0, w: 1, h: 1 }
  var selection = null
  var drag = null

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value))
  }

  function round(value) {
    return Math.round(value * 10000) / 10000
  }

  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(form.getAttribute('data-pdfjs')).then(function (pdfjs) {
        pdfjs.GlobalWorkerOptions.workerSrc = form.getAttribute('data-pdfjs-worker')
        return pdfjs
      })
    }
    return pdfjsPromise
  }

  function openOptions(bytes) {
    return {
      data: new Uint8Array(bytes),
      standardFontDataUrl: form.getAttribute('data-pdfjs-fonts'),
      cMapUrl: form.getAttribute('data-pdfjs-cmaps'),
      cMapPacked: true,
    }
  }

  // ---- the numbers in the panel -------------------------------------------

  function writeFields() {
    if (fields.x) fields.x.value = String(round(rect.x))
    if (fields.y) fields.y.value = String(round(rect.y))
    if (fields.width) fields.width.value = String(round(rect.w))
    if (fields.height) fields.height.value = String(round(rect.h))
  }

  function readFields() {
    if (!fields.width || !fields.height) return
    var x = parseFloat(fields.x && fields.x.value)
    var y = parseFloat(fields.y && fields.y.value)
    var w = parseFloat(fields.width.value)
    var h = parseFloat(fields.height.value)
    if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h)) return
    rect = {
      x: clamp(x, 0, 1),
      y: clamp(y, 0, 1),
      w: clamp(w, MIN_SIZE, 1),
      h: clamp(h, MIN_SIZE, 1),
    }
    drawSelection()
  }

  function applyScope() {
    var chosen = form.querySelector('[name="pdfScope"]:checked')
    if (!fields.pages || !chosen) return
    // 'All pages' is the tool's own default: an empty selection.
    fields.pages.value = chosen.value === 'current' ? String(current) : ''
  }

  // ---- the selection over the page ----------------------------------------

  function handleAt(name) {
    var node = document.createElement('span')
    node.className = 'pdf-handle pdf-handle-' + name
    node.setAttribute('data-handle', name)
    return node
  }

  function buildSelection() {
    selection = document.createElement('div')
    selection.className = 'pdf-selection'
    selection.setAttribute('data-pdf-selection', '')
    ;['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(function (name) {
      selection.appendChild(handleAt(name))
    })
    overlay.appendChild(selection)
  }

  function drawSelection() {
    if (!selection) return
    var box = overlay.getBoundingClientRect()
    selection.style.left = (rect.x * box.width).toFixed(1) + 'px'
    selection.style.top = (rect.y * box.height).toFixed(1) + 'px'
    selection.style.width = (rect.w * box.width).toFixed(1) + 'px'
    selection.style.height = (rect.h * box.height).toFixed(1) + 'px'
  }

  function pointFrom(event) {
    var box = overlay.getBoundingClientRect()
    return {
      x: clamp((event.clientX - box.left) / box.width, 0, 1),
      y: clamp((event.clientY - box.top) / box.height, 0, 1),
    }
  }

  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return
    var handle = event.target.getAttribute && event.target.getAttribute('data-handle')
    var start = pointFrom(event)

    if (handle) {
      drag = { kind: 'resize', handle: handle, from: start, rect: Object.assign({}, rect) }
    } else if (event.target === selection) {
      drag = { kind: 'move', from: start, rect: Object.assign({}, rect) }
    } else {
      // A drag on bare page starts a fresh area.
      drag = { kind: 'create', from: start, rect: { x: start.x, y: start.y, w: 0, h: 0 } }
      rect = drag.rect
      drawSelection()
    }

    overlay.setPointerCapture && overlay.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function onPointerMove(event) {
    if (!drag) return
    var at = pointFrom(event)

    if (drag.kind === 'create') {
      rect = {
        x: Math.min(drag.from.x, at.x),
        y: Math.min(drag.from.y, at.y),
        w: Math.abs(at.x - drag.from.x),
        h: Math.abs(at.y - drag.from.y),
      }
    } else if (drag.kind === 'move') {
      var dx = at.x - drag.from.x
      var dy = at.y - drag.from.y
      rect = {
        x: clamp(drag.rect.x + dx, 0, 1 - drag.rect.w),
        y: clamp(drag.rect.y + dy, 0, 1 - drag.rect.h),
        w: drag.rect.w,
        h: drag.rect.h,
      }
    } else {
      var base = drag.rect
      var left = base.x
      var top = base.y
      var right = base.x + base.w
      var bottom = base.y + base.h
      if (drag.handle.indexOf('w') >= 0) left = Math.min(at.x, right - MIN_SIZE)
      if (drag.handle.indexOf('e') >= 0) right = Math.max(at.x, left + MIN_SIZE)
      if (drag.handle.indexOf('n') >= 0) top = Math.min(at.y, bottom - MIN_SIZE)
      if (drag.handle.indexOf('s') >= 0) bottom = Math.max(at.y, top + MIN_SIZE)
      rect = { x: left, y: top, w: right - left, h: bottom - top }
    }

    drawSelection()
    event.preventDefault()
  }

  function onPointerUp(event) {
    if (!drag) return

    /**
     * Finish from where the pointer was released, not only from the moves seen
     * along the way. A quick flick can produce a press and a release with no
     * move between them, and without this the gesture would end zero-sized and
     * be thrown away as a stray click.
     */
    if (drag.kind === 'create' && event && event.clientX !== undefined) {
      var end = pointFrom(event)
      rect = {
        x: Math.min(drag.from.x, end.x),
        y: Math.min(drag.from.y, end.y),
        w: Math.abs(end.x - drag.from.x),
        h: Math.abs(end.y - drag.from.y),
      }
    }

    drag = null
    // A stray click should not leave a sliver of a page selected.
    if (rect.w < MIN_SIZE || rect.h < MIN_SIZE) rect = { x: 0, y: 0, w: 1, h: 1 }
    rect.w = Math.min(rect.w, 1 - rect.x)
    rect.h = Math.min(rect.h, 1 - rect.y)
    drawSelection()
    writeFields()
  }

  // ---- rendering ----------------------------------------------------------

  /**
   * Fit the whole page, not just its width. A portrait page fitted to the width
   * of the workspace runs off the bottom of the screen, taking the page and zoom
   * controls with it — so the height available matters just as much.
   */
  function fitZoom(viewport) {
    var availableWidth = (viewer ? viewer.clientWidth : 800) - 24
    var availableHeight = Math.max(320, window.innerHeight - 260)
    if (availableWidth <= 0) return 1
    return clamp(
      Math.min(availableWidth / viewport.width, availableHeight / viewport.height),
      ZOOM_MIN,
      ZOOM_MAX
    )
  }

  function renderPage() {
    if (!doc) return Promise.resolve()
    return doc.getPage(current).then(function (page) {
      var natural = page.getViewport({ scale: 1 })
      var viewport = page.getViewport({ scale: zoom })
      // Draw at the screen's real density, then size it in CSS pixels, so the
      // page is not soft on a retina display.
      var density = window.devicePixelRatio || 1
      canvas.width = Math.ceil(viewport.width * density)
      canvas.height = Math.ceil(viewport.height * density)
      canvas.style.width = Math.ceil(viewport.width) + 'px'
      canvas.style.height = Math.ceil(viewport.height) + 'px'

      var context = canvas.getContext('2d')
      context.setTransform(density, 0, 0, density, 0, 0)
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, viewport.width, viewport.height)

      return page
        .render({ canvasContext: context, viewport: viewport })
        .promise.then(function () {
          page.cleanup()
          if (pageLabel) pageLabel.textContent = current + ' / ' + pageCount
          if (zoomLabel) zoomLabel.textContent = Math.round(zoom * 100) + '%'
          drawSelection()
          markRail()
          return natural
        })
    })
  }

  function markRail() {
    if (!railList) return
    Array.prototype.forEach.call(railList.querySelectorAll('[data-rail-page]'), function (node) {
      node.classList.toggle('is-current', Number(node.getAttribute('data-rail-page')) === current)
    })
  }

  function renderRail() {
    if (!railList || !doc) return Promise.resolve()
    railList.textContent = ''
    var chain = Promise.resolve()

    for (var number = 1; number <= pageCount; number++) {
      chain = chain.then(
        (function (page) {
          return function () {
            return doc.getPage(page).then(function (loaded) {
              var natural = loaded.getViewport({ scale: 1 })
              var viewport = loaded.getViewport({ scale: RAIL_WIDTH / natural.width })
              var thumb = document.createElement('canvas')
              thumb.width = Math.ceil(viewport.width)
              thumb.height = Math.ceil(viewport.height)
              return loaded
                .render({ canvasContext: thumb.getContext('2d'), viewport: viewport })
                .promise.then(function () {
                  loaded.cleanup()
                  var item = document.createElement('li')
                  var button = document.createElement('button')
                  button.type = 'button'
                  button.className = 'pdf-rail-page'
                  button.setAttribute('data-rail-page', String(page))
                  button.setAttribute('aria-label', 'Page ' + page)
                  button.appendChild(thumb)
                  var label = document.createElement('span')
                  label.textContent = String(page)
                  button.appendChild(label)
                  button.addEventListener('click', function () {
                    current = page
                    applyScope()
                    renderPage()
                  })
                  item.appendChild(button)
                  railList.appendChild(item)
                  markRail()
                })
            })
          }
        })(number)
      )
    }

    return chain
  }

  function show(file) {
    if (hint) hint.classList.remove('is-error')
    return file
      .arrayBuffer()
      .then(function (bytes) {
        return loadPdfjs().then(function (pdfjs) {
          return pdfjs.getDocument(openOptions(bytes)).promise
        })
      })
      .then(function (opened) {
        doc = opened
        pageCount = opened.numPages
        current = 1
        if (nameLabel) nameLabel.textContent = file.name
        if (dropzone) dropzone.hidden = true
        if (viewer) viewer.hidden = false
        if (rail) rail.hidden = pageCount < 2
        if (!selection) buildSelection()

        return doc.getPage(1).then(function (page) {
          zoom = fitZoom(page.getViewport({ scale: 1 }))
          page.cleanup()
          return renderPage().then(renderRail)
        })
      })
      .catch(function () {
        if (hint) {
          hint.textContent = 'That document could not be opened here. The numbers below still work.'
          hint.classList.add('is-error')
        }
        if (dropzone) dropzone.hidden = false
        if (viewer) viewer.hidden = true
      })
  }

  // ---- wiring -------------------------------------------------------------

  overlay.addEventListener('pointerdown', onPointerDown)
  overlay.addEventListener('pointermove', onPointerMove)
  overlay.addEventListener('pointerup', onPointerUp)
  overlay.addEventListener('pointercancel', onPointerUp)

  input.addEventListener('change', function () {
    var file = null
    for (var i = 0; input.files && i < input.files.length; i++) {
      var candidate = input.files[i]
      if (candidate.type === 'application/pdf' || /\.pdf$/i.test(candidate.name)) {
        file = candidate
        break
      }
    }
    if (file) show(file)
  })

  if (dropzone) {
    ;['dragenter', 'dragover'].forEach(function (name) {
      dropzone.addEventListener(name, function (event) {
        event.preventDefault()
        dropzone.classList.add('is-over')
      })
    })
    ;['dragleave', 'drop'].forEach(function (name) {
      dropzone.addEventListener(name, function () { dropzone.classList.remove('is-over') })
    })
    dropzone.addEventListener('drop', function (event) {
      if (!event.dataTransfer || !event.dataTransfer.files.length) return
      event.preventDefault()
      if (typeof DataTransfer !== 'undefined') {
        var transfer = new DataTransfer()
        Array.prototype.forEach.call(event.dataTransfer.files, function (file) {
          transfer.items.add(file)
        })
        input.files = transfer.files
      }
      show(event.dataTransfer.files[0])
    })
  }

  var prev = form.querySelector('[data-pdf-prev]')
  var next = form.querySelector('[data-pdf-next]')
  if (prev) prev.addEventListener('click', function () {
    if (current > 1) { current--; applyScope(); renderPage() }
  })
  if (next) next.addEventListener('click', function () {
    if (current < pageCount) { current++; applyScope(); renderPage() }
  })

  var zoomIn = form.querySelector('[data-pdf-zoom-in]')
  var zoomOut = form.querySelector('[data-pdf-zoom-out]')
  var fit = form.querySelector('[data-pdf-fit]')
  if (zoomIn) zoomIn.addEventListener('click', function () {
    zoom = clamp(zoom * ZOOM_STEP, ZOOM_MIN, ZOOM_MAX)
    renderPage()
  })
  if (zoomOut) zoomOut.addEventListener('click', function () {
    zoom = clamp(zoom / ZOOM_STEP, ZOOM_MIN, ZOOM_MAX)
    renderPage()
  })
  if (fit) fit.addEventListener('click', function () {
    if (!doc) return
    doc.getPage(current).then(function (page) {
      zoom = fitZoom(page.getViewport({ scale: 1 }))
      page.cleanup()
      renderPage()
    })
  })

  var reset = form.querySelector('[data-pdf-reset]')
  if (reset) reset.addEventListener('click', function () {
    rect = { x: 0, y: 0, w: 1, h: 1 }
    var all = form.querySelector('[name="pdfScope"][value="all"]')
    if (all) all.checked = true
    applyScope()
    writeFields()
    drawSelection()
  })

  Array.prototype.forEach.call(form.querySelectorAll('[name="pdfScope"]'), function (radio) {
    radio.addEventListener('change', applyScope)
  })

  // Typed numbers and dragged ones are the same numbers.
  ;['x', 'y', 'width', 'height'].forEach(function (name) {
    if (fields[name]) fields[name].addEventListener('change', readFields)
  })

  window.addEventListener('resize', drawSelection)
  writeFields()
  if (mode !== 'crop' && hint) {
    // The other interactions ride on this same viewer; until they land, the
    // fields are still the way to set them.
    hint.textContent = 'Use the numbers below for now.'
  }
})()
