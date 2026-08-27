// Arranging the pages of several documents into one.
//
// Every page of every upload is laid out in a single grid, tinted by where it
// came from, and dragging is the whole interface: move a page anywhere, turn it,
// drop it. What the form posts is a plan — the exact sequence of the result —
// while the page-order field in the panel still works on its own for anyone
// without script.
'use strict'
;(function () {
  var form = document.querySelector('[data-organize]')
  if (!form) return

  var input = form.querySelector('[data-file-input]')
  var dropzone = form.querySelector('[data-dropzone]')
  var board = form.querySelector('[data-organize-board]')
  var grid = form.querySelector('[data-organize-grid]')
  var fileList = form.querySelector('[data-organize-files]')
  var hint = form.querySelector('[data-organize-hint]')
  var planField = form.querySelector('[name="plan"]')
  var stage = form.querySelector('[data-stage]')
  var addButton = form.querySelector('[data-add-more]')
  var summary = form.querySelector('[data-summary]')
  if (!input || !grid) return

  var MAX_FILES = 30
  var MAX_SHEETS = 400
  var THUMB_WIDTH = 108
  var LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  /** One tint per document, so a page's origin is obvious at a glance. */
  var TINTS = ['#e11d48', '#0891b2', '#ca8a04', '#7c3aed', '#15803d', '#c2410c']

  /** Documents, in the order their pages are grouped by. */
  var files = []
  /** The arrangement: one entry per page of the result, in order. */
  var sheets = []
  var pdfjsPromise = null
  var dragFrom = -1
  /** Counts arrivals, so 'reset' can return to the order they came in. */
  var arrivals = 0
  /** How many documents are still being read. */
  var reading = 0

  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(form.getAttribute('data-pdfjs')).then(function (pdfjs) {
        pdfjs.GlobalWorkerOptions.workerSrc = form.getAttribute('data-pdfjs-worker')
        return pdfjs
      })
    }
    return pdfjsPromise
  }

  function isPdf(file) {
    return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
  }

  // ---- what gets posted ---------------------------------------------------

  /**
   * Keep the real input in step with the order shown, and describe the result.
   *
   * The plan refers to documents by position, so the input's own order has to
   * match — otherwise reordering the files in the panel would silently point
   * every page at the wrong document.
   */
  function sync() {
    if (typeof DataTransfer !== 'undefined') {
      var transfer = new DataTransfer()
      files.forEach(function (entry) { transfer.items.add(entry.file) })
      input.files = transfer.files
    }

    if (planField) {
      planField.value = sheets.length
        ? JSON.stringify(
            sheets.map(function (sheet) {
              if (sheet.blank) return { blank: true }
              return { file: files.indexOf(sheet.source), page: sheet.page, rotate: sheet.rotate }
            })
          )
        : ''
    }

    Array.prototype.forEach.call(form.querySelectorAll('[data-file-count]'), function (node) {
      node.textContent = String(files.length)
    })
    if (addButton) addButton.hidden = files.length === 0
    if (board) board.hidden = files.length === 0
    if (dropzone) dropzone.hidden = files.length > 0

    if (hint) {
      if (sheets.length) {
        hint.textContent =
          sheets.length + (sheets.length === 1 ? ' page' : ' pages') +
          ' from ' + files.length + (files.length === 1 ? ' document' : ' documents') +
          '. Drag a page to move it.'
      } else if (reading > 0) {
        hint.textContent = 'Reading…'
      } else if (files.length) {
        hint.textContent = 'Every page was removed. Reset to bring them back.'
      } else {
        hint.textContent = ''
      }
    }
    if (summary) {
      summary.textContent = sheets.length ? 'Comes out as one document of ' + sheets.length + ' pages.' : ''
    }
  }

  // ---- the pages ----------------------------------------------------------

  function thumbFor(sheet) {
    if (sheet.blank) return null
    var cached = sheet.source.thumbs[sheet.page]
    if (!cached) return null
    // One canvas cannot be in two places, so a repeated page gets a copy.
    var copy = document.createElement('canvas')
    copy.width = cached.width
    copy.height = cached.height
    copy.className = 'organize-canvas'
    copy.getContext('2d').drawImage(cached, 0, 0)
    return copy
  }

  function iconButton(label, path) {
    var button = document.createElement('button')
    button.type = 'button'
    button.className = 'organize-action'
    button.title = label
    button.setAttribute('aria-label', label)
    button.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
      'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>'
    return button
  }

  function renderGrid() {
    grid.textContent = ''

    sheets.forEach(function (sheet, index) {
      var item = document.createElement('li')
      item.className = 'organize-page' + (sheet.blank ? ' is-blank' : '')
      item.draggable = true
      if (!sheet.blank) item.style.setProperty('--tint', sheet.source.tint)

      var plate = document.createElement('div')
      plate.className = 'organize-plate'
      var thumb = thumbFor(sheet)
      if (thumb) {
        // Turned in the browser by the same quarter turns the server applies.
        thumb.style.transform = 'rotate(' + sheet.rotate + 'deg)'
        plate.appendChild(thumb)
      }

      var actions = document.createElement('div')
      actions.className = 'organize-actions'

      // Nothing on a blank sheet to turn.
      if (!sheet.blank) {
        var turn = iconButton('Turn this page', '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>')
        turn.addEventListener('click', function () {
          sheet.rotate = (sheet.rotate + 90) % 360
          sync()
          renderGrid()
        })
        actions.appendChild(turn)
      }

      var drop = iconButton('Remove this page', '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>')
      drop.addEventListener('click', function () {
        sheets.splice(index, 1)
        sync()
        renderGrid()
      })
      actions.appendChild(drop)

      // Slip a blank in ahead of this page — a separator, or the back of a
      // one-sided scan.
      var before = document.createElement('button')
      before.type = 'button'
      before.className = 'organize-insert'
      before.setAttribute('data-organize-insert', String(index))
      before.setAttribute('aria-label', 'Insert a blank page before this one')
      before.title = 'Insert a blank page here'
      before.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
        'stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>'
      before.addEventListener('click', function () { insertBlank(index) })
      item.appendChild(before)

      var label = document.createElement('span')
      label.className = 'organize-label'
      label.textContent = sheet.blank ? 'Blank' : sheet.source.letter + sheet.page

      item.appendChild(plate)
      item.appendChild(actions)
      item.appendChild(label)

      item.addEventListener('dragstart', function (event) {
        dragFrom = index
        item.classList.add('is-dragging')
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
      })
      item.addEventListener('dragend', function () {
        dragFrom = -1
        item.classList.remove('is-dragging')
      })
      item.addEventListener('dragover', function (event) {
        if (dragFrom < 0) return
        event.preventDefault()
        item.classList.add('is-target')
      })
      item.addEventListener('dragleave', function () { item.classList.remove('is-target') })
      item.addEventListener('drop', function (event) {
        if (dragFrom < 0) return
        event.preventDefault()
        event.stopPropagation()
        item.classList.remove('is-target')
        move(dragFrom, index)
      })

      grid.appendChild(item)
    })

    if (sheets.length) {
      var append = document.createElement('li')
      append.className = 'organize-append'
      var button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('data-organize-append', '')
      button.setAttribute('aria-label', 'Add a blank page at the end')
      button.innerHTML =
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
        'stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>' +
        '<span>Blank page</span>'
      button.addEventListener('click', function () { insertBlank(sheets.length) })
      append.appendChild(button)
      grid.appendChild(append)
    }

    sync()
  }

  function insertBlank(at) {
    if (sheets.length >= MAX_SHEETS) return
    sheets.splice(at, 0, { blank: true, source: null, page: 0, rotate: 0 })
    renderGrid()
  }

  function move(from, to) {
    if (from === to || from < 0 || to < 0) return
    var moved = sheets.splice(from, 1)[0]
    sheets.splice(to, 0, moved)
    renderGrid()
  }

  // ---- the documents ------------------------------------------------------

  function renderFiles() {
    if (!fileList) return
    fileList.textContent = ''

    files.forEach(function (entry, index) {
      var item = document.createElement('li')
      item.className = 'organize-file'
      item.draggable = true
      item.style.setProperty('--tint', entry.tint)

      var name = document.createElement('span')
      name.className = 'organize-file-name'
      name.textContent = entry.letter + ': ' + entry.file.name
      name.title = entry.file.name

      var drop = document.createElement('button')
      drop.type = 'button'
      drop.className = 'organize-file-remove'
      drop.setAttribute('aria-label', 'Remove ' + entry.file.name)
      drop.textContent = '×'
      drop.addEventListener('click', function () { removeFile(entry) })

      item.appendChild(name)
      item.appendChild(drop)

      item.addEventListener('dragstart', function (event) {
        dragFrom = index
        item.classList.add('is-dragging')
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
      })
      item.addEventListener('dragend', function () {
        dragFrom = -1
        item.classList.remove('is-dragging')
      })
      item.addEventListener('dragover', function (event) {
        if (dragFrom < 0) return
        event.preventDefault()
      })
      item.addEventListener('drop', function (event) {
        if (dragFrom < 0) return
        event.preventDefault()
        event.stopPropagation()
        var moved = files.splice(dragFrom, 1)[0]
        files.splice(index, 0, moved)
        relabel()
        regroup()
      })

      fileList.appendChild(item)
    })
  }

  function removeFile(entry) {
    var at = files.indexOf(entry)
    if (at === -1) return
    files.splice(at, 1)
    sheets = sheets.filter(function (sheet) { return sheet.source !== entry })
    relabel()
    renderFiles()
    renderGrid()
  }

  function relabel() {
    files.forEach(function (entry, index) {
      entry.letter = LETTERS[index % LETTERS.length]
      entry.tint = TINTS[index % TINTS.length]
    })
  }

  /** Lay the pages out document by document, in the order the files now sit. */
  function regroup() {
    sheets = []
    files.forEach(function (entry) {
      for (var page = 1; page <= entry.pages; page++) {
        if (sheets.length >= MAX_SHEETS) return
        sheets.push({ source: entry, page: page, rotate: 0 })
      }
    })
    renderFiles()
    renderGrid()
  }

  /** One page from each document in turn: two stacks of scans become one. */
  function interleave() {
    var longest = files.reduce(function (most, entry) { return Math.max(most, entry.pages) }, 0)
    sheets = []
    for (var page = 1; page <= longest; page++) {
      for (var at = 0; at < files.length; at++) {
        if (page > files[at].pages) continue
        if (sheets.length >= MAX_SHEETS) break
        sheets.push({ source: files[at], page: page, rotate: 0 })
      }
    }
    renderGrid()
  }

  // ---- reading the documents ---------------------------------------------

  /**
   * Two phases, deliberately.
   *
   * Counting the pages of every document is quick; drawing their thumbnails is
   * not. Doing both in one pass meant the second document was not opened until
   * the first had finished drawing — so half the arrangement was missing while
   * the browser worked through page one.
   */
  function countPages(entry) {
    return entry.file
      .arrayBuffer()
      .then(function (bytes) {
        return loadPdfjs().then(function (pdfjs) {
          return pdfjs.getDocument({
            data: new Uint8Array(bytes),
            standardFontDataUrl: form.getAttribute('data-pdfjs-fonts'),
            cMapUrl: form.getAttribute('data-pdfjs-cmaps'),
            cMapPacked: true,
          }).promise
        })
      })
      .then(function (doc) {
        entry.doc = doc
        entry.pages = doc.numPages
        reading--

        // The pages join the grid the moment they are counted; their pictures
        // catch up afterwards.
        for (var at = 1; at <= entry.pages; at++) {
          if (sheets.length >= MAX_SHEETS) break
          sheets.push({ source: entry, page: at, rotate: 0 })
        }
        renderGrid()
      })
      .catch(function () {
        entry.unreadable = true
        reading = Math.max(0, reading - 1)
        if (hint) hint.textContent = 'One document could not be read here; the page list still works.'
      })
  }

  /** Draw the thumbnails, one page at a time so the tab keeps answering. */
  function drawThumbs(entry) {
    var doc = entry.doc
    if (!doc) return Promise.resolve()
    var chain = Promise.resolve()

    for (var page = 1; page <= entry.pages; page++) {
      chain = chain.then(
        (function (number) {
          return function () {
            return doc.getPage(number).then(function (loaded) {
              var natural = loaded.getViewport({ scale: 1 })
              var viewport = loaded.getViewport({ scale: THUMB_WIDTH / natural.width })
              var canvas = document.createElement('canvas')
              canvas.width = Math.ceil(viewport.width)
              canvas.height = Math.ceil(viewport.height)
              var context = canvas.getContext('2d')
              context.fillStyle = '#ffffff'
              context.fillRect(0, 0, canvas.width, canvas.height)
              return loaded
                .render({ canvasContext: context, viewport: viewport })
                .promise.then(function () {
                  loaded.cleanup()
                  entry.thumbs[number] = canvas
                  renderGrid()
                })
            })
          }
        })(page)
      )
    }

    return chain
      .then(function () { return doc.destroy() })
      .then(function () { entry.doc = null })
      .catch(function () { entry.doc = null })
  }

  function add(list) {
    var fresh = []
    Array.prototype.forEach.call(list, function (file) {
      if (files.length + fresh.length >= MAX_FILES) return
      if (!isPdf(file)) return
      var already = files.concat(fresh).some(function (entry) {
        return entry.file.name === file.name && entry.file.size === file.size
      })
      if (already) return
      fresh.push({
        file: file,
        pages: 0,
        thumbs: {},
        letter: '',
        tint: '',
        unreadable: false,
        doc: null,
        arrived: arrivals++,
      })
    })
    if (!fresh.length) return

    files = files.concat(fresh)
    relabel()
    renderFiles()
    sync()

    // Pages appear as each document is read, in the order the files sit.
    var counting = Promise.resolve()
    fresh.forEach(function (entry) {
      reading++
      counting = counting.then(function () { return countPages(entry) })
    })

    counting.then(function () {
      var drawing = Promise.resolve()
      fresh.forEach(function (entry) {
        drawing = drawing.then(function () { return drawThumbs(entry) })
      })
      return drawing
    })
    sync()
  }

  // ---- wiring -------------------------------------------------------------

  input.addEventListener('change', function () { add(input.files) })
  if (addButton) addButton.addEventListener('click', function () { input.click() })

  if (stage) {
    ;['dragenter', 'dragover'].forEach(function (name) {
      stage.addEventListener(name, function (event) {
        if (dragFrom >= 0) return
        event.preventDefault()
        stage.classList.add('is-over')
      })
    })
    ;['dragleave', 'drop'].forEach(function (name) {
      stage.addEventListener(name, function () { stage.classList.remove('is-over') })
    })
    stage.addEventListener('drop', function (event) {
      if (!event.dataTransfer || !event.dataTransfer.files.length) return
      event.preventDefault()
      add(event.dataTransfer.files)
    })
  }

  Array.prototype.forEach.call(form.querySelectorAll('[data-organize-sort]'), function (button) {
    button.addEventListener('click', function () {
      var how = button.getAttribute('data-organize-sort')
      if (how === 'interleave') {
        interleave()
        return
      }
      files.sort(function (a, b) {
        return a.file.name.localeCompare(b.file.name, undefined, {
          numeric: how === 'number',
          sensitivity: 'base',
        })
      })
      relabel()
      regroup()
    })
  })

  var reset = form.querySelector('[data-organize-reset]')
  if (reset) reset.addEventListener('click', function () {
    // Back to the order they arrived in, every page present and upright.
    files.sort(function (a, b) { return a.arrived - b.arrived })
    relabel()
    regroup()
  })

  form.addEventListener('submit', sync)
  sync()
})()
