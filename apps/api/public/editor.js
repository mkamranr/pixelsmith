// Photo editor page.
//
// The browser previews edits with CSS transforms and filters — cheap, and it
// never decodes the full-resolution image. What it produces is a *recipe*: an
// ordered list of operations the server replays at full size through the same
// primitives the batch tools use. One implementation of each transform, and a
// 60-megapixel TIFF never has to enter a canvas.
'use strict'
;(function () {
  var form = document.querySelector('form[data-editor]')
  if (!form) return

  var input = form.querySelector('[data-file-input]')
  var stage = form.querySelector('[data-stage]')
  var canvas = form.querySelector('[data-canvas]')
  var frame = form.querySelector('[data-frame]')
  var img = form.querySelector('[data-preview]')
  var recipeField = form.querySelector('[data-recipe]')
  var summary = form.querySelector('[data-op-summary]')
  var cropBox = form.querySelector('[data-crop-box]')
  var cropLabel = form.querySelector('[data-crop-label]')
  var head = form.querySelector('[data-stage-head]')
  var hint = form.querySelector('[data-editor-hint]')

  /** The whole edit, as plain data. Everything else derives from this. */
  var state = {
    rotate: 0,
    flip: false,
    flop: false,
    crop: null, // {x, y, width, height} as fractions of the image
    brightness: 1,
    contrast: 1,
    saturation: 1,
    blur: 0,
    sharpen: 0,
    greyscale: false,
    text: '',
    textSize: 0.12,
    textColor: '#ffffff',
  }

  var objectUrl = null

  function loadFiles(files) {
    if (!files || !files.length) return
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = URL.createObjectURL(files[0])
    img.src = objectUrl
    canvas.hidden = false
    stage.classList.add('has-files')
    if (head) head.hidden = false
    var count = form.querySelector('[data-file-count]')
    if (count) count.textContent = String(files.length)
    var noun = form.querySelector('[data-file-noun]')
    if (noun) noun.textContent = files.length === 1 ? 'image' : 'images (same edits applied to each)'
    state.crop = null
    render()
  }

  input.addEventListener('change', function () {
    loadFiles(input.files)
  })

  var addMore = form.querySelector('[data-add-more]')
  if (addMore) addMore.addEventListener('click', function () { input.click() })

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

  // ---- controls ----

  Array.prototype.forEach.call(form.querySelectorAll('[data-op]'), function (button) {
    button.addEventListener('click', function () {
      var op = button.getAttribute('data-op')
      if (op === 'rotate') {
        var step = Number(button.getAttribute('data-value'))
        state.rotate = (((state.rotate + step) % 360) + 360) % 360
        // A rotation invalidates a crop chosen against the previous orientation.
        state.crop = null
      } else if (op === 'flip') {
        state.flip = !state.flip
        button.classList.toggle('is-active', state.flip)
      } else if (op === 'flop') {
        state.flop = !state.flop
        button.classList.toggle('is-active', state.flop)
      }
      render()
    })
  })

  Array.prototype.forEach.call(form.querySelectorAll('[data-adjust]'), function (control) {
    control.addEventListener('input', function () {
      var key = control.getAttribute('data-adjust')
      state[key] = control.type === 'checkbox' ? control.checked : Number(control.value)
      render()
    })
  })

  var textInput = form.querySelector('[data-text-input]')
  var textSize = form.querySelector('[data-text-size]')
  var textColor = form.querySelector('[data-text-color]')
  if (textInput) textInput.addEventListener('input', function () { state.text = textInput.value; render() })
  if (textSize) textSize.addEventListener('input', function () { state.textSize = Number(textSize.value); render() })
  if (textColor) textColor.addEventListener('input', function () { state.textColor = textColor.value; render() })

  var reset = form.querySelector('[data-reset]')
  if (reset) {
    reset.addEventListener('click', function () {
      state = {
        rotate: 0, flip: false, flop: false, crop: null,
        brightness: 1, contrast: 1, saturation: 1, blur: 0, sharpen: 0,
        greyscale: false, text: '', textSize: 0.12, textColor: '#ffffff',
      }
      Array.prototype.forEach.call(form.querySelectorAll('[data-adjust]'), function (c) {
        if (c.type === 'checkbox') c.checked = false
        else c.value = c.getAttribute('data-adjust') === 'brightness' ||
          c.getAttribute('data-adjust') === 'contrast' ||
          c.getAttribute('data-adjust') === 'saturation' ? '1' : '0'
      })
      Array.prototype.forEach.call(form.querySelectorAll('.quick-btn'), function (b) {
        b.classList.remove('is-active')
      })
      if (textInput) textInput.value = ''
      render()
    })
  }

  // ---- drag to crop ----

  var dragging = null

  function pointToFraction(event) {
    var box = img.getBoundingClientRect()
    if (!box.width || !box.height) return null
    return {
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    }
  }

  frame.addEventListener('pointerdown', function (event) {
    if (event.target !== img && event.target !== cropBox) return
    var start = pointToFraction(event)
    if (!start) return
    dragging = start
    frame.setPointerCapture(event.pointerId)
    event.preventDefault()
  })

  frame.addEventListener('pointermove', function (event) {
    if (!dragging) return
    var now = pointToFraction(event)
    if (!now) return
    state.crop = {
      x: Math.min(dragging.x, now.x),
      y: Math.min(dragging.y, now.y),
      width: Math.abs(now.x - dragging.x),
      height: Math.abs(now.y - dragging.y),
    }
    render()
  })

  frame.addEventListener('pointerup', function () {
    dragging = null
    // A stray click should clear the crop rather than leave a sliver.
    if (state.crop && (state.crop.width < 0.02 || state.crop.height < 0.02)) state.crop = null
    render()
  })

  // ---- rendering ----

  function cssFilter() {
    var parts = []
    if (state.brightness !== 1) parts.push('brightness(' + state.brightness + ')')
    if (state.contrast !== 1) parts.push('contrast(' + state.contrast + ')')
    if (state.saturation !== 1) parts.push('saturate(' + state.saturation + ')')
    if (state.greyscale) parts.push('grayscale(1)')
    if (state.blur > 0) {
      // The preview is displayed smaller than the original, so a blur radius in
      // source pixels must be scaled down to look the same here.
      var shown = img.getBoundingClientRect().width || 1
      var scale = shown / (img.naturalWidth || shown)
      parts.push('blur(' + (state.blur * scale).toFixed(2) + 'px)')
    }
    return parts.join(' ')
  }

  function cssTransform() {
    var parts = []
    if (state.rotate) parts.push('rotate(' + state.rotate + 'deg)')
    if (state.flop) parts.push('scaleX(-1)')
    if (state.flip) parts.push('scaleY(-1)')
    if (Math.abs(state.rotate % 180) === 90 && img.naturalWidth) {
      var ratio = Math.min(img.naturalWidth, img.naturalHeight) / Math.max(img.naturalWidth, img.naturalHeight)
      parts.push('scale(' + ratio.toFixed(3) + ')')
    }
    return parts.join(' ')
  }

  /** Build the recipe. Order is fixed and deliberate, not the click order. */
  function buildRecipe() {
    var ops = []
    if (state.rotate) ops.push({ op: 'rotate', angle: state.rotate })
    if (state.flop) ops.push({ op: 'flop' })
    if (state.flip) ops.push({ op: 'flip' })
    // Crop after orientation, because the selection was made on the rotated view.
    if (state.crop && state.crop.width > 0.02 && state.crop.height > 0.02) {
      ops.push({
        op: 'crop',
        x: Number(state.crop.x.toFixed(4)),
        y: Number(state.crop.y.toFixed(4)),
        width: Number(state.crop.width.toFixed(4)),
        height: Number(state.crop.height.toFixed(4)),
      })
    }
    if (state.brightness !== 1) ops.push({ op: 'brightness', value: state.brightness })
    if (state.contrast !== 1) ops.push({ op: 'contrast', value: state.contrast })
    if (state.saturation !== 1) ops.push({ op: 'saturation', value: state.saturation })
    if (state.greyscale) ops.push({ op: 'greyscale' })
    if (state.blur > 0) ops.push({ op: 'blur', sigma: state.blur })
    if (state.sharpen > 0) ops.push({ op: 'sharpen', sigma: state.sharpen })
    // Text last, so adjustments do not wash out the caption.
    if (state.text.trim()) {
      ops.push({
        op: 'text',
        text: state.text.trim(),
        x: 0.5,
        y: 0.5,
        size: state.textSize,
        color: state.textColor,
        weight: '700',
      })
    }
    return { version: 1, ops: ops }
  }

  function renderCropBox() {
    if (!state.crop) {
      cropBox.hidden = true
      return
    }
    var box = img.getBoundingClientRect()
    var frameBox = frame.getBoundingClientRect()
    cropBox.hidden = false
    cropBox.style.left = box.left - frameBox.left + state.crop.x * box.width + 'px'
    cropBox.style.top = box.top - frameBox.top + state.crop.y * box.height + 'px'
    cropBox.style.width = state.crop.width * box.width + 'px'
    cropBox.style.height = state.crop.height * box.height + 'px'

    if (img.naturalWidth) {
      cropLabel.textContent =
        Math.round(state.crop.width * img.naturalWidth) + '×' + Math.round(state.crop.height * img.naturalHeight)
    }
  }

  function renderCaption() {
    var existing = frame.querySelector('.editor-caption')
    if (existing) existing.remove()
    if (!state.text.trim()) return
    var node = document.createElement('div')
    node.className = 'editor-caption'
    node.textContent = state.text
    node.style.color = state.textColor
    node.style.fontSize = state.textSize * (img.getBoundingClientRect().height || 300) + 'px'
    frame.appendChild(node)
  }

  function render() {
    img.style.transform = cssTransform()
    img.style.filter = cssFilter()

    Array.prototype.forEach.call(form.querySelectorAll('[data-out]'), function (out) {
      var key = out.getAttribute('data-out')
      var value = key === 'textSize' ? state.textSize : state[key]
      out.textContent = typeof value === 'number' ? value.toFixed(key === 'blur' || key === 'sharpen' ? 1 : 2) : value
    })

    renderCropBox()
    renderCaption()

    var recipe = buildRecipe()
    recipeField.value = JSON.stringify(recipe)

    if (summary) {
      summary.textContent = recipe.ops.length
        ? recipe.ops.length + ' change' + (recipe.ops.length === 1 ? '' : 's') + ' will be applied at full resolution'
        : 'No changes yet.'
    }
    if (hint) {
      hint.textContent = state.crop
        ? 'Crop selected. Drag again to change it, or click once to clear.'
        : 'Drag on the image to select a crop area.'
    }
  }

  img.addEventListener('load', render)
  render()
})()
