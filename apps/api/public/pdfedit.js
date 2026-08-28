// Editing a document on the page itself.
//
// The page is rendered at a readable size and the edit is made on it directly.
// Two interactions ride on the same viewer, declared by the tool: `crop` is a
// single area to keep, `boxes` is any number of areas to cover.
//
// The fields in the panel hold the same values, are what actually gets posted,
// and stay editable — so with this file absent the tools still work, just by
// typing.
'use strict'
;(function () {
  var form = document.querySelector('[data-pdf-edit]')
  if (!form) return

  var mode = form.getAttribute('data-pdf-edit-mode') || 'crop'
  var isCrop = mode === 'crop'
  var isBoxes = mode === 'boxes'
  var isPlace = mode === 'place'

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
  var marksPanel = form.querySelector('[data-pdf-marks]')
  var marksList = form.querySelector('[data-pdf-marks-list]')

  var fields = {
    x: form.querySelector('[name="x"]'),
    y: form.querySelector('[name="y"]'),
    width: form.querySelector('[name="width"]'),
    height: form.querySelector('[name="height"]'),
    pages: form.querySelector('[name="pages"]'),
    regions: form.querySelector('[name="regions"]'),
    text: form.querySelector('[name="text"]'),
    kind: form.querySelector('[name="kind"]'),
    fontSize: form.querySelector('[name="fontSize"]'),
    color: form.querySelector('[name="color"]'),
    opacity: form.querySelector('[name="opacity"]'),
    rotation: form.querySelector('[name="rotation"]'),
    tiled: form.querySelector('[name="tiled"]'),
    signature: form.querySelector('[name="signatureFile"]'),
  }

  /** Whether the mark's size is ours to set, or comes from a type size. */
  var sizedByWidth = Boolean(fields.width)

  var MIN_SIZE = 0.015
  var PLACED_FONT = "'DejaVu Sans', 'Liberation Sans', Helvetica, Arial, sans-serif"
  var ZOOM_STEP = 1.25
  var ZOOM_MIN = 0.25
  var ZOOM_MAX = 4
  var RAIL_WIDTH = 96

  var doc = null
  var pageCount = 0
  var current = 1
  var zoom = 1
  var pdfjsPromise = null

  /** crop: the single area to keep, in fractions of the page. */
  var rect = { x: 0, y: 0, w: 1, h: 1 }
  var cropSelection = null

  /** place: one mark, dragged to where it belongs. */
  var placed = { x: 0.6, y: 0.8, w: 0.28 }
  var placedNode = null
  var signatureUrl = null

  /** boxes: every marked area, each carrying the page it belongs to. */
  var marks = []
  var chosen = null
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

  // ---- the fields, which are what gets posted -----------------------------

  function writeFields() {
    if (isPlace) {
      if (fields.x) fields.x.value = String(round(placed.x))
      if (fields.y) fields.y.value = String(round(placed.y))
      if (fields.width) fields.width.value = String(round(placed.w))
      return
    }

    if (isCrop) {
      if (fields.x) fields.x.value = String(round(rect.x))
      if (fields.y) fields.y.value = String(round(rect.y))
      if (fields.width) fields.width.value = String(round(rect.w))
      if (fields.height) fields.height.value = String(round(rect.h))
      return
    }

    if (fields.regions) {
      fields.regions.value = marks.length
        ? JSON.stringify(
            marks.map(function (mark) {
              return {
                page: mark.page,
                x: round(mark.x),
                y: round(mark.y),
                width: round(mark.w),
                height: round(mark.h),
              }
            })
          )
        : ''
    }
  }

  function readFields() {
    if (isPlace) {
      var px = parseFloat(fields.x && fields.x.value)
      var py = parseFloat(fields.y && fields.y.value)
      var pw = parseFloat(fields.width && fields.width.value)
      if (!isNaN(px)) placed.x = clamp(px, 0, 1)
      if (!isNaN(py)) placed.y = clamp(py, 0, 1)
      if (!isNaN(pw)) placed.w = clamp(pw, MIN_SIZE, 1)
      rebuild()
      return
    }

    if (isCrop) {
      if (!fields.width || !fields.height) return
      var x = parseFloat(fields.x && fields.x.value)
      var y = parseFloat(fields.y && fields.y.value)
      var w = parseFloat(fields.width.value)
      var h = parseFloat(fields.height.value)
      if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h)) return
      rect = { x: clamp(x, 0, 1), y: clamp(y, 0, 1), w: clamp(w, MIN_SIZE, 1), h: clamp(h, MIN_SIZE, 1) }
      layout()
      return
    }

    if (!fields.regions) return
    try {
      var parsed = JSON.parse(fields.regions.value || '[]')
      if (!Array.isArray(parsed)) return
      marks = parsed
        .filter(function (item) { return item && item.width > 0 && item.height > 0 })
        .map(function (item) {
          return {
            page: Number(item.page) || 1,
            x: clamp(Number(item.x) || 0, 0, 1),
            y: clamp(Number(item.y) || 0, 0, 1),
            w: clamp(Number(item.width) || 0, 0, 1),
            h: clamp(Number(item.height) || 0, 0, 1),
          }
        })
      chosen = null
      rebuild()
    } catch (error) {
      // A value that will not parse is left alone; the server reports it.
    }
  }

  function applyScope() {
    var picked = form.querySelector('[name="pdfScope"]:checked')
    if (!fields.pages || !picked) return
    fields.pages.value = picked.value === 'current' ? String(current) : ''
  }

  // ---- the overlay --------------------------------------------------------

  var HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

  function addHandles(node) {
    HANDLES.forEach(function (name) {
      var handle = document.createElement('span')
      handle.className = 'pdf-handle pdf-handle-' + name
      handle.setAttribute('data-handle', name)
      node.appendChild(handle)
    })
  }

  function place(node, area) {
    var box = overlay.getBoundingClientRect()
    node.style.left = (area.x * box.width).toFixed(1) + 'px'
    node.style.top = (area.y * box.height).toFixed(1) + 'px'
    node.style.width = (area.w * box.width).toFixed(1) + 'px'
    node.style.height = (area.h * box.height).toFixed(1) + 'px'
  }

  /** Is the mark tiled across the page, in which case its position is moot? */
  function tiling() {
    return Boolean(fields.tiled && fields.tiled.checked)
  }

  /** The words the mark shows, if it is made of words. */
  /**
   * The value of a field that may be a radio group.
   *
   * `kind` is a segmented control, which is a set of radios sharing a name, so
   * querySelector returns the FIRST one — whose value is 'image' whether or not
   * it is the one chosen. Reading it directly meant a typed signature always
   * looked like no signature, and the page said "Nothing to place yet" beside a
   * perfectly good name.
   */
  function valueOf(name) {
    var checked = form.querySelector('[name="' + name + '"]:checked')
    if (checked) return checked.value
    var single = form.querySelector('[name="' + name + '"]')
    return single ? single.value : ''
  }

  function markText() {
    if (valueOf('kind') === 'image') return ''
    return (fields.text && fields.text.value) || ''
  }

  /** Families for the handwriting faces, matching what the server draws with. */
  var FACE_FAMILY = {
    'great-vibes': "'Great Vibes', cursive",
    'dancing-script': "'Dancing Script', cursive",
    caveat: "'Caveat', cursive",
  }
  var INK_COLOUR = { black: '#1a1a1f', blue: '#17308c', red: '#992020', green: '#155c31' }

  function buildPlaced() {
    var node = document.createElement('div')
    node.className = 'pdf-placed'
    node.setAttribute('data-pdf-placed', '')

    if (signatureUrl) {
      var image = document.createElement('img')
      image.src = signatureUrl
      image.alt = ''
      node.appendChild(image)
    } else {
      var span = document.createElement('span')
      span.className = 'pdf-placed-text'
      span.textContent = markText() || 'Nothing to place yet'
      if (!markText()) node.classList.add('is-empty')
      // Shown in the hand and the ink that will actually be used, so what is
      // being positioned looks like what ends up on the page.
      var face = FACE_FAMILY[valueOf('face')]
      if (markText() && face) span.style.fontFamily = face
      var ink = INK_COLOUR[valueOf('colour')]
      if (markText() && ink) span.style.color = ink
      node.appendChild(span)
    }

    // Only resizable when the tool has a width of its own to set. A watermark
    // is sized by its type size instead, which belongs in the panel.
    if (sizedByWidth) addHandles(node)
    overlay.appendChild(node)
    return node
  }

  /** Show the mark as it will come out: colour, fade and angle included. */
  function stylePlaced(node) {
    var box = overlay.getBoundingClientRect()
    node.style.left = (placed.x * box.width).toFixed(1) + 'px'
    node.style.top = (placed.y * box.height).toFixed(1) + 'px'
    node.style.width = sizedByWidth ? (placed.w * box.width).toFixed(1) + 'px' : 'auto'

    var span = node.querySelector('.pdf-placed-text')
    if (span) {
      if (sizedByWidth) {
        // Set to span the width, which is what the server does with a name.
        span.style.fontSize = fitFontSize(span.textContent, placed.w * box.width) + 'px'
      } else {
        // Points map to CSS pixels through the current zoom, so a type size
        // previews at exactly the size it will print.
        var points = parseFloat(fields.fontSize && fields.fontSize.value)
        if (isNaN(points)) points = Math.max(18, (box.width / zoom) / 12)
        span.style.fontSize = (points * zoom).toFixed(1) + 'px'
      }
      if (fields.color) span.style.color = fields.color.value
    }

    var opacity = parseFloat(fields.opacity && fields.opacity.value)
    node.style.opacity = isNaN(opacity) ? '1' : String(clamp(opacity / 100, 0.05, 1))

    var angle = parseFloat(fields.rotation && fields.rotation.value)
    node.style.transform = isNaN(angle) ? 'none' : 'rotate(' + -angle + 'deg)'
    node.style.transformOrigin = 'left bottom'
  }

  var ruler = null

  /** The type size at which the given words span a width. */
  function fitFontSize(text, targetWidth) {
    if (!text || targetWidth <= 0) return 12
    if (!ruler) ruler = document.createElement('canvas').getContext('2d')
    var reference = 100
    ruler.font = 'italic ' + reference + 'px ' + PLACED_FONT
    var measured = ruler.measureText(text).width
    if (!measured) return 12
    return clamp((targetWidth / measured) * reference, 6, 400)
  }

  /** Rebuild the overlay's contents. Called when the set of areas changes. */
  function rebuild() {
    overlay.textContent = ''

    if (isPlace) {
      placedNode = null
      if (tiling()) {
        var note = document.createElement('p')
        note.className = 'pdf-tiled-note'
        note.textContent = 'Tiled across the whole page'
        overlay.appendChild(note)
        return
      }
      placedNode = buildPlaced()
      layout()
      return
    }

    if (isCrop) {
      cropSelection = document.createElement('div')
      cropSelection.className = 'pdf-selection'
      cropSelection.setAttribute('data-pdf-selection', '')
      addHandles(cropSelection)
      overlay.appendChild(cropSelection)
      layout()
      return
    }

    marks.forEach(function (mark) {
      mark.node = null
      if (mark.page !== current) return

      var node = document.createElement('div')
      node.className = 'pdf-mark' + (mark === chosen ? ' is-chosen' : '')
      node.setAttribute('data-pdf-mark', '')

      if (mark === chosen) {
        addHandles(node)
        var drop = document.createElement('button')
        drop.type = 'button'
        drop.className = 'pdf-mark-drop'
        drop.setAttribute('data-mark-drop', '')
        drop.setAttribute('aria-label', 'Remove this area')
        drop.textContent = '×'
        node.appendChild(drop)
      }

      mark.node = node
      overlay.appendChild(node)
    })

    layout()
    renderMarksList()
  }

  /** Reposition what is already there, after a zoom or a window resize. */
  function layout() {
    if (isPlace) {
      if (placedNode) stylePlaced(placedNode)
      return
    }

    if (isCrop) {
      if (cropSelection) place(cropSelection, rect)
      return
    }
    marks.forEach(function (mark) {
      if (mark.node) place(mark.node, mark)
    })
  }

  function renderMarksList() {
    if (!marksList || !marksPanel) return
    marksPanel.hidden = marks.length === 0
    marksList.textContent = ''

    marks.forEach(function (mark, index) {
      var item = document.createElement('li')
      item.className = 'pdf-marks-item' + (mark === chosen ? ' is-chosen' : '')

      var jump = document.createElement('button')
      jump.type = 'button'
      jump.className = 'pdf-marks-jump'
      jump.textContent = 'Page ' + mark.page
      jump.addEventListener('click', function () {
        chosen = mark
        if (mark.page !== current) {
          current = mark.page
          renderPage().then(rebuild)
        } else {
          rebuild()
        }
      })

      var drop = document.createElement('button')
      drop.type = 'button'
      drop.className = 'pdf-marks-remove'
      drop.setAttribute('aria-label', 'Remove area ' + (index + 1))
      drop.textContent = '×'
      drop.addEventListener('click', function () { remove(mark) })

      item.appendChild(jump)
      item.appendChild(drop)
      marksList.appendChild(item)
    })
  }

  function remove(mark) {
    var at = marks.indexOf(mark)
    if (at === -1) return
    marks.splice(at, 1)
    if (chosen === mark) chosen = null
    writeFields()
    rebuild()
  }

  function pointFrom(event) {
    var box = overlay.getBoundingClientRect()
    return {
      x: clamp((event.clientX - box.left) / box.width, 0, 1),
      y: clamp((event.clientY - box.top) / box.height, 0, 1),
    }
  }

  /**
   * How much of the page the placed mark actually covers.
   *
   * Measured from the element, not from the width field: a watermark has no
   * width of its own — its size comes from its type size — so the field says
   * nothing useful and a mark clamped by it wanders off the page edge.
   */
  function placedSpan() {
    if (!placedNode) return { w: 0, h: 0 }
    var box = overlay.getBoundingClientRect()
    if (!box.width || !box.height) return { w: 0, h: 0 }
    return {
      w: Math.min(1, placedNode.offsetWidth / box.width),
      h: Math.min(1, placedNode.offsetHeight / box.height),
    }
  }

  /** The area a gesture is acting on. */
  function target() {
    if (isPlace) return placed
    return isCrop ? rect : chosen
  }

  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return

    if (event.target.getAttribute && event.target.getAttribute('data-mark-drop') !== null) {
      var owner = null
      marks.forEach(function (mark) {
        if (mark.node && mark.node.contains(event.target)) owner = mark
      })
      if (owner) remove(owner)
      event.preventDefault()
      return
    }

    var handle = event.target.getAttribute && event.target.getAttribute('data-handle')
    var start = pointFrom(event)

    if (handle && target()) {
      drag = { kind: 'resize', handle: handle, from: start, base: copy(target()) }
    } else if (!isCrop && onMark(event.target)) {
      chosen = onMark(event.target)
      rebuild()
      drag = { kind: 'move', from: start, base: copy(chosen) }
    } else if (isCrop && event.target === cropSelection) {
      drag = { kind: 'move', from: start, base: copy(rect) }
    } else if (isPlace) {
      // Nothing to create: there is one mark, and it is already on the page.
      // A drag from the mark itself moves it; bare page is left alone.
      if (placedNode && placedNode.contains(event.target)) {
        drag = { kind: 'move', from: start, base: copy(placed) }
      } else {
        return
      }
    } else {
      // A drag on bare page starts a new area.
      if (isCrop) {
        rect = { x: start.x, y: start.y, w: 0, h: 0 }
      } else {
        chosen = { page: current, x: start.x, y: start.y, w: 0, h: 0, node: null }
        marks.push(chosen)
        rebuild()
      }
      drag = { kind: 'create', from: start, base: copy(target()) }
    }

    if (overlay.setPointerCapture) overlay.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function copy(area) {
    return area ? { x: area.x, y: area.y, w: area.w, h: area.h } : null
  }

  function onMark(node) {
    var found = null
    marks.forEach(function (mark) {
      if (mark.node && (mark.node === node || mark.node.contains(node))) found = mark
    })
    return found
  }

  function shape(from, to) {
    return {
      x: Math.min(from.x, to.x),
      y: Math.min(from.y, to.y),
      w: Math.abs(to.x - from.x),
      h: Math.abs(to.y - from.y),
    }
  }

  function assign(area, next) {
    area.x = next.x
    area.y = next.y
    area.w = next.w
    area.h = next.h
  }

  function onPointerMove(event) {
    if (!drag) return
    var area = target()
    if (!area) return
    var at = pointFrom(event)

    if (drag.kind === 'create') {
      assign(area, shape(drag.from, at))
    } else if (drag.kind === 'move') {
      var measured = isPlace ? placedSpan() : null
      var spanW = measured ? measured.w : drag.base.w || 0
      var spanH = measured ? measured.h : drag.base.h || 0
      assign(area, {
        x: clamp(drag.base.x + (at.x - drag.from.x), 0, Math.max(0, 1 - spanW)),
        y: clamp(drag.base.y + (at.y - drag.from.y), 0, Math.max(0, 1 - spanH)),
        w: drag.base.w,
        h: drag.base.h,
      })
    } else if (isPlace) {
      var edge = drag.handle.indexOf('w') >= 0 ? 'left' : 'right'
      var right = drag.base.x + drag.base.w
      if (edge === 'left') {
        var newLeft = Math.min(at.x, right - MIN_SIZE)
        area.x = clamp(newLeft, 0, 1)
        area.w = right - area.x
      } else {
        area.w = clamp(at.x - area.x, MIN_SIZE, 1 - area.x)
      }
    } else {
      var left = drag.base.x
      var top = drag.base.y
      var right = drag.base.x + drag.base.w
      var bottom = drag.base.y + drag.base.h
      if (drag.handle.indexOf('w') >= 0) left = Math.min(at.x, right - MIN_SIZE)
      if (drag.handle.indexOf('e') >= 0) right = Math.max(at.x, left + MIN_SIZE)
      if (drag.handle.indexOf('n') >= 0) top = Math.min(at.y, bottom - MIN_SIZE)
      if (drag.handle.indexOf('s') >= 0) bottom = Math.max(at.y, top + MIN_SIZE)
      assign(area, { x: left, y: top, w: right - left, h: bottom - top })
    }

    layout()
    event.preventDefault()
  }

  function onPointerUp(event) {
    if (!drag) return
    var area = target()

    /**
     * Finish from where the pointer was released, not only from the moves seen
     * along the way. A quick flick can produce a press and a release with no
     * move between them, and without this the gesture would end zero-sized and
     * be thrown away as a stray click.
     */
    if (drag.kind === 'create' && area && event && event.clientX !== undefined) {
      assign(area, shape(drag.from, pointFrom(event)))
    }

    var wasCreate = drag.kind === 'create'
    drag = null
    if (!area) return

    if (isPlace) {
      area.w = clamp(area.w, MIN_SIZE, 1)
      writeFields()
      layout()
      return
    }

    var tooSmall = area.w < MIN_SIZE || area.h < MIN_SIZE
    if (tooSmall) {
      // A stray click should not leave a sliver behind.
      if (isCrop) {
        rect = { x: 0, y: 0, w: 1, h: 1 }
      } else if (wasCreate) {
        remove(area)
        return
      }
    }

    area.w = Math.min(area.w, 1 - area.x)
    area.h = Math.min(area.h, 1 - area.y)
    writeFields()
    if (isBoxes) rebuild()
    else layout()
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

      return page.render({ canvasContext: context, viewport: viewport }).promise.then(function () {
        page.cleanup()
        if (pageLabel) pageLabel.textContent = current + ' / ' + pageCount
        if (zoomLabel) zoomLabel.textContent = Math.round(zoom * 100) + '%'
        markRail()
        /**
         * Announced so a mode that draws its own things on the page — placing
         * words, boxes and pictures — knows which page is on screen and how
         * large it came out, without reaching into this file's state.
         */
        document.dispatchEvent(
          new CustomEvent('pixelsmith:pdfpage', {
            detail: { page: current, pages: pageCount, width: viewport.width, height: viewport.height },
          }),
        )
      })
    })
  }

  function markRail() {
    if (!railList) return
    Array.prototype.forEach.call(railList.querySelectorAll('[data-rail-page]'), function (node) {
      node.classList.toggle('is-current', Number(node.getAttribute('data-rail-page')) === current)
    })
  }

  function goTo(page) {
    current = clamp(page, 1, pageCount)
    applyScope()
    return renderPage().then(rebuild)
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
                  button.addEventListener('click', function () { goTo(page) })
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
        // The scope radio is set from the start, so the field it drives has to
        // be too: 'This page' showing while the value still said otherwise.
        applyScope()
        if (nameLabel) nameLabel.textContent = file.name
        if (dropzone) dropzone.hidden = true
        if (viewer) viewer.hidden = false
        if (rail) rail.hidden = pageCount < 2

        return doc.getPage(1).then(function (page) {
          zoom = fitZoom(page.getViewport({ scale: 1 }))
          page.cleanup()
          return renderPage().then(function () {
            rebuild()
            return renderRail()
          })
        })
      })
      .catch(function () {
        if (hint) {
          hint.textContent = 'That document could not be opened here. The fields below still work.'
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

  document.addEventListener('keydown', function (event) {
    if (!isBoxes || !chosen) return
    if (event.key !== 'Delete' && event.key !== 'Backspace') return
    var tag = document.activeElement && document.activeElement.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    remove(chosen)
    event.preventDefault()
  })

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
  if (prev) prev.addEventListener('click', function () { goTo(current - 1) })
  if (next) next.addEventListener('click', function () { goTo(current + 1) })

  var zoomIn = form.querySelector('[data-pdf-zoom-in]')
  var zoomOut = form.querySelector('[data-pdf-zoom-out]')
  var fit = form.querySelector('[data-pdf-fit]')
  if (zoomIn) zoomIn.addEventListener('click', function () {
    zoom = clamp(zoom * ZOOM_STEP, ZOOM_MIN, ZOOM_MAX)
    renderPage().then(layout)
  })
  if (zoomOut) zoomOut.addEventListener('click', function () {
    zoom = clamp(zoom / ZOOM_STEP, ZOOM_MIN, ZOOM_MAX)
    renderPage().then(layout)
  })
  if (fit) fit.addEventListener('click', function () {
    if (!doc) return
    doc.getPage(current).then(function (page) {
      zoom = fitZoom(page.getViewport({ scale: 1 }))
      page.cleanup()
      renderPage().then(layout)
    })
  })

  var reset = form.querySelector('[data-pdf-reset]')
  if (reset) reset.addEventListener('click', function () {
    if (isPlace) {
      placed = { x: 0.6, y: 0.8, w: 0.28 }
      writeFields()
      rebuild()
      return
    }
    if (isCrop) {
      rect = { x: 0, y: 0, w: 1, h: 1 }
      var all = form.querySelector('[name="pdfScope"][value="all"]')
      if (all) all.checked = true
      applyScope()
    } else {
      marks = []
      chosen = null
    }
    writeFields()
    rebuild()
  })

  Array.prototype.forEach.call(form.querySelectorAll('[name="pdfScope"]'), function (radio) {
    radio.addEventListener('change', applyScope)
  })

  // Typed values and dragged ones are the same values.
  ;['x', 'y', 'width', 'height', 'regions'].forEach(function (name) {
    if (fields[name]) fields[name].addEventListener('change', readFields)
  })

  // The preview shows the mark as it will come out, so it follows the settings.
  if (isPlace) {
    ;['text', 'kind', 'fontSize', 'color', 'opacity', 'rotation', 'tiled'].forEach(function (name) {
      if (!fields[name]) return
      fields[name].addEventListener('input', rebuild)
      fields[name].addEventListener('change', rebuild)
    })

    if (fields.signature) {
      fields.signature.addEventListener('change', function () {
        if (signatureUrl) URL.revokeObjectURL(signatureUrl)
        var file = fields.signature.files && fields.signature.files[0]
        signatureUrl = file ? URL.createObjectURL(file) : null
        rebuild()
      })
    }
  }

  window.addEventListener('resize', layout)
  readFields()
  writeFields()
})()
