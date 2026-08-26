// Photo editor.
//
// Two-stage model: Apply commits the current tool's change, Save writes the
// file. An edit in progress can be abandoned without disturbing the rest.
//
// The preview is a deterministic function of (original image, ops) — the same
// list is replayed here through a canvas and on the server through sharp, in
// the same order. Nothing accumulates incrementally, so removing an applied
// change simply re-runs the remaining list and cannot drift out of step.
//
// The recipe is authoritative: the browser only ever previews at display
// resolution, and the server renders the real thing at full size.
'use strict'
;(function () {
  var form = document.querySelector('form[data-editor]')
  if (!form) return

  var input = form.querySelector('[data-file-input]')
  var stage = form.querySelector('[data-stage]')
  var canvasWrap = form.querySelector('[data-canvas]')
  var viewport = form.querySelector('[data-viewport]')
  var plate = form.querySelector('[data-plate]')
  var preview = form.querySelector('[data-preview]')
  var overlay = form.querySelector('[data-overlay]')
  var cropBox = form.querySelector('[data-crop-box]')
  var cropLabel = form.querySelector('[data-crop-label]')
  var recipeField = form.querySelector('[data-recipe]')
  var summary = form.querySelector('[data-op-summary]')
  var pendingNote = form.querySelector('[data-pending-note]')
  var hint = form.querySelector('[data-editor-hint]')
  var applyBar = form.querySelector('[data-apply-bar]')
  var appliedBox = form.querySelector('[data-applied]')
  var appliedList = form.querySelector('[data-applied-list]')
  var formatSelect = form.querySelector('[data-format]')

  /** Cap the preview canvas: nothing is gained from previewing at full size. */
  var MAX_PREVIEW = 1400

  var source = null          // the original, as an Image
  var applied = []           // committed ops, in order
  var pending = null         // { tab, ... } being edited now
  var tab = 'adjust'
  var ratio = null
  var shapeKind = 'rect'
  var zoom = 0
  var objectUrl = null
  var canvas = document.createElement('canvas')
  var ctx = canvas.getContext('2d')
  var catalogue = { categories: [], stickers: [] }
  var stickerChoice = null
  var stickerCategory = null
  /** Rasterised stickers, keyed by id and colour. */
  var stickerCache = {}

  /* ---------------- helpers ---------------- */

  function val(selector, fallback) {
    var el = form.querySelector(selector)
    if (!el) return fallback
    return el.type === 'checkbox' ? el.checked : el.value
  }
  function num(selector, fallback) {
    var v = Number(val(selector, fallback))
    return isFinite(v) ? v : fallback
  }

  var LABELS = {
    rotate: function (o) { return 'Rotate ' + o.angle + '°' },
    flip: function () { return 'Mirror vertically' },
    flop: function () { return 'Mirror horizontally' },
    crop: function (o) { return 'Crop ' + Math.round(o.width * 100) + '% × ' + Math.round(o.height * 100) + '%' },
    resize: function (o) { return 'Resize to ' + (o.width || 'auto') + ' × ' + (o.height || 'auto') },
    filter: function (o) { return 'Filter: ' + o.preset },
    brightness: function (o) { return 'Brightness ' + o.value.toFixed(2) },
    contrast: function (o) { return 'Contrast ' + o.value.toFixed(2) },
    saturation: function (o) { return 'Saturation ' + o.value.toFixed(2) },
    blur: function (o) { return 'Blur ' + o.sigma },
    sharpen: function (o) { return 'Sharpen ' + o.sigma },
    shape: function (o) { return 'Add ' + o.shape },
    draw: function (o) { return 'Draw (' + o.points.length + ' points)' },
    text: function (o) { return 'Text: "' + o.text.slice(0, 18) + '"' },
    frame: function () { return 'Border' },
    corners: function () { return 'Round corners' },
    sticker: function (o) { return 'Sticker: ' + o.sticker },
    background: function (o) { return 'Background ' + o.color },
  }
  function label(op) {
    return LABELS[op.op] ? LABELS[op.op](op) : op.op
  }

  /* ---------------- files ---------------- */

  function loadFiles(files) {
    if (!files || !files.length) return
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = URL.createObjectURL(files[0])

    var image = new Image()
    image.onload = function () {
      source = image
      applied = []
      pending = null
      canvasWrap.hidden = false
      stage.classList.add('has-files')
      seedSizeFields()
      render()
    }
    image.src = objectUrl
  }

  function seedSizeFields() {
    if (!source) return
    ;[['[data-resize="width"]', source.naturalWidth], ['[data-resize="height"]', source.naturalHeight]].forEach(
      function (pair) {
        var el = form.querySelector(pair[0])
        if (el) el.placeholder = String(pair[1])
      },
    )
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

  /* ---------------- stickers ---------------- */

  /**
   * The catalogue comes from the server, so the shape drawn in the preview is
   * the same geometry the final render uses. Nothing is duplicated here.
   */
  function loadStickers() {
    fetch('/api/stickers', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (data) {
        if (!data) return
        catalogue = data
        stickerCategory = data.categories.length ? data.categories[0].id : null
        renderStickerPicker()
      })
      .catch(function () {
        // Without the catalogue the tab simply offers nothing; every other
        // tool still works.
      })
  }

  function svgFor(sticker, colour) {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + sticker.viewBox + '">' +
      '<path d="' + sticker.path + '" fill="' + colour + '" fill-rule="evenodd"/></svg>'
    )
  }

  /** A rasterised sticker for canvas drawing, loaded once per id and colour. */
  function stickerImage(id, colour) {
    var key = id + '|' + colour
    if (stickerCache[key]) return stickerCache[key]

    var sticker = catalogue.stickers.filter(function (s) { return s.id === id })[0]
    if (!sticker) return null

    var image = new Image()
    image.onload = render
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgFor(sticker, colour))
    stickerCache[key] = image
    return image
  }

  function renderStickerPicker() {
    var cats = form.querySelector('[data-sticker-cats]')
    var grid = form.querySelector('[data-sticker-grid]')
    if (!cats || !grid) return

    cats.innerHTML = ''
    catalogue.categories.forEach(function (cat) {
      var button = document.createElement('button')
      button.type = 'button'
      button.className = 'chip-btn' + (cat.id === stickerCategory ? ' is-active' : '')
      button.textContent = cat.label
      button.addEventListener('click', function () {
        stickerCategory = cat.id
        renderStickerPicker()
      })
      cats.appendChild(button)
    })

    grid.innerHTML = ''
    var colour = val('[data-sticker-color]', '#ff3b30')
    catalogue.stickers
      .filter(function (s) { return s.category === stickerCategory })
      .forEach(function (sticker) {
        var button = document.createElement('button')
        button.type = 'button'
        button.className = 'sticker-btn' + (sticker.id === stickerChoice ? ' is-active' : '')
        button.title = sticker.label
        button.setAttribute('aria-label', sticker.label)
        button.innerHTML = svgFor(sticker, 'currentColor')
        button.addEventListener('click', function () {
          stickerChoice = sticker.id
          // Warm the raster before it is needed, so the first placement draws.
          stickerImage(sticker.id, colour)
          renderStickerPicker()
        })
        grid.appendChild(button)
      })
  }

  Array.prototype.forEach.call(
    form.querySelectorAll('[data-sticker-color], [data-sticker-size], [data-sticker-rotation]'),
    function (control) {
      control.addEventListener('input', function () {
        if (control.hasAttribute('data-sticker-color')) renderStickerPicker()
        render()
      })
    },
  )

  /* ---------------- tabs ---------------- */

  function selectTab(next) {
    // Switching tools abandons an unapplied edit rather than carrying it over.
    pending = null
    tab = next
    Array.prototype.forEach.call(form.querySelectorAll('[data-tab]'), function (b) {
      var on = b.getAttribute('data-tab') === tab
      b.classList.toggle('is-active', on)
      b.setAttribute('aria-selected', on ? 'true' : 'false')
    })
    Array.prototype.forEach.call(form.querySelectorAll('[data-pane]'), function (pane) {
      pane.hidden = pane.getAttribute('data-pane') !== tab
    })
    viewport.setAttribute('data-mode', tab)
    resetToolControls()
    render()
  }

  Array.prototype.forEach.call(form.querySelectorAll('[data-tab]'), function (button) {
    button.addEventListener('click', function () { selectTab(button.getAttribute('data-tab')) })
  })

  /** Return the active tool's controls to their neutral position. */
  function resetToolControls() {
    Array.prototype.forEach.call(form.querySelectorAll('[data-adjust]'), function (c) {
      c.value = c.getAttribute('data-adjust') === 'blur' || c.getAttribute('data-adjust') === 'sharpen' ? '0' : '1'
    })
    Array.prototype.forEach.call(form.querySelectorAll('[data-preset]'), function (b, i) {
      b.classList.toggle('is-active', i === 0)
    })
    ;['[data-crop-field="width"]', '[data-crop-field="height"]',
      '[data-resize="width"]', '[data-resize="height"]', '[data-text-input]'].forEach(function (sel) {
      var el = form.querySelector(sel)
      if (el) el.value = ''
    })
    var frameOn = form.querySelector('[data-frame="on"]')
    if (frameOn) frameOn.checked = false
    var cornersOn = form.querySelector('[data-corners="on"]')
    if (cornersOn) cornersOn.checked = false
  }

  /* ---------------- pending edits, per tool ---------------- */

  /** The ops the current tool would contribute if applied now. */
  function pendingOps() {
    if (!pending) return []

    if (pending.tab === 'adjust') {
      var ops = []
      if (pending.filter && pending.filter !== 'none') ops.push({ op: 'filter', preset: pending.filter })
      ;['brightness', 'contrast', 'saturation'].forEach(function (k) {
        if (pending[k] !== undefined && pending[k] !== 1) ops.push({ op: k, value: pending[k] })
      })
      if (pending.blur) ops.push({ op: 'blur', sigma: pending.blur })
      if (pending.sharpen) ops.push({ op: 'sharpen', sigma: pending.sharpen })
      return ops
    }
    if (pending.tab === 'crop' && pending.rect && pending.rect.width > 0.02 && pending.rect.height > 0.02) {
      return [{
        op: 'crop',
        x: +pending.rect.x.toFixed(4), y: +pending.rect.y.toFixed(4),
        width: +pending.rect.width.toFixed(4), height: +pending.rect.height.toFixed(4),
      }]
    }
    if (pending.tab === 'resize' && (pending.width || pending.height)) {
      var resize = { op: 'resize' }
      if (pending.width) resize.width = pending.width
      if (pending.height) resize.height = pending.height
      return [resize]
    }
    if (pending.tab === 'transform') return pending.ops || []
    if (pending.tab === 'draw' && pending.stroke && pending.stroke.points.length > 1) {
      return [{ op: 'draw', color: pending.stroke.color, width: pending.stroke.width, points: pending.stroke.points }]
    }
    if (pending.tab === 'shapes' && pending.shape) {
      var sh = pending.shape
      if (Math.abs(sh.width) < 0.01 && Math.abs(sh.height) < 0.01) return []
      return [{ op: 'shape', shape: sh.shape, x: sh.x, y: sh.y, width: sh.width, height: sh.height, color: sh.color, fill: sh.fill }]
    }
    if (pending.tab === 'text' && pending.text) return [pending.text]
    if (pending.tab === 'frame' && pending.frame) return [pending.frame]
    if (pending.tab === 'corners' && pending.corners) return [pending.corners]
    if (pending.tab === 'stickers' && pending.sticker) return [pending.sticker]
    if (pending.tab === 'background' && pending.background) return [pending.background]
    return []
  }

  function setPending(next) {
    pending = next
    render()
  }

  /* ---------------- controls ---------------- */

  Array.prototype.forEach.call(form.querySelectorAll('[data-adjust]'), function (control) {
    control.addEventListener('input', function () {
      var base = pending && pending.tab === 'adjust' ? pending : { tab: 'adjust', filter: 'none' }
      base[control.getAttribute('data-adjust')] = Number(control.value)
      setPending(base)
    })
  })

  Array.prototype.forEach.call(form.querySelectorAll('[data-preset]'), function (button) {
    button.addEventListener('click', function () {
      var base = pending && pending.tab === 'adjust' ? pending : { tab: 'adjust' }
      base.filter = button.getAttribute('data-preset')
      Array.prototype.forEach.call(form.querySelectorAll('[data-preset]'), function (b) {
        b.classList.toggle('is-active', b === button)
      })
      setPending(base)
    })
  })

  Array.prototype.forEach.call(form.querySelectorAll('[data-op]'), function (button) {
    button.addEventListener('click', function () {
      var base = pending && pending.tab === 'transform' ? pending : { tab: 'transform', ops: [] }
      var op = button.getAttribute('data-op')
      if (op === 'rotate') base.ops.push({ op: 'rotate', angle: Number(button.getAttribute('data-value')) })
      else base.ops.push({ op: op })
      setPending(base)
    })
  })

  Array.prototype.forEach.call(form.querySelectorAll('[data-resize]'), function (control) {
    control.addEventListener('input', function () {
      var key = control.getAttribute('data-resize')
      var base = pending && pending.tab === 'resize' ? pending : { tab: 'resize', lock: true }
      if (key === 'lock') {
        base.lock = control.checked
      } else {
        var v = control.value === '' ? null : Math.max(1, Math.round(Number(control.value)))
        base[key] = v
        var dims = currentSize()
        if (base.lock && v && dims.width) {
          var other = key === 'width' ? 'height' : 'width'
          var scale = key === 'width' ? v / dims.width : v / dims.height
          base[other] = Math.max(1, Math.round((other === 'width' ? dims.width : dims.height) * scale))
          var mirror = form.querySelector('[data-resize="' + other + '"]')
          if (mirror) mirror.value = String(base[other])
        }
      }
      setPending(base)
    })
  })

  Array.prototype.forEach.call(form.querySelectorAll('[data-crop-field]'), function (control) {
    control.addEventListener('input', function () {
      var dims = currentSize()
      if (!dims.width) return
      var base = pending && pending.tab === 'crop' ? pending : { tab: 'crop', rect: { x: 0, y: 0, width: 1, height: 1 } }
      var key = control.getAttribute('data-crop-field')
      var px = Math.max(1, Math.round(Number(control.value) || 0))
      base.rect[key] = Math.min(1, px / (key === 'width' ? dims.width : dims.height))
      base.rect.x = Math.min(base.rect.x, 1 - base.rect.width)
      base.rect.y = Math.min(base.rect.y, 1 - base.rect.height)
      setPending(base)
    })
  })

  var ratios = form.querySelector('[data-ratios]')
  if (ratios) {
    ratios.addEventListener('click', function (event) {
      var button = event.target.closest('[data-ratio]')
      if (!button) return
      Array.prototype.forEach.call(ratios.querySelectorAll('[data-ratio]'), function (b) {
        b.classList.toggle('is-active', b === button)
      })
      var v = button.getAttribute('data-ratio')
      ratio = v === 'free' ? null : Number(v)
      if (ratio) {
        var dims = currentSize()
        var base = pending && pending.tab === 'crop' ? pending : { tab: 'crop', rect: { x: 0, y: 0, width: 1, height: 1 } }
        // Fit the largest rectangle of this ratio inside the current image.
        var w = 1
        var h = (dims.width / ratio) / dims.height
        if (h > 1) { h = 1; w = (dims.height * ratio) / dims.width }
        base.rect = { x: (1 - w) / 2, y: (1 - h) / 2, width: w, height: h }
        setPending(base)
      }
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
      var on = val('[data-frame="on"]', false)
      setPending(on ? {
        tab: 'frame',
        frame: { op: 'frame', width: num('[data-frame="width"]', 0.04), color: val('[data-frame="color"]', '#ffffff') },
      } : { tab: 'frame' })
    })
  })

  Array.prototype.forEach.call(form.querySelectorAll('[data-corners]'), function (control) {
    control.addEventListener('input', function () {
      var on = val('[data-corners="on"]', false)
      if (on && formatSelect && formatSelect.value === 'jpeg') formatSelect.value = 'png'
      setPending(on ? {
        tab: 'corners',
        corners: { op: 'corners', radius: num('[data-corners="radius"]', 0.08) },
      } : { tab: 'corners' })
    })
  })

  Array.prototype.forEach.call(form.querySelectorAll('[data-bg]'), function (control) {
    control.addEventListener('input', function () {
      var on = val('[data-bg="on"]', false)
      setPending(on ? { tab: 'background', background: { op: 'background', color: val('[data-bg="color"]', '#ffffff') } } : { tab: 'background' })
    })
  })

  Array.prototype.forEach.call(form.querySelectorAll('[data-pen], [data-text-size], [data-text-color], [data-shape-color], [data-shape-fill]'), function (c) {
    c.addEventListener('input', render)
  })

  /* ---------------- apply / cancel ---------------- */

  function applyPending() {
    var ops = pendingOps()
    if (!ops.length) return false
    ops.forEach(function (op) { applied.push(op) })
    pending = null
    resetToolControls()
    render()
    return true
  }

  Array.prototype.forEach.call(form.querySelectorAll('[data-edit]'), function (button) {
    button.addEventListener('click', function () {
      if (button.getAttribute('data-edit') === 'apply') applyPending()
      else {
        pending = null
        resetToolControls()
        render()
      }
    })
  })

  Array.prototype.forEach.call(form.querySelectorAll('[data-history]'), function (button) {
    button.addEventListener('click', function () {
      var action = button.getAttribute('data-history')
      if (action === 'undo') applied.pop()
      else if (action === 'reset') applied = []
      pending = null
      resetToolControls()
      render()
    })
  })

  Array.prototype.forEach.call(form.querySelectorAll('[data-zoom]'), function (button) {
    button.addEventListener('click', function () {
      var v = button.getAttribute('data-zoom')
      zoom = v === 'fit' ? 0 : Math.min(400, Math.max(25, (zoom || 100) + Number(v) * 25))
      render()
    })
  })

  // Nothing in progress is silently discarded when saving.
  form.addEventListener('submit', function () {
    applyPending()
    recipeField.value = JSON.stringify({ version: 1, ops: applied })
  })

  /* ---------------- canvas replay ---------------- */

  var CSS_FILTERS = {
    mono: 'grayscale(1)', sepia: 'sepia(0.72)', vivid: 'saturate(1.4) contrast(1.08)',
    warm: 'sepia(0.22) saturate(1.12)', cool: 'saturate(1.06) hue-rotate(12deg)',
    fade: 'saturate(0.68) brightness(1.06) contrast(0.92)',
  }

  /**
   * Replay ops into the canvas, in order, exactly as the server will.
   *
   * Geometry ops re-target the canvas; pixel ops use ctx.filter; annotations
   * draw with Canvas2D. `sharpen` has no canvas equivalent and is skipped here
   * — it still applies server-side, so a preview slightly understates it.
   */
  function replay(ops) {
    if (!source) return

    var scale = Math.min(1, MAX_PREVIEW / Math.max(source.naturalWidth, source.naturalHeight))
    canvas.width = Math.max(1, Math.round(source.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(source.naturalHeight * scale))
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height)

    ops.forEach(function (op) {
      var w = canvas.width
      var h = canvas.height
      var short = Math.min(w, h)

      if (op.op === 'rotate' || op.op === 'flip' || op.op === 'flop' || op.op === 'crop' || op.op === 'resize') {
        var snapshot = document.createElement('canvas')
        snapshot.width = w
        snapshot.height = h
        snapshot.getContext('2d').drawImage(canvas, 0, 0)

        if (op.op === 'crop') {
          var cw = Math.max(1, Math.round(op.width * w))
          var ch = Math.max(1, Math.round(op.height * h))
          canvas.width = cw
          canvas.height = ch
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          ctx.clearRect(0, 0, cw, ch)
          ctx.drawImage(snapshot, Math.round(op.x * w), Math.round(op.y * h), cw, ch, 0, 0, cw, ch)
        } else if (op.op === 'resize') {
          var target = fitInside(w, h, op.width, op.height)
          canvas.width = target.width
          canvas.height = target.height
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          ctx.clearRect(0, 0, target.width, target.height)
          ctx.drawImage(snapshot, 0, 0, target.width, target.height)
        } else if (op.op === 'rotate') {
          var quarter = Math.abs(((op.angle % 360) + 360) % 360)
          var swap = quarter === 90 || quarter === 270
          canvas.width = swap ? h : w
          canvas.height = swap ? w : h
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          ctx.clearRect(0, 0, canvas.width, canvas.height)
          ctx.translate(canvas.width / 2, canvas.height / 2)
          ctx.rotate((quarter * Math.PI) / 180)
          ctx.drawImage(snapshot, -w / 2, -h / 2)
          ctx.setTransform(1, 0, 0, 1, 0, 0)
        } else {
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          ctx.clearRect(0, 0, w, h)
          ctx.translate(op.op === 'flop' ? w : 0, op.op === 'flip' ? h : 0)
          ctx.scale(op.op === 'flop' ? -1 : 1, op.op === 'flip' ? -1 : 1)
          ctx.drawImage(snapshot, 0, 0)
          ctx.setTransform(1, 0, 0, 1, 0, 0)
        }
        return
      }

      if (op.op === 'filter' || op.op === 'brightness' || op.op === 'contrast' || op.op === 'saturation' || op.op === 'blur') {
        var filter =
          op.op === 'filter' ? CSS_FILTERS[op.preset] || '' :
          op.op === 'brightness' ? 'brightness(' + op.value + ')' :
          op.op === 'contrast' ? 'contrast(' + op.value + ')' :
          op.op === 'saturation' ? 'saturate(' + op.value + ')' :
          'blur(' + (op.sigma * (canvas.width / (source.naturalWidth || canvas.width))).toFixed(2) + 'px)'
        if (!filter) return

        var pass = document.createElement('canvas')
        pass.width = w
        pass.height = h
        var pctx = pass.getContext('2d')
        pctx.filter = filter
        pctx.drawImage(canvas, 0, 0)
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, w, h)
        ctx.drawImage(pass, 0, 0)
        return
      }

      if (op.op === 'sticker') {
        var mark = stickerImage(op.sticker, op.color)
        // Skip until the raster is ready; its onload triggers another render.
        if (!mark || !mark.complete || !mark.naturalWidth) return
        var extent = Math.max(8, op.size * short)
        ctx.save()
        ctx.translate(op.x * w, op.y * h)
        if (op.rotation) ctx.rotate((op.rotation * Math.PI) / 180)
        ctx.drawImage(mark, -extent / 2, -extent / 2, extent, extent)
        ctx.restore()
        return
      }

      if (op.op === 'background') {
        // Paint the colour underneath what is already there.
        var under = document.createElement('canvas')
        under.width = w
        under.height = h
        var uctx = under.getContext('2d')
        uctx.fillStyle = op.color
        uctx.fillRect(0, 0, w, h)
        uctx.drawImage(canvas, 0, 0)
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, w, h)
        ctx.drawImage(under, 0, 0)
        return
      }

      if (op.op === 'shape') {
        ctx.save()
        ctx.strokeStyle = op.color
        ctx.fillStyle = op.color
        ctx.lineWidth = Math.max(1, 0.008 * short)
        ctx.lineCap = 'round'
        if (op.shape === 'line') {
          ctx.beginPath()
          ctx.moveTo(op.x * w, op.y * h)
          ctx.lineTo((op.x + op.width) * w, (op.y + op.height) * h)
          ctx.stroke()
        } else if (op.shape === 'ellipse') {
          ctx.beginPath()
          ctx.ellipse((op.x + op.width / 2) * w, (op.y + op.height / 2) * h, (op.width / 2) * w, (op.height / 2) * h, 0, 0, Math.PI * 2)
          if (op.fill) ctx.fill()
          else ctx.stroke()
        } else {
          if (op.fill) ctx.fillRect(op.x * w, op.y * h, op.width * w, op.height * h)
          else ctx.strokeRect(op.x * w, op.y * h, op.width * w, op.height * h)
        }
        ctx.restore()
        return
      }

      if (op.op === 'draw') {
        ctx.save()
        ctx.strokeStyle = op.color
        ctx.lineWidth = Math.max(1, op.width * short)
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.beginPath()
        op.points.forEach(function (p, i) {
          if (i === 0) ctx.moveTo(p.x * w, p.y * h)
          else ctx.lineTo(p.x * w, p.y * h)
        })
        ctx.stroke()
        ctx.restore()
        return
      }

      if (op.op === 'text') {
        ctx.save()
        ctx.fillStyle = op.color
        ctx.font = '700 ' + Math.max(8, op.size * short) + 'px "DejaVu Sans", Helvetica, Arial, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(op.text, op.x * w, op.y * h)
        ctx.restore()
        return
      }

      if (op.op === 'frame') {
        var thickness = Math.max(1, op.width * short)
        ctx.save()
        ctx.strokeStyle = op.color
        ctx.lineWidth = thickness
        ctx.strokeRect(thickness / 2, thickness / 2, w - thickness, h - thickness)
        ctx.restore()
        return
      }

      if (op.op === 'corners') {
        var radius = Math.min(op.radius * short, Math.min(w, h) / 2)
        var masked = document.createElement('canvas')
        masked.width = w
        masked.height = h
        var mctx = masked.getContext('2d')
        mctx.beginPath()
        if (mctx.roundRect) mctx.roundRect(0, 0, w, h, radius)
        else mctx.rect(0, 0, w, h)
        mctx.clip()
        mctx.drawImage(canvas, 0, 0)
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, w, h)
        ctx.drawImage(masked, 0, 0)
      }
    })
  }

  function fitInside(w, h, targetW, targetH) {
    if (targetW && targetH) {
      var s = Math.min(targetW / w, targetH / h)
      return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) }
    }
    if (targetW) return { width: targetW, height: Math.max(1, Math.round((h * targetW) / w)) }
    return { width: Math.max(1, Math.round((w * targetH) / h)), height: targetH }
  }

  /** Dimensions of the image as the applied ops leave it, in source pixels. */
  function currentSize() {
    if (!source) return { width: 0, height: 0 }
    var w = source.naturalWidth
    var h = source.naturalHeight
    applied.forEach(function (op) {
      if (op.op === 'crop') { w = Math.round(op.width * w); h = Math.round(op.height * h) }
      else if (op.op === 'resize') { var f = fitInside(w, h, op.width, op.height); w = f.width; h = f.height }
      else if (op.op === 'rotate') {
        var q = Math.abs(((op.angle % 360) + 360) % 360)
        if (q === 90 || q === 270) { var t = w; w = h; h = t }
      }
    })
    return { width: w, height: h }
  }

  /* ---------------- canvas interaction ---------------- */

  var drag = null

  function pointAt(event) {
    var box = preview.getBoundingClientRect()
    if (!box.width || !box.height) return null
    return {
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    }
  }

  plate.addEventListener('pointerdown', function (event) {
    if (!source) return
    var at = pointAt(event)
    if (!at) return

    if (tab === 'text') {
      var text = String(val('[data-text-input]', '')).trim()
      if (!text) {
        if (hint) hint.textContent = 'Type some text in the panel first, then click the image.'
        return
      }
      setPending({
        tab: 'text',
        text: {
          op: 'text', text: text, x: +at.x.toFixed(4), y: +at.y.toFixed(4),
          size: num('[data-text-size]', 0.1), color: val('[data-text-color]', '#ffffff'),
        },
      })
      return
    }

    if (tab === 'stickers') {
      if (!stickerChoice) {
        if (hint) hint.textContent = 'Choose a mark in the panel first, then click the image.'
        return
      }
      setPending({
        tab: 'stickers',
        sticker: {
          op: 'sticker', sticker: stickerChoice,
          x: +at.x.toFixed(4), y: +at.y.toFixed(4),
          size: num('[data-sticker-size]', 0.25),
          color: val('[data-sticker-color]', '#ff3b30'),
          rotation: num('[data-sticker-rotation]', 0),
        },
      })
      return
    }

    if (tab === 'draw') {
      drag = { mode: 'draw' }
      pending = {
        tab: 'draw',
        stroke: { points: [at], color: val('[data-pen="color"]', '#ff3b30'), width: num('[data-pen="width"]', 0.012) },
      }
    } else if (tab === 'shapes') {
      drag = { mode: 'shape', start: at }
      pending = {
        tab: 'shapes',
        shape: {
          shape: shapeKind, x: at.x, y: at.y, width: 0, height: 0,
          color: val('[data-shape-color]', '#ff3b30'), fill: !!val('[data-shape-fill]', true),
        },
      }
    } else if (tab === 'crop') {
      drag = { mode: 'crop', start: at }
      pending = { tab: 'crop', rect: { x: at.x, y: at.y, width: 0, height: 0 } }
    } else {
      return
    }

    plate.setPointerCapture(event.pointerId)
    event.preventDefault()
    render()
  })

  plate.addEventListener('pointermove', function (event) {
    if (!drag || !pending) return
    var at = pointAt(event)
    if (!at) return

    if (drag.mode === 'draw') {
      var pts = pending.stroke.points
      var last = pts[pts.length - 1]
      if (Math.abs(at.x - last.x) + Math.abs(at.y - last.y) > 0.004) pts.push(at)
    } else if (drag.mode === 'shape') {
      var sh = pending.shape
      if (sh.shape === 'line') {
        sh.width = at.x - drag.start.x
        sh.height = at.y - drag.start.y
      } else {
        sh.x = Math.min(drag.start.x, at.x)
        sh.y = Math.min(drag.start.y, at.y)
        sh.width = Math.abs(at.x - drag.start.x)
        sh.height = Math.abs(at.y - drag.start.y)
      }
    } else if (drag.mode === 'crop') {
      var r = pending.rect
      r.x = Math.min(drag.start.x, at.x)
      r.y = Math.min(drag.start.y, at.y)
      r.width = Math.abs(at.x - drag.start.x)
      r.height = Math.abs(at.y - drag.start.y)
      if (ratio) {
        var dims = currentSize()
        r.height = (r.width * dims.width) / (ratio * dims.height)
      }
    }
    render()
  })

  plate.addEventListener('pointerup', function () {
    drag = null
    render()
  })

  /* ---------------- render ---------------- */

  function renderCropBox() {
    var rect = pending && pending.tab === 'crop' ? pending.rect : null
    if (!rect || !rect.width) {
      cropBox.hidden = true
      return
    }
    var box = preview.getBoundingClientRect()
    var plateBox = plate.getBoundingClientRect()
    var dims = currentSize()
    cropBox.hidden = false
    cropBox.style.left = box.left - plateBox.left + rect.x * box.width + 'px'
    cropBox.style.top = box.top - plateBox.top + rect.y * box.height + 'px'
    cropBox.style.width = rect.width * box.width + 'px'
    cropBox.style.height = rect.height * box.height + 'px'
    cropLabel.textContent = Math.round(rect.width * dims.width) + ' × ' + Math.round(rect.height * dims.height)

    // Keep the numeric fields in step with the drag.
    var wf = form.querySelector('[data-crop-field="width"]')
    var hf = form.querySelector('[data-crop-field="height"]')
    if (wf && document.activeElement !== wf) wf.value = String(Math.round(rect.width * dims.width))
    if (hf && document.activeElement !== hf) hf.value = String(Math.round(rect.height * dims.height))
  }

  function renderAppliedList() {
    appliedBox.hidden = applied.length === 0
    appliedList.innerHTML = ''
    applied.forEach(function (op, index) {
      var li = document.createElement('li')

      var step = document.createElement('span')
      step.className = 'applied-step'
      step.textContent = String(index + 1)

      var name = document.createElement('span')
      name.className = 'applied-name'
      name.textContent = label(op)

      var drop = document.createElement('button')
      drop.type = 'button'
      drop.className = 'applied-drop'
      drop.textContent = '×'
      drop.title = 'Remove this change'
      drop.setAttribute('aria-label', 'Remove ' + label(op))
      drop.addEventListener('click', function () {
        // The preview is a function of the list, so dropping one entry and
        // re-running is all that is needed.
        applied.splice(index, 1)
        render()
      })

      li.appendChild(step)
      li.appendChild(name)
      li.appendChild(drop)
      appliedList.appendChild(li)
    })
  }

  function render() {
    if (!source) return

    var provisional = pendingOps()
    replay(applied.concat(provisional))
    preview.src = canvas.toDataURL('image/png')

    plate.style.width = zoom ? canvas.width * (zoom / 100) + 'px' : ''
    plate.style.maxWidth = zoom ? 'none' : '100%'
    var zoomValue = form.querySelector('[data-zoom-value]')
    if (zoomValue) zoomValue.textContent = zoom ? zoom + '%' : 'Fit'

    if (overlay) overlay.innerHTML = ''
    renderCropBox()
    renderAppliedList()

    applyBar.hidden = provisional.length === 0
    if (pendingNote) pendingNote.hidden = provisional.length === 0

    Array.prototype.forEach.call(form.querySelectorAll('[data-out]'), function (out) {
      var key = out.getAttribute('data-out')
      var map = {
        pen: num('[data-pen="width"]', 0).toFixed(3),
        textSize: num('[data-text-size]', 0).toFixed(2),
        frameWidth: num('[data-frame="width"]', 0).toFixed(3),
        cornerRadius: num('[data-corners="radius"]', 0).toFixed(2),
      }
      if (map[key] !== undefined) { out.textContent = map[key]; return }
      var el = form.querySelector('[data-adjust="' + key + '"]')
      if (el) out.textContent = Number(el.value).toFixed(key === 'blur' || key === 'sharpen' ? 1 : 2)
    })

    recipeField.value = JSON.stringify({ version: 1, ops: applied.concat(provisional) })

    var dims = currentSize()
    if (summary) {
      summary.textContent = applied.length
        ? applied.length + ' change' + (applied.length === 1 ? '' : 's') + ' applied · ' + dims.width + ' × ' + dims.height
        : 'No changes yet.'
    }

    var undo = form.querySelector('[data-history="undo"]')
    if (undo) undo.disabled = applied.length === 0
    var redo = form.querySelector('[data-history="redo"]')
    if (redo) redo.disabled = true

    if (hint) {
      var hints = {
        crop: 'Drag on the image to select an area, then Apply.',
        draw: 'Drag on the image to draw, then Apply.',
        shapes: 'Drag on the image to place a ' + shapeKind + ', then Apply.',
        text: 'Type in the panel, then click the image to place it.',
        stickers: 'Choose a mark, then click the image to place it.',
      }
      hint.textContent = hints[tab] || ''
    }
  }

  loadStickers()
  viewport.setAttribute('data-mode', tab)
  window.addEventListener('resize', function () { renderCropBox() })
})()
