// Interactive crop.
//
// The numeric fields are the real form inputs and remain authoritative — the
// page works without this script. What this adds is the thing numbers cannot
// tell you: whether the rectangle is over the right part of the picture.
'use strict'
;(function () {
  var form = document.querySelector('form[data-cropper]')
  if (!form) return

  var input = form.querySelector('[data-file-input]')
  var stage = form.querySelector('[data-stage]')
  var workspace = form.querySelector('[data-crop-workspace]')
  var viewport = form.querySelector('[data-viewport]')
  var image = form.querySelector('[data-crop-image]')
  var selection = form.querySelector('[data-selection]')
  var shade = form.querySelector('[data-shade]')
  var sizeLabel = form.querySelector('[data-size-label]')
  var filmstrip = form.querySelector('[data-filmstrip]')
  var head = form.querySelector('[data-stage-head]')
  var hint = form.querySelector('[data-crop-hint]')
  var boundsNote = form.querySelector('[data-bounds-note]')

  var fields = {
    x: form.querySelector('[data-crop-field="x"]'),
    y: form.querySelector('[data-crop-field="y"]'),
    width: form.querySelector('[data-crop-field="width"]'),
    height: form.querySelector('[data-crop-field="height"]'),
  }

  var files = []
  var active = 0
  // Selection in SOURCE pixels, which is what the server is given.
  var rect = { x: 0, y: 0, width: 0, height: 0 }
  var natural = { width: 0, height: 0 }
  var ratio = null // locked aspect, or null for free

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value))
  }

  /** Pixels per source pixel, i.e. how much the preview is scaled down. */
  function scale() {
    var box = image.getBoundingClientRect()
    return natural.width ? box.width / natural.width : 1
  }

  function loadFiles(list) {
    files.forEach(function (f) { URL.revokeObjectURL(f.url) })
    files = Array.prototype.map.call(list, function (file) {
      return { file: file, url: URL.createObjectURL(file) }
    })
    if (!files.length) return

    stage.classList.add('has-files')
    workspace.hidden = false
    if (head) head.hidden = false

    var count = form.querySelector('[data-file-count]')
    if (count) count.textContent = String(files.length)
    var noun = form.querySelector('[data-file-noun]')
    if (noun) noun.textContent = files.length === 1 ? 'image' : 'images'
    var same = form.querySelector('[data-same-rect]')
    if (same) same.hidden = files.length < 2

    renderFilmstrip()
    show(0)
  }

  function show(index) {
    active = index
    image.src = files[index].url
    renderFilmstrip()
  }

  function renderFilmstrip() {
    if (!filmstrip) return
    filmstrip.hidden = files.length < 2
    filmstrip.innerHTML = ''
    files.forEach(function (entry, index) {
      var li = document.createElement('li')
      li.className = 'film' + (index === active ? ' is-active' : '')
      var img = document.createElement('img')
      img.src = entry.url
      img.alt = entry.file.name
      li.appendChild(img)
      li.title = entry.file.name
      li.addEventListener('click', function () { show(index) })
      filmstrip.appendChild(li)
    })
  }

  input.addEventListener('change', function () { loadFiles(input.files) })

  var addMore = form.querySelector('[data-add-more]')
  if (addMore) addMore.addEventListener('click', function () { input.click() })

  var selectAll = form.querySelector('[data-select-all]')
  if (selectAll) {
    selectAll.addEventListener('click', function () {
      rect = { x: 0, y: 0, width: natural.width, height: natural.height }
      syncFields()
      draw()
    })
  }

  ;['dragenter', 'dragover'].forEach(function (name) {
    stage.addEventListener(name, function (e) { e.preventDefault() })
  })
  stage.addEventListener('drop', function (e) {
    e.preventDefault()
    if (!e.dataTransfer || !e.dataTransfer.files.length) return
    if (typeof DataTransfer !== 'undefined') {
      var transfer = new DataTransfer()
      Array.prototype.forEach.call(e.dataTransfer.files, function (f) { transfer.items.add(f) })
      input.files = transfer.files
    }
    loadFiles(e.dataTransfer.files)
  })

  image.addEventListener('load', function () {
    natural = { width: image.naturalWidth, height: image.naturalHeight }
    // Default to a centred rectangle covering most of the frame, so there is
    // something to grab immediately rather than an invisible zero-size box.
    if (!rect.width || !rect.height) {
      var w = Math.round(natural.width * 0.8)
      var h = Math.round(natural.height * 0.8)
      rect = { x: Math.round((natural.width - w) / 2), y: Math.round((natural.height - h) / 2), width: w, height: h }
    }
    constrain()
    syncFields()
    draw()
  })

  // ---- numeric fields drive the selection ----

  Object.keys(fields).forEach(function (key) {
    if (!fields[key]) return
    fields[key].addEventListener('input', function () {
      var value = Math.round(Number(fields[key].value))
      if (!isFinite(value)) return
      rect[key] = value
      constrain()
      draw()
      // Write back, so a value that had to be clamped is visible rather than
      // silently different from what the user typed.
      syncFields(key)
    })
  })

  function syncFields(skip) {
    Object.keys(fields).forEach(function (key) {
      if (!fields[key] || key === skip) return
      fields[key].value = String(Math.round(rect[key]))
    })
    if (fields.x) fields.x.max = String(Math.max(0, natural.width - 1))
    if (fields.y) fields.y.max = String(Math.max(0, natural.height - 1))
    if (fields.width) fields.width.max = String(natural.width)
    if (fields.height) fields.height.max = String(natural.height)
  }

  /** Keep the rectangle inside the image, and on ratio if one is locked. */
  function constrain() {
    if (!natural.width) return
    rect.width = clamp(Math.round(rect.width), 1, natural.width)
    rect.height = clamp(Math.round(rect.height), 1, natural.height)

    if (ratio) {
      // Height follows width, unless that would overflow the image.
      var height = Math.round(rect.width / ratio)
      if (height > natural.height) {
        height = natural.height
        rect.width = Math.round(height * ratio)
      }
      rect.height = height
    }

    rect.x = clamp(Math.round(rect.x), 0, natural.width - rect.width)
    rect.y = clamp(Math.round(rect.y), 0, natural.height - rect.height)
  }

  // ---- aspect ratio presets ----

  var ratios = form.querySelector('[data-ratios]')
  if (ratios) {
    ratios.addEventListener('click', function (event) {
      var button = event.target.closest('[data-ratio]')
      if (!button) return
      Array.prototype.forEach.call(ratios.querySelectorAll('[data-ratio]'), function (b) {
        b.classList.toggle('is-active', b === button)
      })
      var value = button.getAttribute('data-ratio')
      ratio = value === 'free' ? null : Number(value)
      constrain()
      syncFields()
      draw()
    })
  }

  // ---- dragging ----

  var drag = null

  function pointerToSource(event) {
    var box = image.getBoundingClientRect()
    var s = scale()
    return {
      x: (event.clientX - box.left) / s,
      y: (event.clientY - box.top) / s,
    }
  }

  viewport.addEventListener('pointerdown', function (event) {
    if (!natural.width) return
    var handle = event.target.getAttribute && event.target.getAttribute('data-handle')
    var start = pointerToSource(event)

    if (handle) {
      drag = { mode: 'resize', handle: handle, start: start, origin: Object.assign({}, rect) }
    } else if (event.target === selection || selection.contains(event.target)) {
      drag = { mode: 'move', start: start, origin: Object.assign({}, rect) }
    } else if (event.target === image || event.target === shade) {
      // Starting on the picture draws a fresh rectangle.
      drag = { mode: 'draw', start: start, origin: Object.assign({}, rect) }
      rect = { x: Math.round(start.x), y: Math.round(start.y), width: 1, height: 1 }
    } else {
      return
    }

    viewport.setPointerCapture(event.pointerId)
    event.preventDefault()
  })

  viewport.addEventListener('pointermove', function (event) {
    if (!drag) return
    var now = pointerToSource(event)
    var dx = now.x - drag.start.x
    var dy = now.y - drag.start.y

    if (drag.mode === 'move') {
      rect.x = drag.origin.x + dx
      rect.y = drag.origin.y + dy
    } else if (drag.mode === 'draw') {
      rect.x = Math.min(drag.start.x, now.x)
      rect.y = Math.min(drag.start.y, now.y)
      rect.width = Math.abs(dx)
      rect.height = Math.abs(dy)
    } else {
      resizeByHandle(drag.handle, drag.origin, dx, dy)
    }

    constrain()
    syncFields()
    draw()
  })

  viewport.addEventListener('pointerup', function () {
    if (drag && drag.mode === 'draw' && (rect.width < 8 || rect.height < 8)) {
      // Treat a stray click as "no change" rather than a useless sliver.
      rect = drag.origin
      constrain()
      syncFields()
      draw()
    }
    drag = null
  })

  function resizeByHandle(handle, origin, dx, dy) {
    var right = origin.x + origin.width
    var bottom = origin.y + origin.height

    if (handle.indexOf('w') > -1) {
      rect.x = clamp(origin.x + dx, 0, right - 1)
      rect.width = right - rect.x
    }
    if (handle.indexOf('e') > -1) {
      rect.width = clamp(origin.width + dx, 1, natural.width - origin.x)
    }
    if (handle.indexOf('n') > -1) {
      rect.y = clamp(origin.y + dy, 0, bottom - 1)
      rect.height = bottom - rect.y
    }
    if (handle.indexOf('s') > -1) {
      rect.height = clamp(origin.height + dy, 1, natural.height - origin.y)
    }
  }

  // ---- drawing ----

  function draw() {
    if (!natural.width) return
    var s = scale()
    var box = image.getBoundingClientRect()
    var frame = viewport.getBoundingClientRect()
    var offsetX = box.left - frame.left
    var offsetY = box.top - frame.top

    selection.hidden = false
    shade.hidden = false
    shade.style.left = offsetX + 'px'
    shade.style.top = offsetY + 'px'
    shade.style.width = box.width + 'px'
    shade.style.height = box.height + 'px'

    selection.style.left = offsetX + rect.x * s + 'px'
    selection.style.top = offsetY + rect.y * s + 'px'
    selection.style.width = rect.width * s + 'px'
    selection.style.height = rect.height * s + 'px'

    if (sizeLabel) sizeLabel.textContent = Math.round(rect.width) + ' × ' + Math.round(rect.height)
    if (hint) {
      hint.textContent =
        'Source ' + natural.width + ' × ' + natural.height +
        ' — drag the box or its corners, or type exact numbers.'
    }

    if (boundsNote) {
      // Warn when the rectangle cannot apply to every image in the batch: the
      // server refuses an out-of-bounds crop rather than silently clamping it.
      var tooBig = files.length > 1
      boundsNote.textContent = tooBig
        ? 'The same area is cropped from every image. Any image smaller than this area will be refused.'
        : ''
    }
  }

  window.addEventListener('resize', draw)
})()
