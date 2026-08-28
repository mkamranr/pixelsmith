// Putting things on a page: words, a box, a highlight, a picture.
//
// Positions are kept as fractions of the page, never as pixels. The page is
// rendered at whatever the zoom happens to be and re-rendered when it changes,
// so a pixel offset is only true until someone zooms — a lesson from the
// comparison view, where marks drifted away from the words they named.
//
// The kinds are presets rather than a panel of controls: a highlight is a yellow
// box at a third opacity, and offering "colour" and "opacity" separately would
// be three decisions where one will do.
'use strict'
;(function () {
  var root = document.querySelector('[data-pdf-items]')
  if (!root) return

  var form = root.closest('form')
  var holder = form && form.querySelector('[data-pdf-holder]')
  var overlay = form && form.querySelector('[data-pdf-overlay]')
  var field = form && form.querySelector('[name="items"]')
  var pictureInput = form && form.querySelector('[name="image"]')
  if (!form || !holder || !overlay || !field) return

  var items = []
  var selected = -1
  var page = 1
  var drag = null

  var PRESETS = {
    text: { kind: 'text', text: 'Type here', size: 14, colour: 'black', width: 0.3 },
    box: { kind: 'box', colour: 'black', outline: true, width: 0.3, height: 0.1 },
    highlight: { kind: 'box', colour: 'yellow', opacity: 0.35, width: 0.3, height: 0.04 },
    image: { kind: 'image', width: 0.25 },
  }

  var COLOURS = { black: '#1a1a1f', blue: '#17308c', red: '#b82020', green: '#155c31', yellow: '#fadb33' }

  function write() {
    field.value = items.length
      ? JSON.stringify(
          items.map(function (item) {
            var out = {
              kind: item.kind,
              page: item.page,
              x: Number(item.x.toFixed(4)),
              y: Number(item.y.toFixed(4)),
            }
            if (item.width) out.width = Number(item.width.toFixed(4))
            if (item.height) out.height = Number(item.height.toFixed(4))
            if (item.kind === 'text') {
              out.text = item.text
              out.size = item.size
            }
            if (item.colour) out.colour = item.colour
            if (item.opacity && item.opacity < 1) out.opacity = item.opacity
            if (item.outline) out.outline = true
            return out
          }),
        )
      : ''

    var count = items.length
    var note = root.querySelector('[data-pdf-items-count]')
    if (note) note.textContent = count ? count + (count === 1 ? ' thing added' : ' things added') : ''
  }

  function add(kind) {
    var preset = PRESETS[kind]
    if (!preset) return
    if (kind === 'image' && !(pictureInput && pictureInput.files && pictureInput.files.length)) {
      var warn = root.querySelector('[data-pdf-items-count]')
      if (warn) warn.textContent = 'Choose a picture below first.'
      return
    }

    var item = {}
    Object.keys(preset).forEach(function (key) {
      item[key] = preset[key]
    })
    // Dropped near the top left of the page rather than centred: a stamp or a
    // note usually belongs at an edge, and it is one drag from anywhere.
    item.page = page
    item.x = 0.12
    item.y = 0.12 + (items.filter(function (other) { return other.page === page }).length % 6) * 0.06
    items.push(item)
    selected = items.length - 1
    render()
    write()
  }

  function remove(index) {
    items.splice(index, 1)
    selected = -1
    render()
    write()
  }

  function percent(value) {
    return value * 100 + '%'
  }

  function render() {
    overlay.textContent = ''

    items.forEach(function (item, index) {
      if (item.page !== page) return

      var node = document.createElement('div')
      node.className = 'pdf-item is-' + item.kind + (index === selected ? ' is-selected' : '')
      node.setAttribute('data-pdf-item', String(index))
      node.style.left = percent(item.x)
      node.style.top = percent(item.y)
      if (item.width) node.style.width = percent(item.width)
      if (item.height) node.style.height = percent(item.height)

      if (item.kind === 'text') {
        var words = document.createElement('span')
        words.className = 'pdf-item-text'
        words.textContent = item.text
        words.style.color = COLOURS[item.colour] || COLOURS.black
        // Sized against the page, so what is on screen matches the result at
        // any zoom.
        words.style.fontSize = percent((item.size / 842) * 1.35)
        node.appendChild(words)
      } else if (item.kind === 'box') {
        node.style.background = item.outline ? 'transparent' : COLOURS[item.colour] || COLOURS.black
        node.style.opacity = String(item.opacity || 1)
        if (item.outline) node.style.borderColor = COLOURS[item.colour] || COLOURS.black
      } else {
        node.classList.add('is-picture')
        node.textContent = 'picture'
      }

      var grip = document.createElement('span')
      grip.className = 'pdf-item-grip'
      grip.setAttribute('data-pdf-item-grip', String(index))
      node.appendChild(grip)

      var drop = document.createElement('button')
      drop.type = 'button'
      drop.className = 'pdf-item-drop'
      drop.setAttribute('data-pdf-item-drop', String(index))
      drop.setAttribute('aria-label', 'Remove this')
      drop.textContent = '×'
      node.appendChild(drop)

      overlay.appendChild(node)
    })
  }

  function pointIn(event) {
    var box = holder.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    }
  }

  /** Removing is a button, so it answers to a click — keyboard included. */
  overlay.addEventListener('click', function (event) {
    var dropped = event.target.closest('[data-pdf-item-drop]')
    if (dropped) remove(Number(dropped.getAttribute('data-pdf-item-drop')))
  })

  /** Show which thing is selected without rebuilding the overlay. */
  function mark() {
    Array.prototype.forEach.call(overlay.querySelectorAll('[data-pdf-item]'), function (node) {
      node.classList.toggle('is-selected', Number(node.getAttribute('data-pdf-item')) === selected)
    })
  }

  overlay.addEventListener('pointerdown', function (event) {
    // The remove button is not a handle to drag by.
    if (event.target.closest('[data-pdf-item-drop]')) return

    var onGrip = event.target.closest('[data-pdf-item-grip]')
    var onItem = event.target.closest('[data-pdf-item]')
    if (!onItem) return

    selected = Number(onItem.getAttribute('data-pdf-item'))
    var item = items[selected]
    if (!item) return

    drag = {
      kind: onGrip ? 'resize' : 'move',
      from: pointIn(event),
      origin: { x: item.x, y: item.y, width: item.width, height: item.height },
    }
    try {
      overlay.setPointerCapture(event.pointerId)
    } catch {
      // Without capture the drag stops at the edge, which is survivable.
    }

    /**
     * Selection is shown by adjusting classes, not by re-rendering. Rebuilding
     * here would detach the very element the drag started on, leaving the
     * gesture to survive only on pointer capture — which is exactly what broke
     * when there was none.
     */
    mark()
    event.preventDefault()
  })

  overlay.addEventListener('pointermove', function (event) {
    if (!drag) return
    var item = items[selected]
    if (!item) return
    var at = pointIn(event)

    if (drag.kind === 'move') {
      item.x = Math.min(1, Math.max(0, drag.origin.x + (at.x - drag.from.x)))
      item.y = Math.min(1, Math.max(0, drag.origin.y + (at.y - drag.from.y)))
    } else {
      item.width = Math.min(1, Math.max(0.02, (drag.origin.width || 0.2) + (at.x - drag.from.x)))
      if (item.kind !== 'text') {
        item.height = Math.min(1, Math.max(0.01, (drag.origin.height || 0.1) + (at.y - drag.from.y)))
      }
    }

    // Moved rather than rebuilt, for the same reason as above.
    var node = overlay.querySelector('[data-pdf-item="' + selected + '"]')
    if (node) {
      node.style.left = percent(item.x)
      node.style.top = percent(item.y)
      if (item.width) node.style.width = percent(item.width)
      if (item.height) node.style.height = percent(item.height)
    }
  })

  function finish() {
    if (!drag) return
    drag = null
    render()
    write()
  }

  overlay.addEventListener('pointerup', finish)
  overlay.addEventListener('pointercancel', finish)

  /** Typing into the selected words, and removing with the keyboard. */
  overlay.setAttribute('tabindex', '0')
  overlay.addEventListener('keydown', function (event) {
    if (selected < 0) return
    if (event.key === 'Delete' || event.key === 'Backspace') {
      remove(selected)
      event.preventDefault()
    } else if (event.key === 'Escape') {
      selected = -1
      render()
    }
  })

  overlay.addEventListener('dblclick', function (event) {
    var onItem = event.target.closest('[data-pdf-item]')
    if (!onItem) return
    var index = Number(onItem.getAttribute('data-pdf-item'))
    var item = items[index]
    if (!item || item.kind !== 'text') return

    // Edited in place: a dialogue would take the words away from the page they
    // are being positioned on.
    var words = onItem.querySelector('.pdf-item-text')
    words.setAttribute('contenteditable', 'true')
    words.focus()
    words.addEventListener('blur', function () {
      item.text = (words.textContent || '').trim() || 'Type here'
      words.removeAttribute('contenteditable')
      render()
      write()
    })
  })

  Array.prototype.forEach.call(root.querySelectorAll('[data-pdf-add]'), function (button) {
    button.addEventListener('click', function () {
      add(button.getAttribute('data-pdf-add'))
    })
  })

  Array.prototype.forEach.call(root.querySelectorAll('[data-pdf-item-colour]'), function (button) {
    button.addEventListener('click', function () {
      var item = items[selected]
      if (!item) return
      item.colour = button.getAttribute('data-pdf-item-colour')
      render()
      write()
    })
  })

  // The page underneath decides which items are on show.
  document.addEventListener('pixelsmith:pdfpage', function (event) {
    page = (event.detail && event.detail.page) || 1
    render()
  })

  render()
  write()
})()
