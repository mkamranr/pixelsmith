// Marking areas on a photo.
//
// Detection misses faces, and the person looking at the picture can see the one
// it missed. Until now the marked areas could only be sent as JSON through the
// API, which is no use at all to somebody in front of a browser — so a face the
// detector did not find could not be dealt with by the only party who knew.
//
// The areas are kept in SOURCE pixels, which is what the server acts on, and
// drawn scaled to however large the picture happens to be rendered.
//
// They are keyed by file name rather than by position in the upload. Removing
// the second of three photos shifts every index after it, and an area that
// silently moved onto the wrong photo would leave a face showing in a picture
// the operator had dealt with.
'use strict'
;(function () {
  var form = document.querySelector('[data-canvas-form]')
  if (!form) return

  var layer = form.querySelector('[data-image-boxes]')
  var image = form.querySelector('[data-canvas-image]')
  if (!layer || !image) return

  var field = form.querySelector('[name="' + (layer.getAttribute('data-boxes-field') || 'regions') + '"]')
  if (!field) return

  var fileInput = form.querySelector('[data-file-input]')
  var countLabel = form.querySelector('[data-box-count]')
  var clearButton = form.querySelector('[data-box-clear]')

  /** Smaller than this is a stray click rather than an area, in source pixels. */
  var MIN = 6

  var marks = Object.create(null) // file name -> areas, in source pixels
  var current = ''
  var natural = { width: 0, height: 0 }
  var selected = -1
  var drag = null

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value))
  }

  function areas() {
    if (!current) return []
    if (!marks[current]) marks[current] = []
    return marks[current]
  }

  function scale() {
    return natural.width ? image.clientWidth / natural.width : 1
  }

  /**
   * The picture is centred in the plate and may be letterboxed, so the layer is
   * placed over the rendered image rather than over its container.
   */
  function place() {
    layer.style.left = image.offsetLeft + 'px'
    layer.style.top = image.offsetTop + 'px'
    layer.style.width = image.clientWidth + 'px'
    layer.style.height = image.clientHeight + 'px'
  }

  function pointIn(event) {
    var box = layer.getBoundingClientRect()
    var k = scale() || 1
    return {
      x: clamp((event.clientX - box.left) / k, 0, natural.width),
      y: clamp((event.clientY - box.top) / k, 0, natural.height),
    }
  }

  var GRIPS = ['nw', 'ne', 'se', 'sw']

  function render() {
    place()
    layer.textContent = ''
    var k = scale()

    areas().forEach(function (area, index) {
      var mark = document.createElement('div')
      mark.className = 'box-mark' + (index === selected ? ' is-selected' : '')
      mark.style.left = area.x * k + 'px'
      mark.style.top = area.y * k + 'px'
      mark.style.width = area.width * k + 'px'
      mark.style.height = area.height * k + 'px'
      mark.setAttribute('data-box', String(index))

      GRIPS.forEach(function (grip) {
        var handle = document.createElement('span')
        handle.className = 'box-grip box-grip-' + grip
        handle.setAttribute('data-grip', grip)
        mark.appendChild(handle)
      })

      var drop = document.createElement('button')
      drop.type = 'button'
      drop.className = 'box-drop'
      drop.setAttribute('data-drop', String(index))
      drop.setAttribute('aria-label', 'Remove this area')
      drop.textContent = '×'
      mark.appendChild(drop)

      layer.appendChild(mark)
    })
  }

  /**
   * Writes the field the server reads. The photo index is resolved here, from
   * the file input as it stands now, because that is the list being uploaded and
   * its order is the only one the server will see.
   */
  function sync() {
    var indexByName = Object.create(null)
    var list = fileInput && fileInput.files ? fileInput.files : []
    for (var i = 0; i < list.length; i += 1) {
      if (!(list[i].name in indexByName)) indexByName[list[i].name] = i
    }

    var out = []
    Object.keys(marks).forEach(function (name) {
      if (!(name in indexByName)) return // that photo is no longer being uploaded
      marks[name].forEach(function (area) {
        if (area.width < MIN || area.height < MIN) return
        out.push({
          file: indexByName[name],
          x: Math.round(area.x),
          y: Math.round(area.y),
          width: Math.round(area.width),
          height: Math.round(area.height),
        })
      })
    })

    field.value = out.length ? JSON.stringify(out) : ''

    var here = areas().length
    if (countLabel) {
      countLabel.textContent = here ? here + (here === 1 ? ' area marked' : ' areas marked') : ''
    }
    if (clearButton) clearButton.hidden = here === 0
  }

  function commit() {
    render()
    sync()
  }

  function remove(index) {
    areas().splice(index, 1)
    selected = -1
    commit()
  }

  function resizeTo(area, origin, grip, at) {
    var left = origin.x
    var top = origin.y
    var right = origin.x + origin.width
    var bottom = origin.y + origin.height

    if (grip === 'nw' || grip === 'sw') left = at.x
    if (grip === 'ne' || grip === 'se') right = at.x
    if (grip === 'nw' || grip === 'ne') top = at.y
    if (grip === 'sw' || grip === 'se') bottom = at.y

    area.x = Math.min(left, right)
    area.y = Math.min(top, bottom)
    area.width = Math.abs(right - left)
    area.height = Math.abs(bottom - top)
  }

  layer.addEventListener('pointerdown', function (event) {
    if (!natural.width && !adopt()) return

    var dropped = event.target.closest('[data-drop]')
    if (dropped) {
      remove(Number(dropped.getAttribute('data-drop')))
      return
    }

    var at = pointIn(event)
    var onBox = event.target.closest('[data-box]')
    var onGrip = event.target.closest('[data-grip]')

    if (onBox) {
      selected = Number(onBox.getAttribute('data-box'))
      var origin = areas()[selected]
      if (!origin) return
      drag = {
        kind: onGrip ? 'resize' : 'move',
        grip: onGrip ? onGrip.getAttribute('data-grip') : null,
        from: at,
        origin: { x: origin.x, y: origin.y, width: origin.width, height: origin.height },
      }
    } else {
      areas().push({ x: at.x, y: at.y, width: 0, height: 0 })
      selected = areas().length - 1
      drag = { kind: 'new', from: at }
    }

    try {
      layer.setPointerCapture(event.pointerId)
    } catch {
      // No capture: the drag still works, it just stops tracking outside.
    }
    layer.focus({ preventScroll: true })
    render()
    event.preventDefault()
  })

  layer.addEventListener('pointermove', function (event) {
    if (!drag) return
    var area = areas()[selected]
    if (!area) return
    var at = pointIn(event)

    if (drag.kind === 'new') {
      area.x = Math.min(drag.from.x, at.x)
      area.y = Math.min(drag.from.y, at.y)
      area.width = Math.abs(at.x - drag.from.x)
      area.height = Math.abs(at.y - drag.from.y)
    } else if (drag.kind === 'move') {
      area.x = clamp(drag.origin.x + (at.x - drag.from.x), 0, natural.width - drag.origin.width)
      area.y = clamp(drag.origin.y + (at.y - drag.from.y), 0, natural.height - drag.origin.height)
    } else {
      resizeTo(area, drag.origin, drag.grip, at)
    }

    render()
  })

  function finishDrag() {
    if (!drag) return
    drag = null
    var area = areas()[selected]
    // A click that drew nothing, or an area too small to be a face.
    if (area && (area.width < MIN || area.height < MIN)) {
      areas().splice(selected, 1)
      selected = -1
    }
    commit()
  }

  layer.addEventListener('pointerup', finishDrag)
  layer.addEventListener('pointercancel', finishDrag)

  /**
   * The keys belong to the layer, which takes focus when an area is touched, so
   * Delete means "remove this area" only while the picture is what is being
   * worked on. Listening on the document instead meant guessing whether some
   * other element wanted the key — and guessing wrong: choosing a photo leaves
   * focus on the file input, which is invisible here, so Delete was being
   * declined for a text field nobody was typing in.
   */
  layer.setAttribute('tabindex', '0')

  layer.addEventListener('keydown', function (event) {
    if (selected < 0 || drag) return

    if (event.key === 'Delete' || event.key === 'Backspace') {
      remove(selected)
      event.preventDefault()
    } else if (event.key === 'Escape') {
      selected = -1
      render()
    }
  })

  if (clearButton) {
    clearButton.addEventListener('click', function () {
      marks[current] = []
      selected = -1
      commit()
    })
  }

  /**
   * Following the picture on screen rather than reaching into the script that
   * manages it: every change of image sets a new src, and the load that follows
   * says the size and the name are both settled.
   */
  function adopt() {
    if (!image.naturalWidth) return false
    var changed = image.naturalWidth !== natural.width || (image.alt || '') !== current
    natural = { width: image.naturalWidth, height: image.naturalHeight }
    current = image.alt || ''
    if (changed) selected = -1
    return true
  }

  image.addEventListener('load', function () {
    if (adopt()) commit()
  })

  // A picture already decoded by the time this runs — served from cache, or this
  // script arriving late — fires no load event at all, and the editor would sit
  // there doing nothing.
  if (image.complete && adopt()) commit()

  window.addEventListener('resize', function () {
    if (natural.width) render()
  })

  // The last word on what is submitted: photos can be removed after the last
  // area was drawn, which changes what the indices mean.
  form.addEventListener('submit', sync)
})()
