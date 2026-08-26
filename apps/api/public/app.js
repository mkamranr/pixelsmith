// Pixelsmith progressive enhancement.
//
// Nothing here is required for the app to work: forms post normally, and the job
// page falls back to a meta refresh. What this adds is the workspace — seeing
// what you uploaded, and seeing what the settings will do to it before you
// commit.
'use strict'
;(function () {
  var MAX_PREVIEW_FILES = 60

  function humanBytes(bytes) {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / 1048576).toFixed(2) + ' MB'
  }

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  /**
   * Holds the chosen files and keeps the real <input type=file> in step with
   * them, so adding and removing individual files works — a file input on its
   * own can only replace its whole selection.
   */
  function FileStage(form) {
    var self = this
    this.form = form
    this.input = form.querySelector('[data-file-input]')
    this.stage = form.querySelector('[data-stage]')
    this.grid = form.querySelector('[data-thumbs]')
    this.head = form.querySelector('[data-stage-head]')
    this.hint = form.querySelector('[data-stage-hint]')
    this.filter = form.querySelector('[data-orientation-filter]')
    this.summary = form.querySelector('[data-summary]')
    this.previewMode = form.getAttribute('data-preview') || 'none'
    this.entries = []
    this.orientation = 'all'

    if (!this.input) return

    this.input.addEventListener('change', function () {
      self.add(self.input.files)
    })

    var picker = form.querySelector('[data-add-more]')
    if (picker) {
      picker.addEventListener('click', function () {
        self.input.click()
      })
    }

    if (this.filter) {
      this.filter.addEventListener('click', function (event) {
        var button = event.target.closest('[data-filter]')
        if (!button) return
        self.orientation = button.getAttribute('data-filter')
        Array.prototype.forEach.call(self.filter.querySelectorAll('[data-filter]'), function (b) {
          b.classList.toggle('is-active', b === button)
        })
        self.applyFilter()
      })
    }

    this.wireDropzone()

    // Only the included files should be sent, so the list is rebuilt at submit.
    form.addEventListener('submit', function () {
      self.syncInput()
    })
  }

  FileStage.prototype.wireDropzone = function () {
    var self = this
    var zone = this.form.querySelector('[data-dropzone]')
    if (!zone) return
    ;['dragenter', 'dragover'].forEach(function (name) {
      zone.addEventListener(name, function (e) {
        e.preventDefault()
        zone.classList.add('is-over')
      })
    })
    ;['dragleave', 'drop'].forEach(function (name) {
      zone.addEventListener(name, function () {
        zone.classList.remove('is-over')
      })
    })
    zone.addEventListener('drop', function (e) {
      e.preventDefault()
      if (e.dataTransfer && e.dataTransfer.files.length) self.add(e.dataTransfer.files)
    })
  }

  FileStage.prototype.add = function (fileList) {
    var self = this
    Array.prototype.forEach.call(fileList, function (file) {
      if (self.entries.length >= MAX_PREVIEW_FILES) return
      // Same name and size twice is a re-pick, not a second file.
      var duplicate = self.entries.some(function (e) {
        return e.file.name === file.name && e.file.size === file.size
      })
      if (duplicate) return
      self.entries.push({ file: file, url: URL.createObjectURL(file), included: true, width: 0, height: 0 })
    })
    this.render()
    this.syncInput()
  }

  FileStage.prototype.remove = function (entry) {
    var index = this.entries.indexOf(entry)
    if (index === -1) return
    URL.revokeObjectURL(entry.url)
    this.entries.splice(index, 1)
    this.render()
    this.syncInput()
  }

  /** Rebuild input.files from the included entries. */
  FileStage.prototype.syncInput = function () {
    if (typeof DataTransfer === 'undefined') return
    var transfer = new DataTransfer()
    this.entries.forEach(function (entry) {
      if (entry.included) transfer.items.add(entry.file)
    })
    this.input.files = transfer.files
  }

  FileStage.prototype.applyFilter = function () {
    var mode = this.orientation
    this.entries.forEach(function (entry) {
      if (mode === 'all' || !entry.width) {
        entry.included = true
      } else if (mode === 'portrait') {
        entry.included = entry.height >= entry.width
      } else {
        entry.included = entry.width > entry.height
      }
      if (entry.card) entry.card.classList.toggle('is-excluded', !entry.included)
    })
    this.syncInput()
    this.updateCounts()
  }

  FileStage.prototype.updateCounts = function () {
    var included = this.entries.filter(function (e) {
      return e.included
    }).length
    var total = this.entries.reduce(function (sum, e) {
      return sum + (e.included ? e.file.size : 0)
    }, 0)

    Array.prototype.forEach.call(this.form.querySelectorAll('[data-file-count]'), function (node) {
      node.textContent = String(included)
    })
    var noun = this.form.querySelector('[data-file-noun]')
    if (noun) noun.textContent = included === 1 ? 'file' : 'files'
    if (this.summary) {
      this.summary.textContent = included
        ? included + ' file' + (included === 1 ? '' : 's') + ', ' + humanBytes(total)
        : ''
    }
  }

  FileStage.prototype.render = function () {
    var self = this
    var has = this.entries.length > 0

    this.stage.classList.toggle('has-files', has)
    this.grid.hidden = !has
    if (this.head) this.head.hidden = !has
    if (this.filter) this.filter.hidden = this.entries.length < 2

    this.grid.innerHTML = ''

    this.entries.forEach(function (entry) {
      var card = el('li', 'thumb' + (entry.included ? '' : ' is-excluded'))
      entry.card = card

      var frame = el('div', 'thumb-frame')
      var img = el('img')
      img.alt = entry.file.name
      img.src = entry.url
      img.addEventListener('load', function () {
        entry.width = img.naturalWidth
        entry.height = img.naturalHeight
        self.decorate(entry)
        self.updateCounts()
      })
      frame.appendChild(img)
      entry.img = img
      entry.frame = frame

      var remove = el('button', 'thumb-remove', '×')
      remove.type = 'button'
      remove.title = 'Remove ' + entry.file.name
      remove.setAttribute('aria-label', 'Remove ' + entry.file.name)
      remove.addEventListener('click', function () {
        self.remove(entry)
      })

      var meta = el('div', 'thumb-meta')
      meta.appendChild(el('span', null, humanBytes(entry.file.size)))
      var dims = el('span', 'thumb-dims', '')
      meta.appendChild(dims)
      entry.dims = dims

      card.appendChild(frame)
      card.appendChild(remove)
      card.appendChild(el('div', 'thumb-name', entry.file.name))
      card.appendChild(meta)
      self.grid.appendChild(card)
    })

    this.updateCounts()
    this.preview()
  }

  /** Per-card labels that depend on the image's own dimensions. */
  FileStage.prototype.decorate = function (entry) {
    if (entry.dims && entry.width) entry.dims.textContent = entry.width + '×' + entry.height
    this.previewEntry(entry)
  }

  FileStage.prototype.value = function (name) {
    var field = this.form.elements[name]
    if (!field) return undefined
    if (field.type === 'checkbox') return field.checked
    return field.value
  }

  FileStage.prototype.preview = function () {
    var self = this
    this.entries.forEach(function (entry) {
      self.previewEntry(entry)
    })
  }

  /**
   * Show what the current settings will do to this image.
   *
   * Which preview to draw comes from the tool's own declaration
   * (data-preview), so adding a tool does not mean editing a switch here.
   */
  FileStage.prototype.previewEntry = function (entry) {
    if (!entry.img || !entry.frame) return

    // Clear anything a previous pass drew.
    Array.prototype.forEach.call(
      entry.frame.querySelectorAll('.crop-overlay, .thumb-caption, .thumb-mark, .thumb-badge'),
      function (node) {
        node.remove()
      },
    )
    entry.img.style.transform = ''
    entry.img.style.filter = ''

    switch (this.previewMode) {
      case 'transform':
        return this.previewTransform(entry)
      case 'crop':
        return this.previewCrop(entry)
      case 'dimensions':
        return this.previewDimensions(entry)
      case 'format':
        return this.previewFormat(entry)
      case 'caption':
        return this.previewCaption(entry)
      case 'watermark':
        return this.previewWatermark(entry)
      default:
        return undefined
    }
  }

  FileStage.prototype.previewTransform = function (entry) {
    var angle = Number(this.value('angle') || 0)
    var parts = []
    if (angle) parts.push('rotate(' + angle + 'deg)')
    if (this.value('flop')) parts.push('scaleX(-1)')
    if (this.value('flip')) parts.push('scaleY(-1)')

    // A quarter turn inside a square frame needs scaling down to stay inside it.
    var quarter = Math.abs(angle % 180) === 90
    if (quarter && entry.width && entry.height) {
      var ratio = Math.min(entry.width, entry.height) / Math.max(entry.width, entry.height)
      parts.push('scale(' + ratio.toFixed(3) + ')')
    }
    entry.img.style.transform = parts.join(' ')
  }

  FileStage.prototype.previewCrop = function (entry) {
    if (!entry.width) return
    var x = Number(this.value('x') || 0)
    var y = Number(this.value('y') || 0)
    var w = Number(this.value('width') || 0)
    var h = Number(this.value('height') || 0)
    if (!w || !h) return

    var box = entry.img.getBoundingClientRect()
    var frameBox = entry.frame.getBoundingClientRect()
    if (!box.width || !frameBox.width) return

    var scale = box.width / entry.width
    var overlay = el('div', 'crop-overlay')
    overlay.style.left = box.left - frameBox.left + x * scale + 'px'
    overlay.style.top = box.top - frameBox.top + y * scale + 'px'
    overlay.style.width = Math.min(w, entry.width - x) * scale + 'px'
    overlay.style.height = Math.min(h, entry.height - y) * scale + 'px'
    overlay.style.right = 'auto'
    overlay.style.bottom = 'auto'
    entry.frame.appendChild(overlay)

    var fits = x + w <= entry.width && y + h <= entry.height
    entry.card.classList.toggle('is-excluded', !fits)
    if (this.hint) {
      this.hint.hidden = fits
      this.hint.textContent = fits ? '' : 'The crop area falls outside at least one image, which will be refused.'
    }
  }

  FileStage.prototype.previewDimensions = function (entry) {
    if (!entry.width) return
    var out
    var scale = this.value('scale')
    if (scale) {
      out = entry.width * Number(scale) + '×' + entry.height * Number(scale)
    } else if (this.value('mode') === 'percent') {
      var pct = Number(this.value('percent') || 100) / 100
      out = Math.round(entry.width * pct) + '×' + Math.round(entry.height * pct)
    } else {
      var w = Number(this.value('width') || 0)
      var h = Number(this.value('height') || 0)
      if (!w && !h) return
      var ratio = w && h ? Math.min(w / entry.width, h / entry.height) : w ? w / entry.width : h / entry.height
      if (this.value('noEnlarge') && ratio > 1) ratio = 1
      out = Math.round(entry.width * ratio) + '×' + Math.round(entry.height * ratio)
    }
    var badge = el('span', 'thumb-badge', '→ ' + out)
    entry.frame.appendChild(badge)
  }

  FileStage.prototype.previewFormat = function (entry) {
    var target = this.value('to') || this.value('format')
    var label
    if (target && target !== 'keep') {
      label = '→ ' + String(target).toUpperCase()
    } else {
      var level = this.value('level')
      label = level ? String(level) : ''
    }
    var kb = this.value('targetKb')
    if (kb) label = '≤ ' + kb + ' KB'
    if (label) entry.frame.appendChild(el('span', 'thumb-badge', label))
  }

  FileStage.prototype.previewCaption = function (entry) {
    var size = Math.max(9, entry.frame.clientHeight / 9)
    var top = this.value('top')
    var bottom = this.value('bottom')
    if (top) {
      var t = el('div', 'thumb-caption is-top', top)
      t.style.fontSize = size + 'px'
      entry.frame.appendChild(t)
    }
    if (bottom) {
      var b = el('div', 'thumb-caption is-bottom', bottom)
      b.style.fontSize = size + 'px'
      entry.frame.appendChild(b)
    }
  }

  FileStage.prototype.previewWatermark = function (entry) {
    var text = this.value('text')
    if (!text) return
    var colour = this.value('color') || '#ffffff'
    var opacity = Number(this.value('opacity') || 45) / 100

    if (this.value('tiled')) {
      var wrap = el('div', 'thumb-mark tiled')
      wrap.style.color = colour
      wrap.style.opacity = String(opacity)
      for (var i = 0; i < 3; i++) wrap.appendChild(el('span', null, text))
      entry.frame.appendChild(wrap)
      return
    }

    var mark = el('span', 'thumb-mark', text)
    mark.style.color = colour
    mark.style.opacity = String(opacity)
    var position = this.value('position') || 'bottom-right'
    var pad = '7px'
    if (position === 'center') {
      mark.style.left = '50%'
      mark.style.top = '50%'
      mark.style.transform = 'translate(-50%, -50%)'
    } else {
      if (position.indexOf('top') === 0) mark.style.top = pad
      else mark.style.bottom = pad
      if (position.indexOf('left') > -1) mark.style.left = pad
      else mark.style.right = pad
    }
    entry.frame.appendChild(mark)
  }

  /** Quick rotate buttons drive the select, which stays the source of truth. */
  function wireQuickRotate(form, stage) {
    var holder = form.querySelector('[data-quick-rotate]')
    if (!holder) return
    holder.hidden = false

    var select = form.elements.angle
    if (!select) return

    function mark() {
      Array.prototype.forEach.call(holder.querySelectorAll('[data-rotate]'), function (b) {
        b.classList.remove('is-active')
      })
    }

    Array.prototype.forEach.call(holder.querySelectorAll('[data-rotate]'), function (button) {
      button.addEventListener('click', function () {
        var step = Number(button.getAttribute('data-rotate'))
        var next = (((Number(select.value || 0) + step) % 360) + 360) % 360
        // Only offer values the select actually has, so the form stays valid.
        var available = Array.prototype.map.call(select.options, function (o) {
          return Number(o.value)
        })
        select.value = String(available.indexOf(next) > -1 ? next : 0)
        mark()
        button.classList.add('is-active')
        stage.preview()
      })
    })
  }

  /** Hide options that do not apply to the current selection. */
  function wireConditionalFields(form, stage) {
    var conditional = form.querySelectorAll('[data-show-when-field]')

    function apply() {
      Array.prototype.forEach.call(conditional, function (node) {
        var source = form.elements[node.getAttribute('data-show-when-field')]
        if (!source) return
        var allowed = (node.getAttribute('data-show-when-equals') || '').split(',')
        node.hidden = allowed.indexOf(source.value) === -1
      })
    }

    form.addEventListener('input', function () {
      apply()
      if (stage) stage.preview()
    })
    form.addEventListener('change', function () {
      apply()
      if (stage) stage.preview()
    })
    apply()
  }

  /**
   * Live job progress. On completion the page reloads so the server renders the
   * results — one rendering path, not two.
   */
  function followJob(panel) {
    if (panel.getAttribute('data-finished') === 'true') return
    if (typeof EventSource === 'undefined') return

    var id = panel.getAttribute('data-job')
    var bar = panel.querySelector('[data-progress] .progress-bar')
    var meter = panel.querySelector('[data-progress]')
    var label = panel.querySelector('[data-job-label]')

    // The meta refresh is the no-JS fallback; it would fight live updates.
    var refresh = document.querySelector('meta[http-equiv="refresh"]')
    if (refresh && refresh.parentNode) refresh.parentNode.removeChild(refresh)

    var source = new EventSource('/api/jobs/' + id + '/events')

    source.onmessage = function (event) {
      var data
      try {
        data = JSON.parse(event.data)
      } catch (err) {
        return
      }
      if (bar) bar.style.width = Math.max(2, data.progress) + '%'
      if (meter) meter.setAttribute('aria-valuenow', String(data.progress))
      if (label && data.status === 'running') label.textContent = 'Working… ' + data.progress + '%'

      if (['done', 'failed', 'expired', 'cancelled'].indexOf(data.status) !== -1) {
        source.close()
        window.location.reload()
      }
    }

    source.onerror = function () {
      source.close()
      window.setTimeout(function () {
        window.location.reload()
      }, 2500)
    }
  }

  function wireConfirms() {
    document.addEventListener('click', function (e) {
      var node = e.target.closest ? e.target.closest('[data-confirm]') : null
      if (!node) return
      if (!window.confirm(node.getAttribute('data-confirm'))) e.preventDefault()
    })
  }

  /** Render server timestamps in the reader's own locale. */
  function localiseTimes() {
    Array.prototype.forEach.call(document.querySelectorAll('time'), function (node) {
      var ms = Number(node.textContent)
      if (!isFinite(ms) || ms <= 0) return
      var date = new Date(ms)
      node.setAttribute('datetime', date.toISOString())
      node.textContent = date.toLocaleString()
    })
  }

  Array.prototype.forEach.call(document.querySelectorAll('form.workspace'), function (form) {
    var stage = form.getAttribute('data-input-mode') === 'none' ? null : new FileStage(form)
    wireConditionalFields(form, stage)
    if (stage) wireQuickRotate(form, stage)
  })
  Array.prototype.forEach.call(document.querySelectorAll('[data-job]'), followJob)
  wireConfirms()
  localiseTimes()
})()
