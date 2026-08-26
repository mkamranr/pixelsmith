// Shared large-canvas workspace.
//
// One image shown big, with navigation across the batch, and the current
// settings drawn over it so the effect is visible before anything is submitted.
// Everything here is enhancement: the form is a plain multipart POST and works
// with this file absent.
'use strict'
;(function () {
  var MAX_FILES = 60

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function humanBytes(bytes) {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / 1048576).toFixed(2) + ' MB'
  }

  function Canvas(form) {
    var self = this
    this.form = form
    this.mode = form.getAttribute('data-preview') || 'none'
    this.input = form.querySelector('[data-file-input]')
    this.stage = form.querySelector('[data-stage]')
    this.view = form.querySelector('[data-view]')
    this.plate = form.querySelector('[data-plate]')
    this.image = form.querySelector('[data-canvas-image]')
    this.nameLabel = form.querySelector('[data-canvas-name]')
    this.sizeLabel = form.querySelector('[data-canvas-sizes]')
    this.nav = form.querySelector('[data-nav]')
    this.navSelect = form.querySelector('[data-nav-select]')
    this.addButton = form.querySelector('[data-add-more]')
    this.summary = form.querySelector('[data-summary]')
    this.removeButton = form.querySelector('[data-remove-current]')

    this.entries = []
    this.active = 0

    if (!this.input) return

    this.input.addEventListener('change', function () { self.add(self.input.files) })
    if (this.addButton) this.addButton.addEventListener('click', function () { self.input.click() })
    if (this.removeButton) {
      this.removeButton.addEventListener('click', function () { self.remove(self.active) })
    }

    if (this.navSelect) {
      this.navSelect.addEventListener('change', function () { self.show(Number(self.navSelect.value)) })
    }
    Array.prototype.forEach.call(form.querySelectorAll('[data-step]'), function (button) {
      button.addEventListener('click', function () {
        self.show(self.active + Number(button.getAttribute('data-step')))
      })
    })

    this.wireDrop()
    this.image.addEventListener('load', function () {
      var entry = self.entries[self.active]
      if (entry) {
        entry.width = self.image.naturalWidth
        entry.height = self.image.naturalHeight
      }
      self.draw()
    })

    // Settings changes redraw the overlay.
    form.addEventListener('input', function () { self.applyConditionals(); self.draw() })
    form.addEventListener('change', function () { self.applyConditionals(); self.draw() })
    form.addEventListener('submit', function () { self.syncInput() })

    this.applyConditionals()
  }

  Canvas.prototype.wireDrop = function () {
    var self = this
    var zone = this.stage
    ;['dragenter', 'dragover'].forEach(function (name) {
      zone.addEventListener(name, function (e) {
        e.preventDefault()
        zone.classList.add('is-over')
      })
    })
    ;['dragleave', 'drop'].forEach(function (name) {
      zone.addEventListener(name, function () { zone.classList.remove('is-over') })
    })
    zone.addEventListener('drop', function (e) {
      e.preventDefault()
      if (e.dataTransfer && e.dataTransfer.files.length) self.add(e.dataTransfer.files)
    })
  }

  Canvas.prototype.add = function (list) {
    var self = this
    Array.prototype.forEach.call(list, function (file) {
      if (self.entries.length >= MAX_FILES) return
      var duplicate = self.entries.some(function (e) {
        return e.file.name === file.name && e.file.size === file.size
      })
      if (duplicate) return
      self.entries.push({ file: file, url: URL.createObjectURL(file), width: 0, height: 0 })
    })
    this.syncInput()
    this.render()
    this.show(this.entries.length ? this.active : 0)
  }

  Canvas.prototype.remove = function (index) {
    var entry = this.entries[index]
    if (!entry) return
    URL.revokeObjectURL(entry.url)
    this.entries.splice(index, 1)
    this.syncInput()
    this.render()
    this.show(Math.min(index, this.entries.length - 1))
  }

  /** Keep the real file input in step with the list shown. */
  Canvas.prototype.syncInput = function () {
    if (typeof DataTransfer === 'undefined') return
    var transfer = new DataTransfer()
    this.entries.forEach(function (entry) { transfer.items.add(entry.file) })
    this.input.files = transfer.files
  }

  Canvas.prototype.render = function () {
    var has = this.entries.length > 0
    this.stage.classList.toggle('has-files', has)
    this.view.hidden = !has
    if (this.nav) this.nav.hidden = this.entries.length < 2
    if (this.addButton) this.addButton.hidden = !has
    if (this.removeButton) this.removeButton.hidden = !has

    Array.prototype.forEach.call(this.form.querySelectorAll('[data-file-count]'), function (node) {
      node.textContent = String(this.entries.length)
    }.bind(this))

    if (this.navSelect) {
      this.navSelect.innerHTML = ''
      this.entries.forEach(function (entry, index) {
        var option = el('option', null, entry.file.name)
        option.value = String(index)
        this.navSelect.appendChild(option)
      }.bind(this))
    }

    if (this.summary) {
      var bytes = this.entries.reduce(function (sum, e) { return sum + e.file.size }, 0)
      this.summary.textContent = this.entries.length
        ? this.entries.length + ' file' + (this.entries.length === 1 ? '' : 's') + ', ' + humanBytes(bytes)
        : ''
    }
  }

  Canvas.prototype.show = function (index) {
    if (!this.entries.length) return
    this.active = Math.max(0, Math.min(this.entries.length - 1, index))
    var entry = this.entries[this.active]
    this.image.src = entry.url
    this.image.alt = entry.file.name
    if (this.nameLabel) this.nameLabel.textContent = entry.file.name
    if (this.navSelect) this.navSelect.value = String(this.active)
    this.draw()
  }

  Canvas.prototype.value = function (name) {
    var field = this.form.elements[name]
    if (!field) return undefined
    if (field.type === 'checkbox') return field.checked
    // A radio group returns a RadioNodeList, whose .value is the checked one.
    return field.value
  }

  Canvas.prototype.applyConditionals = function () {
    var form = this.form
    Array.prototype.forEach.call(form.querySelectorAll('[data-show-when-field]'), function (node) {
      var source = form.elements[node.getAttribute('data-show-when-field')]
      if (!source) return
      var allowed = (node.getAttribute('data-show-when-equals') || '').split(',')
      var current = source.type === 'checkbox' ? String(source.checked) : source.value
      node.hidden = allowed.indexOf(current) === -1
    })
  }

  /** Clear and redraw the overlay for the visible image. */
  Canvas.prototype.draw = function () {
    var entry = this.entries[this.active]
    if (!entry || !this.plate) return

    Array.prototype.forEach.call(
      this.plate.querySelectorAll('.ov'),
      function (node) { node.remove() },
    )
    this.image.style.transform = ''
    this.image.style.filter = ''

    this.drawSizes(entry)

    switch (this.mode) {
      case 'transform': return this.drawTransform(entry)
      case 'caption': return this.drawCaption(entry)
      case 'watermark': return this.drawWatermark(entry)
      case 'crop': return this.drawCrop(entry)
      default: return undefined
    }
  }

  /** Before → after chips, computed from this image's own dimensions. */
  Canvas.prototype.drawSizes = function (entry) {
    if (!this.sizeLabel || !entry.width) return
    this.sizeLabel.innerHTML = ''

    var before = el('span', 'size-chip', entry.width + ' × ' + entry.height)
    this.sizeLabel.appendChild(before)

    var target = this.targetSize(entry)
    if (target) {
      this.sizeLabel.appendChild(el('span', 'size-arrow', '→'))
      this.sizeLabel.appendChild(el('span', 'size-chip is-after', target))
    }

    var format = this.value('to') || this.value('format')
    if (format && format !== 'keep') {
      this.sizeLabel.appendChild(el('span', 'size-chip is-after', String(format).toUpperCase()))
    }
    var kb = this.value('targetKb')
    if (kb) this.sizeLabel.appendChild(el('span', 'size-chip is-after', '≤ ' + kb + ' KB'))
  }

  Canvas.prototype.targetSize = function (entry) {
    var scale = this.value('scale')
    if (scale) return entry.width * Number(scale) + ' × ' + entry.height * Number(scale)

    if (this.value('mode') === 'percent') {
      var pct = Number(this.value('percent') || 100) / 100
      return Math.round(entry.width * pct) + ' × ' + Math.round(entry.height * pct)
    }

    var w = Number(this.value('width') || 0)
    var h = Number(this.value('height') || 0)
    if (!w && !h) return null

    if (this.value('maintainAspect') === false) return (w || entry.width) + ' × ' + (h || entry.height)

    var ratio = w && h ? Math.min(w / entry.width, h / entry.height) : w ? w / entry.width : h / entry.height
    if (this.value('noEnlarge') && ratio > 1) ratio = 1
    return Math.round(entry.width * ratio) + ' × ' + Math.round(entry.height * ratio)
  }

  Canvas.prototype.drawTransform = function (entry) {
    var angle = Number(this.value('angle') || 0)
    var parts = []
    if (angle) parts.push('rotate(' + angle + 'deg)')
    if (this.value('flop')) parts.push('scaleX(-1)')
    if (this.value('flip')) parts.push('scaleY(-1)')

    // A quarter turn must be scaled to stay inside the plate.
    if (Math.abs(angle % 180) === 90 && entry.width) {
      var box = this.image.getBoundingClientRect()
      var plate = this.plate.getBoundingClientRect()
      var fit = Math.min(plate.width / box.height, plate.height / box.width, 1)
      if (fit < 1) parts.push('scale(' + fit.toFixed(3) + ')')
    }
    this.image.style.transform = parts.join(' ')
  }

  Canvas.prototype.drawCaption = function () {
    var box = this.image.getBoundingClientRect()
    var size = Math.max(11, box.height / 10)
    var top = this.value('top')
    var bottom = this.value('bottom')
    var upper = this.value('uppercase')

    if (top) this.plate.appendChild(this.captionNode(top, 'is-top', size, upper))
    if (bottom) this.plate.appendChild(this.captionNode(bottom, 'is-bottom', size, upper))
  }

  Canvas.prototype.captionNode = function (text, position, size, upper) {
    var node = el('div', 'ov thumb-caption ' + position, upper ? text.toUpperCase() : text)
    node.style.fontSize = size + 'px'
    var box = this.image.getBoundingClientRect()
    var plate = this.plate.getBoundingClientRect()
    node.style.left = box.left - plate.left + 6 + 'px'
    node.style.width = box.width - 12 + 'px'
    if (position === 'is-top') node.style.top = box.top - plate.top + 8 + 'px'
    else node.style.top = box.top - plate.top + box.height - size * 1.3 + 'px'
    return node
  }

  Canvas.prototype.drawWatermark = function () {
    var text = this.value('text')
    if (!text) return
    var colour = this.value('color') || '#ffffff'
    var opacity = Number(this.value('opacity') || 45) / 100
    var box = this.image.getBoundingClientRect()
    var plate = this.plate.getBoundingClientRect()
    var offsetX = box.left - plate.left
    var offsetY = box.top - plate.top
    var size = Math.max(9, box.width / 18)

    if (this.value('tiled')) {
      var wrap = el('div', 'ov mark-tiled')
      wrap.style.left = offsetX + 'px'
      wrap.style.top = offsetY + 'px'
      wrap.style.width = box.width + 'px'
      wrap.style.height = box.height + 'px'
      wrap.style.color = colour
      wrap.style.opacity = String(opacity)
      wrap.style.fontSize = size + 'px'
      for (var i = 0; i < 12; i++) wrap.appendChild(el('span', null, text))
      this.plate.appendChild(wrap)
      return
    }

    var mark = el('div', 'ov mark-single', text)
    mark.style.color = colour
    mark.style.opacity = String(opacity)
    mark.style.fontSize = size + 'px'
    var pad = size * 0.75
    var position = this.value('position') || 'bottom-right'

    if (position === 'center') {
      mark.style.left = offsetX + box.width / 2 + 'px'
      mark.style.top = offsetY + box.height / 2 + 'px'
      mark.style.transform = 'translate(-50%, -50%)'
    } else {
      if (position.indexOf('top') === 0) mark.style.top = offsetY + pad + 'px'
      else mark.style.top = offsetY + box.height - pad - size + 'px'
      if (position.indexOf('left') > -1) mark.style.left = offsetX + pad + 'px'
      else {
        mark.style.left = offsetX + box.width - pad + 'px'
        mark.style.transform = 'translateX(-100%)'
      }
    }
    this.plate.appendChild(mark)
  }

  Canvas.prototype.drawCrop = function (entry) {
    if (!entry.width) return
    var x = Number(this.value('x') || 0)
    var y = Number(this.value('y') || 0)
    var w = Number(this.value('width') || 0)
    var h = Number(this.value('height') || 0)
    if (!w || !h) return

    var box = this.image.getBoundingClientRect()
    var plate = this.plate.getBoundingClientRect()
    var scale = box.width / entry.width

    var overlay = el('div', 'ov crop-overlay')
    overlay.style.left = box.left - plate.left + x * scale + 'px'
    overlay.style.top = box.top - plate.top + y * scale + 'px'
    overlay.style.width = Math.min(w, entry.width - x) * scale + 'px'
    overlay.style.height = Math.min(h, entry.height - y) * scale + 'px'
    this.plate.appendChild(overlay)
  }

  var canvases = []
  Array.prototype.forEach.call(document.querySelectorAll('form[data-canvas-form]'), function (form) {
    canvases.push(new Canvas(form))
  })
  window.addEventListener('resize', function () {
    canvases.forEach(function (c) { c.draw() })
  })
})()
