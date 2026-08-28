// The signature builder.
//
// Signing used to require already having a scanned signature as a file, or
// accepting your name set in Helvetica — which does not read as a signature.
// This adds the two ways people actually sign: drawing one, and picking a hand
// to set the name in.
//
// The tool's own fields stay authoritative. Drawing writes a PNG into the file
// input the tool already declares, and choosing a hand sets the `face` field
// the server already understands, so nothing here invents a second way for a
// signature to reach the document. With no script the fields still work.
'use strict'
;(function () {
  var root = document.querySelector('[data-signature]')
  if (!root) return

  var form = root.closest('form')
  if (!form) return

  var field = function (name) {
    return form.querySelector('[name="' + name + '"]')
  }

  var kind = field('kind')
  var fileInput = field('signatureFile')
  var nameInput = field('text')
  var pad = root.querySelector('[data-sig-pad]')
  var faceList = root.querySelector('[data-sig-faces]')
  if (!fileInput || !nameInput || !pad) return

  var HANDS = [
    { id: 'great-vibes', label: 'Formal', family: 'Great Vibes' },
    { id: 'dancing-script', label: 'Flowing', family: 'Dancing Script' },
    { id: 'caveat', label: 'Handwritten', family: 'Caveat' },
  ]

  var INK = { black: '#1a1a1f', blue: '#17308c', red: '#992020', green: '#155c31' }

  function chosenColour() {
    var picked = form.querySelector('[name="colour"]:checked') || field('colour')
    var value = picked ? picked.value : 'black'
    return INK[value] || INK.black
  }

  /** The segmented controls are radios; set one by value and announce it. */
  function setField(name, value) {
    var radios = form.querySelectorAll('[name="' + name + '"]')
    if (!radios.length) return
    if (radios.length === 1 && radios[0].type !== 'radio') {
      radios[0].value = value
      radios[0].dispatchEvent(new Event('change', { bubbles: true }))
      return
    }
    for (var i = 0; i < radios.length; i += 1) {
      if (radios[i].value === value) {
        radios[i].checked = true
        radios[i].dispatchEvent(new Event('change', { bubbles: true }))
        return
      }
    }
  }

  // ---- drawing -------------------------------------------------------------

  var ctx = pad.getContext('2d')
  var drawing = false
  var drawn = false
  var last = null

  function resetPad() {
    ctx.clearRect(0, 0, pad.width, pad.height)
    ctx.lineWidth = 3.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    drawn = false
    // An empty pad must not leave a stale signature behind on the form.
    if (fileInput.dataset.fromPad === 'yes') {
      fileInput.value = ''
      delete fileInput.dataset.fromPad
    }
  }

  function padPoint(event) {
    var box = pad.getBoundingClientRect()
    // The canvas is drawn at its own resolution and displayed at another, so
    // pointer coordinates have to be scaled or the ink lands away from the nib.
    return {
      x: ((event.clientX - box.left) / box.width) * pad.width,
      y: ((event.clientY - box.top) / box.height) * pad.height,
    }
  }

  pad.addEventListener('pointerdown', function (event) {
    drawing = true
    last = padPoint(event)
    ctx.strokeStyle = chosenColour()
    try {
      pad.setPointerCapture(event.pointerId)
    } catch {
      // Without capture the stroke stops at the edge, which is survivable.
    }
    event.preventDefault()
  })

  pad.addEventListener('pointermove', function (event) {
    if (!drawing) return
    var at = padPoint(event)
    ctx.beginPath()
    ctx.moveTo(last.x, last.y)
    ctx.lineTo(at.x, at.y)
    ctx.stroke()
    last = at
    drawn = true
  })

  function finishStroke() {
    if (!drawing) return
    drawing = false
    if (drawn) handOverDrawing()
  }

  pad.addEventListener('pointerup', finishStroke)
  pad.addEventListener('pointercancel', finishStroke)
  pad.addEventListener('pointerleave', finishStroke)

  /**
   * Trim to the ink before handing it over. The pad is wider than any signature
   * so there is room to sign; sending the whole canvas would place a mostly
   * empty rectangle on the page and shrink the writing to nothing.
   */
  function trimmed() {
    var pixels = ctx.getImageData(0, 0, pad.width, pad.height).data
    var minX = pad.width
    var minY = pad.height
    var maxX = -1
    var maxY = -1
    for (var y = 0; y < pad.height; y += 1) {
      for (var x = 0; x < pad.width; x += 1) {
        if (pixels[(y * pad.width + x) * 4 + 3] > 8) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX < 0) return null

    var pad_ = 8
    minX = Math.max(0, minX - pad_)
    minY = Math.max(0, minY - pad_)
    maxX = Math.min(pad.width - 1, maxX + pad_)
    maxY = Math.min(pad.height - 1, maxY + pad_)

    var out = document.createElement('canvas')
    out.width = maxX - minX + 1
    out.height = maxY - minY + 1
    out.getContext('2d').drawImage(pad, minX, minY, out.width, out.height, 0, 0, out.width, out.height)
    return out
  }

  function handOverDrawing() {
    var cropped = trimmed()
    if (!cropped || typeof DataTransfer === 'undefined') return

    cropped.toBlob(function (blob) {
      if (!blob) return
      var transfer = new DataTransfer()
      transfer.items.add(new File([blob], 'signature.png', { type: 'image/png' }))
      fileInput.files = transfer.files
      fileInput.dataset.fromPad = 'yes'
      // A drawing is an image signature as far as the server is concerned.
      setField('kind', 'image')
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    }, 'image/png')
  }

  var clear = root.querySelector('[data-sig-clear]')
  if (clear) clear.addEventListener('click', resetPad)

  // ---- typing --------------------------------------------------------------

  /**
   * The same faces the workers draw with, served from this host and shown here
   * so the choice is made by looking rather than by reading three labels.
   */
  function renderFaces() {
    if (!faceList) return
    var name = (nameInput.value || 'Your name').slice(0, 40)
    faceList.textContent = ''

    HANDS.forEach(function (hand) {
      var item = document.createElement('li')
      var button = document.createElement('button')
      button.type = 'button'
      button.className = 'sig-face'
      button.setAttribute('data-sig-face', hand.id)
      button.style.fontFamily = '"' + hand.family + '", cursive'
      button.style.color = chosenColour()
      button.textContent = name
      button.setAttribute('aria-label', hand.label + ': ' + name)

      var picked = form.querySelector('[name="face"]:checked')
      if (picked && picked.value === hand.id) button.classList.add('is-active')

      button.addEventListener('click', function () {
        setField('kind', 'text')
        setField('face', hand.id)
        renderFaces()
      })

      item.appendChild(button)
      faceList.appendChild(item)
    })
  }

  nameInput.addEventListener('input', renderFaces)
  form.addEventListener('change', function (event) {
    if (event.target && event.target.name === 'colour') {
      renderFaces()
      if (drawn) handOverDrawing()
    }
  })

  // ---- the three modes -----------------------------------------------------

  var modes = [].slice.call(root.querySelectorAll('[data-sig-mode]'))
  var panes = [].slice.call(root.querySelectorAll('[data-sig-pane]'))

  function show(mode) {
    modes.forEach(function (button) {
      button.classList.toggle('is-active', button.getAttribute('data-sig-mode') === mode)
      button.setAttribute('aria-selected', String(button.getAttribute('data-sig-mode') === mode))
    })
    panes.forEach(function (pane) {
      pane.hidden = pane.getAttribute('data-sig-pane') !== mode
    })
    // Typing and the other two mean different things to the server.
    setField('kind', mode === 'type' ? 'text' : 'image')
    if (mode === 'type') renderFaces()
  }

  modes.forEach(function (button) {
    button.addEventListener('click', function () {
      show(button.getAttribute('data-sig-mode'))
    })
  })

  resetPad()
  // Drawing is where most people start, and it is the thing that was missing.
  show(kind && kind.value === 'text' ? 'type' : 'draw')
})()
