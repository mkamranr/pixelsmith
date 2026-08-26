// Before/after comparison slider on the results page.
//
// Without this script both images are still present and downloadable — the
// divider simply sits at its default position. Keyboard accessible, because a
// drag-only control excludes anyone not using a mouse.
'use strict'
;(function () {
  function wire(root) {
    var frame = root.querySelector('[data-compare-frame]')
    var before = root.querySelector('[data-compare-before]')
    var handle = root.querySelector('[data-compare-handle]')
    if (!frame || !before || !handle) return

    var position = 50

    function apply() {
      before.style.width = position + '%'
      handle.style.left = position + '%'
      handle.setAttribute('aria-valuenow', String(Math.round(position)))
    }

    function fromPointer(event) {
      var box = frame.getBoundingClientRect()
      if (!box.width) return
      position = Math.min(100, Math.max(0, ((event.clientX - box.left) / box.width) * 100))
      apply()
    }

    var dragging = false
    frame.addEventListener('pointerdown', function (event) {
      dragging = true
      frame.setPointerCapture(event.pointerId)
      fromPointer(event)
      event.preventDefault()
    })
    frame.addEventListener('pointermove', function (event) {
      if (dragging) fromPointer(event)
    })
    frame.addEventListener('pointerup', function () {
      dragging = false
    })

    handle.addEventListener('keydown', function (event) {
      var step = event.shiftKey ? 10 : 2
      if (event.key === 'ArrowLeft') position = Math.max(0, position - step)
      else if (event.key === 'ArrowRight') position = Math.min(100, position + step)
      else if (event.key === 'Home') position = 0
      else if (event.key === 'End') position = 100
      else return
      event.preventDefault()
      apply()
    })

    apply()
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-compare]'), wire)
})()
