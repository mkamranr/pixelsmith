// Photo editor.
//
// The browser previews edits with CSS filters and an SVG overlay; it never
// decodes the full-resolution image. What it produces is a RECIPE — an ordered
// list of operations the server replays at full size through the same
// primitives the batch tools use. One implementation of each transform, and a
// 60-megapixel TIFF never enters a canvas.
//
// The overlay's viewBox is the image's own pixel dimensions, so the coordinates
// drawn here are the same numbers the server will use.
'use strict'
;(function () {
  var form = document.querySelector('form[data-editor]')
  if (!form) return

  var input = form.querySelector('[data-file-input]')
  var stage = form.querySelector('[data-stage]')
  var canvas = form.querySelector('[data-canvas]')
  var viewport = form.querySelector('[data-viewport]')
  var plate = form.querySelector('[data-plate]')
  var img = form.querySelector('[data-preview]')
  var overlay = form.querySelector('[data-overlay]')
  var cropBox = form.querySelector('[data-crop-box]')
  var cropLabel = form.querySelector('[data-crop-label]')
  var recipeField = form.querySelector('[data-recipe]')
  var summary = form.querySelector('[data-op-summary]')
  var hint = form.querySelector('[data-editor-hint]')
  var formatSelect = form.querySelector('[data-format]')

  var SVG_NS = 'http://www.w3.org/2000/svg'

  function blank() {
    return {
      filter: 'none',
      brightness: 1, contrast: 1, saturation: 1, blur: 0, sharpen: 0,
      rotate: 0, flip: false, flop: false,
      crop: null,
      resize: { width: null, height: null, lock: true },
      strokes: [], shapes: [], texts: [],
      frame: { on: false, width: 0.04, color: '#ffffff' },
      corners: { on: false, radius: 0.08 },
    }
  }

  var state = blank()
  var natural = { width: 0, height: 0 }
  var tab = 'adjust'
  var ratio = null
  var shapeKind = 'rect'
  var zoom = 0        // 0 means fit
  var objectUrl = null

  /* ---------------- history ---------------- */

  var history = [JSON.stringify(state)]
  var historyAt = 0

  function commit() {
    var snapshot = JSON.stringify(state)
    if (snapshot === history[historyAt]) return
    // A new action after undoing discards the redo branch, as users expect.
    history = history.slice(0, historyAt + 1)
    history.push(snapshot)
    historyAt = history.length - 1
    render()
  }

  function travel(delta) {
    var next = historyAt + delta
    if (next < 0 || next >= history.length) return
    historyAt = next
    state = JSON.parse(history[historyAt])
    syncControls()
    render()
  }

  /* ---------------- files ---------------- */

  function loadFiles(files) {
    if (!files || !files.length) return
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = URL.createObjectURL(files[0])
    img.src = objectUrl
    canvas.hidden = false
    stage.classList.add('has-files')
    state = blank()
    history = [JSON.stringify(state)]
    historyAt = 0
    syncControls()
  }

  input.addEventListener('change', function () { loadFiles(input.files) })
  ;['dragenter', 'dragover'].forEach(function (n) {
    stage.addEventListener(n, function (e) { e.preventDefault() })
  })
  stage.addEventListener('drop', function (e) {
    e.preventDefault()
    if (!e.dataTransfer || !e.dataTransfer.files.length) return
    if (typeof DataTransfer !== 'undefined') {
      var t = new DataTransfer()
      Array.prototype.forEach.call(e.dataTransfer.files, function (f) { t.items.add(f) })
      input.files = t.files
    }
    loadFiles(e.dataTransfer.files)
  })

  img.addEventListener('load', function () {
    natural = { width: img.naturalWidth, height: img.naturalHeight }
    overlay.setAttribute('viewBox', '0 0 ' + natural.width + ' ' + natural.height)
    var rw = form.querySelector('[data-resize="width"]')
    var rh = form.querySelector('[data-resize="height"]')
    if (rw && !rw.value) rw.placeholder = String(natural.width)
    if (rh && !rh.value) rh.placeholder = String(natural.height)
    render()
  })

  /* ---------------- tabs ---------------- */

  Array.prototype.forEach.call(form.querySelectorAll('[data-tab]'), function (button) {
    button.addEventListener('click', function () {
      tab = button.getAttribute('data-tab')
      Array.prototype.forEach.call(form.querySelectorAll('[data-tab]'), function (b) {
        var on = b === button
        b.classList.toggle('is-active', on)
        b.setAttribute('aria-selected', on ? 'true' : 'false')
      })
      Array.prototype.forEach.call(form.querySelectorAll('[data-pane]'), function (pane) {
        pane.hidden = pane.getAttribute('data-pane') !== tab
      })
      viewport.setAttribute('data-mode', tab)
      render()
    })
  })

  /* ---------------- controls ---------------- */

  Array.prototype.forEach.call(form.querySelectorAll('[data-adjust]'), function (control) {
    control.addEventListener('input', function () {
      state[control.getAttribute('data-adjust')] = Number(control.value)
      render()
    })
    control.addEventListener('change', commit)
  })

  Array.prototype.forEach.call(form.querySelectorAll('[data-preset]'), function (button) {
    button.addEventListener('click', function () {
      state.filter = button.getAttribute('data-preset')
      Array.prototype.forEach.call(form.querySelectorAll('[data-preset]'), function (b) {
        b.classList.toggle('is-active', b === button)
      })
      commit()
    })
  })

  Array.prototype.forEach.call(form.querySelectorAll('[data-op]'), function (button) {
    button.addEventListener('click', function () {
      var op = button.getAttribute('data-op')
      if (op === 'rotate') {
        state.rotate = (((state.rotate + Number(button.getAttribute('data-value'))) % 360) + 360) % 360
        // A crop chosen against the previous orientation no longer applies.
        state.crop = null
      } else if (op === 'flip') {
        state.flip = !state.flip
      } else if (op === 'flop') {
        state.flop = !state.flop
      }
      commit()
    })
  })

  Array.prototype.forEach.call(form.querySelectorAll('[data-resize]'), function (control) {
    control.addEventListener('input', function () {
      var key = control.getAttribute('data-resize')
      if (key === 'lock') {
        state.resize.lock = control.checked
      } else {
        var value = control.value === '' ? null : Math.max(1, Math.round(Number(control.value)))
        state.resize[key] = value
        if (state.resize.lock && value && natural.width) {
          // Mirror the other dimension so the shown numbers match the result.
          var other = key === 'width' ? 'height' : 'width'
          var scale = key === 'width' ? value / natural.width : value / natural.height
          state.resize[other] = Math.max(1, Math.round((other === 'width' ? natural.width : natural.height) * scale))
          var mirror = form.querySelector('[data-resize="' + other + '"]')
          if (mirror) mirror.value = String(state.resize[other])
        }
      }
      render()
    })
    control.addEventListener('change', commit)
  })

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
      if (state.crop && ratio) {
        state.crop.height = state.crop.width * (natural.width / natural.height) / ratio
        commit()
      }
      render()
    })
  }

  var kinds = form.querySelector('[data-shape-kinds]')
  if (kinds) {
    kinds.addEventListener('click', function (event) {
      var button = event.target.closest('[data-shape]')
      if (!button) return
      shapeKind = button.getAttribute('data-shape')
      Array.prototype.forEach.call(kinds.querySelectorAll('[data-shape]'), function (b) {
        b.classList.toggle('is-active', b === button)
      })
    })
  }

  Array.prototype.forEach.call(form.querySelectorAll('[data-frame]'), function (control) {
    control.addEventListener('input', function () {
      var key = control.getAttribute('data-frame')
      state.frame[key] = key === 'on' ? control.checked : (key === 'width' ? Number(control.value) : control.value)
      render()
    })
    control.addEventListener('change', commit)
  })

  Array.prototype.forEach.call(form.querySelectorAll('[data-corners]'), function (control) {
    control.addEventListener('input', function () {
      var key = control.getAttribute('data-corners')
      state.corners[key] = key === 'on' ? control.checked : Number(control.value)
      // Transparency needs a format that can hold it.
      if (state.corners.on && formatSelect && formatSelect.value === 'jpeg') formatSelect.value = 'png'
      render()
    })
    control.addEventListener('change', commit)
  })

  Array.prototype.forEach.call(form.querySelectorAll('[data-clear]'), function (button) {
    button.addEventListener('click', function () {
      state[button.getAttribute('data-clear')] = []
      commit()
    })
  })

  var cropClear = form.querySelector('[data-crop-clear]')
  if (cropClear) cropClear.addEventListener('click', function () { state.crop = null; commit() })

  Array.prototype.forEach.call(form.querySelectorAll('[data-history]'), function (button) {
    button.addEventListener('click', function () {
      var action = button.getAttribute('data-history')
      if (action === 'undo') travel(-1)
      else if (action === 'redo') travel(1)
      else {
        state = blank()
        syncControls()
        commit()
      }
    })
  })

  Array.prototype.forEach.call(form.querySelectorAll('[data-zoom]'), function (button) {
    button.addEventListener('click', function () {
      var value = button.getAttribute('data-zoom')
      if (value === 'fit') zoom = 0
      else zoom = Math.min(400, Math.max(25, (zoom || 100) + Number(value) * 25))
      render()
    })
  })

  /* ---------------- canvas interaction ---------------- */

  var drag = null

  function pointAt(event) {
    var box = img.getBoundingClientRect()
    if (!box.width || !box.height) return null
    return {
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    }
  }

  plate.addEventListener('pointerdown', function (event) {
    if (!natural.width) return
    var at = pointAt(event)
    if (!at) return

    if (tab === 'text') {
      var field = form.querySelector('[data-text-input]')
      var text = field ? field.value.trim() : ''
      if (!text) {
        if (hint) hint.textContent = 'Type some text in the panel first, then click the image.'
        return
      }
      state.texts.push({
        text: text,
        x: at.x,
        y: at.y,
        size: Number((form.querySelector('[data-text-size]') || {}).value || 0.1),
        color: (form.querySelector('[data-text-color]') || {}).value || '#ffffff',
      })
      commit()
      return
    }

    if (tab === 'draw') {
      drag = {
        mode: 'draw',
        stroke: {
          points: [at],
          color: (form.querySelector('[data-pen="color"]') || {}).value || '#ff3b30',
          width: Number((form.querySelector('[data-pen="width"]') || {}).value || 0.012),
        },
      }
      state.strokes.push(drag.stroke)
    } else if (tab === 'shapes') {
      drag = {
        mode: 'shape',
        start: at,
        shape: {
          shape: shapeKind,
          x: at.x, y: at.y, width: 0, height: 0,
          color: (form.querySelector('[data-shape-color]') || {}).value || '#ff3b30',
          fill: !!(form.querySelector('[data-shape-fill]') || {}).checked,
        },
      }
      state.shapes.push(drag.shape)
    } else if (tab === 'crop') {
      drag = { mode: 'crop', start: at }
      state.crop = { x: at.x, y: at.y, width: 0, height: 0 }
    } else {
      return
    }

    plate.setPointerCapture(event.pointerId)
    event.preventDefault()
    render()
  })

  plate.addEventListener('pointermove', function (event) {
    if (!drag) return
    var at = pointAt(event)
    if (!at) return

    if (drag.mode === 'draw') {
      // Sample sparsely: a stroke does not need every pointer event, and the
      // recipe has a point budget.
      var last = drag.stroke.points[drag.stroke.points.length - 1]
      if (Math.abs(at.x - last.x) + Math.abs(at.y - last.y) > 0.004) drag.stroke.points.push(at)
    } else if (drag.mode === 'shape') {
      if (drag.shape.shape === 'line') {
        drag.shape.width = at.x - drag.start.x
        drag.shape.height = at.y - drag.start.y
      } else {
        drag.shape.x = Math.min(drag.start.x, at.x)
        drag.shape.y = Math.min(drag.start.y, at.y)
        drag.shape.width = Math.abs(at.x - drag.start.x)
        drag.shape.height = Math.abs(at.y - drag.start.y)
      }
    } else if (drag.mode === 'crop') {
      state.crop.x = Math.min(drag.start.x, at.x)
      state.crop.y = Math.min(drag.start.y, at.y)
      state.crop.width = Math.abs(at.x - drag.start.x)
      state.crop.height = Math.abs(at.y - drag.start.y)
      if (ratio && natural.width) {
        state.crop.height = (state.crop.width * natural.width) / (ratio * natural.height)
      }
    }
    render()
  })

  plate.addEventListener('pointerup', function () {
    if (!drag) return
    // Discard a click that produced nothing meaningful.
    if (drag.mode === 'shape' && Math.abs(drag.shape.width) < 0.01 && Math.abs(drag.shape.height) < 0.01) {
      state.shapes.pop()
    }
    if (drag.mode === 'draw' && drag.stroke.points.length < 2) state.strokes.pop()
    if (drag.mode === 'crop' && (state.crop.width < 0.02 || state.crop.height < 0.02)) state.crop = null
    drag = null
    commit()
  })

  /* ---------------- preview ---------------- */

  var CSS_FILTERS = {
    none: '',
    mono: 'grayscale(1)',
    sepia: 'sepia(0.72)',
    vivid: 'saturate(1.4) contrast(1.08)',
    warm: 'sepia(0.22) saturate(1.12)',
    cool: 'saturate(1.06) hue-rotate(12deg)',
    fade: 'saturate(0.68) brightness(1.06) contrast(0.92)',
  }

  function cssFilter() {
    var parts = []
    if (state.filter && CSS_FILTERS[state.filter]) parts.push(CSS_FILTERS[state.filter])
    if (state.brightness !== 1) parts.push('brightness(' + state.brightness + ')')
    if (state.contrast !== 1) parts.push('contrast(' + state.contrast + ')')
    if (state.saturation !== 1) parts.push('saturate(' + state.saturation + ')')
    if (state.blur > 0) {
      // The preview is smaller than the original, so a radius in source pixels
      // has to be scaled to look the same here.
      var shown = img.getBoundingClientRect().width || 1
      parts.push('blur(' + (state.blur * (shown / (natural.width || shown))).toFixed(2) + 'px)')
    }
    return parts.join(' ')
  }

  function cssTransform() {
    var parts = []
    if (state.rotate) parts.push('rotate(' + state.rotate + 'deg)')
    if (state.flop) parts.push('scaleX(-1)')
    if (state.flip) parts.push('scaleY(-1)')
    if (Math.abs(state.rotate % 180) === 90 && natural.width) {
      var r = Math.min(natural.width, natural.height) / Math.max(natural.width, natural.height)
      parts.push('scale(' + r.toFixed(3) + ')')
    }
    return parts.join(' ')
  }

  function node(name, attrs) {
    var el = document.createElementNS(SVG_NS, name)
    Object.keys(attrs).forEach(function (k) { el.setAttribute(k, String(attrs[k])) })
    return el
  }

  /** Draw the overlay in the image's own pixel space, as the server will. */
  function renderOverlay() {
    overlay.innerHTML = ''
    if (!natural.width) return
    var w = natural.width
    var h = natural.height
    var short = Math.min(w, h)

    state.shapes.forEach(function (s) {
      var stroke = Math.max(1, 0.008 * short)
      if (s.shape === 'line') {
        overlay.appendChild(node('line', {
          x1: s.x * w, y1: s.y * h, x2: (s.x + s.width) * w, y2: (s.y + s.height) * h,
          stroke: s.color, 'stroke-width': stroke, 'stroke-linecap': 'round',
        }))
      } else if (s.shape === 'ellipse') {
        overlay.appendChild(node('ellipse', {
          cx: (s.x + s.width / 2) * w, cy: (s.y + s.height / 2) * h,
          rx: (s.width / 2) * w, ry: (s.height / 2) * h,
          fill: s.fill ? s.color : 'none',
          stroke: s.fill ? 'none' : s.color, 'stroke-width': stroke,
        }))
      } else {
        overlay.appendChild(node('rect', {
          x: s.x * w, y: s.y * h, width: s.width * w, height: s.height * h,
          fill: s.fill ? s.color : 'none',
          stroke: s.fill ? 'none' : s.color, 'stroke-width': stroke,
        }))
      }
    })

    state.strokes.forEach(function (s) {
      var d = s.points.map(function (p, i) {
        return (i === 0 ? 'M' : 'L') + p.x * w + ',' + p.y * h
      }).join(' ')
      overlay.appendChild(node('path', {
        d: d, fill: 'none', stroke: s.color,
        'stroke-width': Math.max(1, s.width * short),
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }))
    })

    state.texts.forEach(function (t) {
      var el = node('text', {
        x: t.x * w, y: t.y * h, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
        'font-size': Math.max(8, t.size * short), 'font-weight': 700, fill: t.color,
        'font-family': 'DejaVu Sans, Liberation Sans, Helvetica, Arial, sans-serif',
      })
      el.textContent = t.text
      overlay.appendChild(el)
    })

    if (state.frame.on) {
      var thickness = Math.max(1, state.frame.width * short)
      overlay.appendChild(node('rect', {
        x: thickness / 2, y: thickness / 2, width: w - thickness, height: h - thickness,
        fill: 'none', stroke: state.frame.color, 'stroke-width': thickness,
      }))
    }
  }

  function renderCropBox() {
    if (!state.crop || !natural.width) {
      cropBox.hidden = true
      return
    }
    var box = img.getBoundingClientRect()
    var plateBox = plate.getBoundingClientRect()
    cropBox.hidden = false
    cropBox.style.left = box.left - plateBox.left + state.crop.x * box.width + 'px'
    cropBox.style.top = box.top - plateBox.top + state.crop.y * box.height + 'px'
    cropBox.style.width = state.crop.width * box.width + 'px'
    cropBox.style.height = state.crop.height * box.height + 'px'
    cropLabel.textContent =
      Math.round(state.crop.width * natural.width) + ' × ' + Math.round(state.crop.height * natural.height)
  }

  /** Fixed, deliberate order — not the order the user happened to click in. */
  function buildRecipe() {
    var ops = []
    if (state.rotate) ops.push({ op: 'rotate', angle: state.rotate })
    if (state.flop) ops.push({ op: 'flop' })
    if (state.flip) ops.push({ op: 'flip' })
    if (state.crop && state.crop.width > 0.02 && state.crop.height > 0.02) {
      ops.push({
        op: 'crop',
        x: +state.crop.x.toFixed(4), y: +state.crop.y.toFixed(4),
        width: +state.crop.width.toFixed(4), height: +state.crop.height.toFixed(4),
      })
    }
    if (state.resize.width || state.resize.height) {
      var resize = { op: 'resize' }
      if (state.resize.width) resize.width = state.resize.width
      if (state.resize.height) resize.height = state.resize.height
      ops.push(resize)
    }
    if (state.filter && state.filter !== 'none') ops.push({ op: 'filter', preset: state.filter })
    if (state.brightness !== 1) ops.push({ op: 'brightness', value: state.brightness })
    if (state.contrast !== 1) ops.push({ op: 'contrast', value: state.contrast })
    if (state.saturation !== 1) ops.push({ op: 'saturation', value: state.saturation })
    if (state.blur > 0) ops.push({ op: 'blur', sigma: state.blur })
    if (state.sharpen > 0) ops.push({ op: 'sharpen', sigma: state.sharpen })

    // Annotation sits above the adjustments so it is not washed out by them.
    state.shapes.forEach(function (s) {
      if (Math.abs(s.width) < 0.005 && Math.abs(s.height) < 0.005) return
      ops.push({
        op: 'shape', shape: s.shape,
        x: +s.x.toFixed(4), y: +s.y.toFixed(4),
        width: +s.width.toFixed(4), height: +s.height.toFixed(4),
        color: s.color, fill: s.fill,
      })
    })
    state.strokes.forEach(function (s) {
      if (s.points.length < 2) return
      ops.push({
        op: 'draw', color: s.color, width: s.width,
        points: s.points.map(function (p) { return { x: +p.x.toFixed(4), y: +p.y.toFixed(4) } }),
      })
    })
    state.texts.forEach(function (t) {
      ops.push({ op: 'text', text: t.text, x: +t.x.toFixed(4), y: +t.y.toFixed(4), size: t.size, color: t.color })
    })

    // Frame and corners last: they trim the finished picture.
    if (state.frame.on) ops.push({ op: 'frame', width: state.frame.width, color: state.frame.color })
    if (state.corners.on) ops.push({ op: 'corners', radius: state.corners.radius })

    return { version: 1, ops: ops }
  }

  /** Push state back into the controls, after undo or reset. */
  function syncControls() {
    Array.prototype.forEach.call(form.querySelectorAll('[data-adjust]'), function (c) {
      c.value = String(state[c.getAttribute('data-adjust')])
    })
    Array.prototype.forEach.call(form.querySelectorAll('[data-preset]'), function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-preset') === state.filter)
    })
    var frameOn = form.querySelector('[data-frame="on"]')
    if (frameOn) frameOn.checked = state.frame.on
    var cornersOn = form.querySelector('[data-corners="on"]')
    if (cornersOn) cornersOn.checked = state.corners.on
    var rw = form.querySelector('[data-resize="width"]')
    var rh = form.querySelector('[data-resize="height"]')
    if (rw) rw.value = state.resize.width ? String(state.resize.width) : ''
    if (rh) rh.value = state.resize.height ? String(state.resize.height) : ''
  }

  function render() {
    img.style.filter = cssFilter()
    plate.style.transform = cssTransform()

    // Zoom scales the viewport contents; 0 means fit to the available space.
    plate.style.width = zoom ? natural.width * (zoom / 100) + 'px' : ''
    plate.style.maxWidth = zoom ? 'none' : '100%'
    var zoomValue = form.querySelector('[data-zoom-value]')
    if (zoomValue) zoomValue.textContent = zoom ? zoom + '%' : 'Fit'

    Array.prototype.forEach.call(form.querySelectorAll('[data-out]'), function (out) {
      var key = out.getAttribute('data-out')
      if (key === 'pen') out.textContent = Number((form.querySelector('[data-pen="width"]') || {}).value || 0).toFixed(3)
      else if (key === 'textSize') out.textContent = Number((form.querySelector('[data-text-size]') || {}).value || 0).toFixed(2)
      else if (key === 'frameWidth') out.textContent = state.frame.width.toFixed(3)
      else if (key === 'cornerRadius') out.textContent = state.corners.radius.toFixed(2)
      else if (typeof state[key] === 'number') out.textContent = state[key].toFixed(key === 'blur' || key === 'sharpen' ? 1 : 2)
    })

    renderOverlay()
    renderCropBox()

    var recipe = buildRecipe()
    recipeField.value = JSON.stringify(recipe)

    if (summary) {
      summary.textContent = recipe.ops.length
        ? recipe.ops.length + ' change' + (recipe.ops.length === 1 ? '' : 's') + ' applied at full resolution'
        : 'No changes yet.'
    }

    var undo = form.querySelector('[data-history="undo"]')
    var redo = form.querySelector('[data-history="redo"]')
    if (undo) undo.disabled = historyAt === 0
    if (redo) redo.disabled = historyAt >= history.length - 1

    if (hint) {
      var hints = {
        crop: 'Drag on the image to select an area.',
        draw: 'Drag on the image to draw.',
        shapes: 'Drag on the image to place a ' + shapeKind + '.',
        text: 'Type in the panel, then click the image to place it.',
      }
      hint.textContent = hints[tab] || ''
    }
  }

  Array.prototype.forEach.call(form.querySelectorAll('[data-pen], [data-text-size], [data-text-color], [data-shape-color]'), function (c) {
    c.addEventListener('input', render)
  })

  viewport.setAttribute('data-mode', tab)
  window.addEventListener('resize', render)
  render()
})()
