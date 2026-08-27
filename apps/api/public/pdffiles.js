// The merge workspace: one card per document.
//
// Merging is about which document comes first, so this shows the files rather
// than the pages — each with its first page, its weight, and controls to turn,
// drop or reorder it. The order of the cards is the order of the merge, kept in
// step with the real file input so the form still posts as plain multipart.
//
// Everything here is enhancement: with this file absent the picker still takes
// several PDFs and the server still merges them in the order the browser gives.
'use strict'
;(function () {
  var root = document.querySelector('[data-pdf-files]')
  if (!root) return

  var form = root.closest('form')
  var input = form && form.querySelector('[data-file-input]')
  var grid = root.querySelector('[data-pdf-file-grid]')
  if (!form || !input || !grid) return

  var hint = root.querySelector('[data-pdf-hint]')
  var sortButton = root.querySelector('[data-sort-az]')
  var rotationsField = form.querySelector('input[name="rotations"]')
  var stage = form.querySelector('[data-stage]')
  var addButton = form.querySelector('[data-add-more]')
  var summary = form.querySelector('[data-summary]')

  var MAX_FILES = 60
  var THUMB_WIDTH = 132
  var QUARTER = 90

  /** { file, rotation, pages, node, canvas } */
  var entries = []
  var dragFrom = -1
  var pdfjsPromise = null

  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(root.getAttribute('data-pdfjs')).then(function (pdfjs) {
        pdfjs.GlobalWorkerOptions.workerSrc = root.getAttribute('data-pdfjs-worker')
        return pdfjs
      })
    }
    return pdfjsPromise
  }

  function humanBytes(bytes) {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / 1048576).toFixed(2) + ' MB'
  }

  /** Weight and length. The length only arrives once pdf.js has read the file. */
  function describe(entry) {
    var turned = entry.rotation ? ' · turned ' + entry.rotation + '°' : ''
    if (!entry.pages) return humanBytes(entry.file.size) + turned
    return humanBytes(entry.file.size) + ' · ' + entry.pages +
      (entry.pages === 1 ? ' page' : ' pages') + turned
  }

  function isPdf(file) {
    return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
  }

  /** Keep the real input, the rotations field and the counters in step. */
  function sync() {
    if (typeof DataTransfer !== 'undefined') {
      var transfer = new DataTransfer()
      entries.forEach(function (entry) { transfer.items.add(entry.file) })
      input.files = transfer.files
    }

    if (rotationsField) {
      var turns = entries.map(function (entry) { return entry.rotation })
      // Nothing to say when no document was turned.
      var any = turns.some(function (turn) { return turn !== 0 })
      rotationsField.value = any ? turns.join(',') : ''
    }

    Array.prototype.forEach.call(form.querySelectorAll('[data-file-count]'), function (node) {
      node.textContent = String(entries.length)
    })
    if (addButton) addButton.hidden = entries.length === 0
    root.hidden = entries.length === 0

    entries.forEach(function (entry) {
      var meta = entry.node && entry.node.querySelector('[data-pdf-file-meta]')
      if (meta) meta.textContent = describe(entry)
    })

    var pages = entries.reduce(function (total, entry) { return total + (entry.pages || 0) }, 0)
    if (hint) {
      hint.textContent = entries.length
        ? entries.length + (entries.length === 1 ? ' document' : ' documents') +
          (pages ? ', ' + pages + (pages === 1 ? ' page' : ' pages') : '') +
          '. Drag a card to change the order.'
        : ''
    }
    if (summary) {
      summary.textContent = entries.length > 1
        ? 'Merges in the order shown, top left first.'
        : ''
    }
  }

  /**
   * Draw the first page at the document's own rotation plus the turn the user
   * asked for. pdf.js takes the total rotation, not an offset, which is the same
   * arithmetic the server does when it merges — so the preview and the result
   * agree.
   */
  function drawThumb(entry) {
    return entry.file
      .arrayBuffer()
      .then(function (bytes) {
        return loadPdfjs().then(function (pdfjs) {
          return pdfjs.getDocument({
            data: new Uint8Array(bytes),
            // Served from here, because there is no CDN to fall back on and
            // because the default relative path 404s — which costs seconds a
            // page rather than failing outright.
            standardFontDataUrl: root.getAttribute('data-pdfjs-fonts'),
            cMapUrl: root.getAttribute('data-pdfjs-cmaps'),
            cMapPacked: true,
          }).promise
        })
      })
      .then(function (doc) {
        entry.pages = doc.numPages
        return doc.getPage(1).then(function (page) {
          var natural = page.getViewport({ scale: 1 })
          var scale = THUMB_WIDTH / natural.width
          var viewport = page.getViewport({
            scale: scale,
            rotation: (page.rotate + entry.rotation) % 360,
          })
          var canvas = document.createElement('canvas')
          canvas.className = 'pdf-file-canvas'
          canvas.width = Math.ceil(viewport.width)
          canvas.height = Math.ceil(viewport.height)
          return page
            .render({ canvasContext: canvas.getContext('2d'), viewport: viewport })
            .promise.then(function () {
              page.cleanup()
              return doc.destroy().then(function () { return canvas })
            })
        })
      })
      .then(function (canvas) {
        // Put it in the card's plate, whether or not one was there before: on
        // first draw there is nothing to replace, and only replacing meant the
        // thumbnail was rendered and then never shown.
        var plate = entry.node && entry.node.querySelector('.pdf-file-plate')
        if (plate) {
          plate.textContent = ''
          plate.appendChild(canvas)
        }
        entry.canvas = canvas
        sync()
      })
      .catch(function () {
        // A damaged or password-protected file cannot be previewed. The server
        // says so properly on submit; the card just stays blank.
        if (entry.node) entry.node.classList.add('is-unreadable')
      })
  }

  function iconButton(label, path) {
    var button = document.createElement('button')
    button.type = 'button'
    button.className = 'pdf-file-action'
    button.title = label
    button.setAttribute('aria-label', label)
    button.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
      'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>'
    return button
  }

  function card(entry, index) {
    var item = document.createElement('li')
    item.className = 'pdf-file'
    item.draggable = true

    var plate = document.createElement('div')
    plate.className = 'pdf-file-plate'
    if (entry.canvas) plate.appendChild(entry.canvas)

    var actions = document.createElement('div')
    actions.className = 'pdf-file-actions'

    var turn = iconButton('Turn this document', '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>')
    turn.addEventListener('click', function () { rotate(index) })

    var drop = iconButton('Remove this document', '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>')
    drop.addEventListener('click', function () { remove(index) })

    actions.appendChild(turn)
    actions.appendChild(drop)

    var name = document.createElement('span')
    name.className = 'pdf-file-name'
    name.textContent = entry.file.name
    name.title = entry.file.name

    var meta = document.createElement('span')
    meta.className = 'pdf-file-meta'
    meta.setAttribute('data-pdf-file-meta', '')
    meta.textContent = describe(entry)

    item.appendChild(plate)
    item.appendChild(actions)
    item.appendChild(name)
    item.appendChild(meta)

    item.addEventListener('dragstart', function (e) {
      dragFrom = index
      item.classList.add('is-dragging')
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
    })
    item.addEventListener('dragend', function () {
      dragFrom = -1
      item.classList.remove('is-dragging')
    })
    item.addEventListener('dragover', function (e) {
      if (dragFrom < 0) return
      e.preventDefault()
      item.classList.add('is-target')
    })
    item.addEventListener('dragleave', function () { item.classList.remove('is-target') })
    item.addEventListener('drop', function (e) {
      if (dragFrom < 0) return
      // Not an upload: stop the stage from treating this as a dropped file.
      e.preventDefault()
      e.stopPropagation()
      item.classList.remove('is-target')
      move(dragFrom, index)
    })

    entry.node = item
    return item
  }

  function render() {
    grid.textContent = ''
    entries.forEach(function (entry, index) { grid.appendChild(card(entry, index)) })
    sync()
  }

  function add(list) {
    var fresh = []
    Array.prototype.forEach.call(list, function (file) {
      if (entries.length + fresh.length >= MAX_FILES) return
      if (!isPdf(file)) return
      var duplicate = entries.concat(fresh).some(function (entry) {
        return entry.file.name === file.name && entry.file.size === file.size
      })
      if (duplicate) return
      fresh.push({ file: file, rotation: 0, pages: 0, node: null, canvas: null })
    })
    if (!fresh.length) return

    entries = entries.concat(fresh)
    render()
    fresh.forEach(drawThumb)
  }

  function remove(index) {
    entries.splice(index, 1)
    render()
  }

  function rotate(index) {
    var entry = entries[index]
    if (!entry) return
    entry.rotation = (entry.rotation + QUARTER) % 360
    sync()
    drawThumb(entry)
  }

  function move(from, to) {
    if (from === to || from < 0 || to < 0) return
    var moved = entries.splice(from, 1)[0]
    entries.splice(to, 0, moved)
    render()
  }

  input.addEventListener('change', function () {
    add(input.files)
    // The picker keeps its own list; ours is authoritative from here.
    sync()
  })

  if (addButton) addButton.addEventListener('click', function () { input.click() })

  if (sortButton) {
    sortButton.addEventListener('click', function () {
      entries.sort(function (a, b) {
        return a.file.name.localeCompare(b.file.name, undefined, { numeric: true })
      })
      render()
    })
  }

  if (stage) {
    ;['dragenter', 'dragover'].forEach(function (name) {
      stage.addEventListener(name, function (e) {
        if (dragFrom >= 0) return
        e.preventDefault()
        stage.classList.add('is-over')
      })
    })
    ;['dragleave', 'drop'].forEach(function (name) {
      stage.addEventListener(name, function () { stage.classList.remove('is-over') })
    })
    stage.addEventListener('drop', function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files.length) return
      e.preventDefault()
      add(e.dataTransfer.files)
    })
  }

  form.addEventListener('submit', sync)
  sync()
})()
