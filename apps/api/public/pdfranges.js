// Choosing where a PDF is cut.
//
// The tool takes ranges as text — `1-6,10-12` — which is precise but asks the
// user to hold the syntax in their head, and to know the page numbers before
// they can say anything. So there are three ways to the same value: a handle
// between the pages themselves, from/to rows for exact numbers, and the field.
//
// The handles are the honest answer to "where does this split?": cutting
// between two pages is the gesture, and the parts are numbered on the grid as
// soon as a cut lands.
//
// Enhancement only: the text field is what gets posted and stays perfectly
// usable on its own. The rows move inside its wrapper so they appear and
// disappear with it as the split mode changes.
'use strict'
;(function () {
  var host = document.querySelector('[data-range-rows]')
  if (!host) return

  var form = host.closest('form')
  var field = form && form.querySelector('[name="ranges"]')
  if (!form || !field) return

  var wrapper = field.closest('[data-field]')
  if (wrapper) wrapper.appendChild(host)
  host.hidden = false
  // The field still posts; it just stops competing with the rows for attention.
  field.classList.add('is-driven')

  var pageCount = 0
  var rows = []
  var edited = false

  function clamp(value, low, high) {
    if (isNaN(value)) return low
    return Math.max(low, Math.min(high, value))
  }

  function limit() {
    return pageCount || 9999
  }

  function write() {
    field.value = rows
      .map(function (row) { return row.from === row.to ? String(row.from) : row.from + '-' + row.to })
      .join(',')
    mark()
    handles()
  }

  /**
   * Number each page in the grid with the part it will end up in, and dim the
   * ones no range covers. Reaching into the grid directly is the simplest
   * honest option: both scripts are on the same page and the grid is stable.
   */
  function mark() {
    var buttons = form.querySelectorAll('[data-pdf-grid] [data-page]')
    if (!buttons.length) return
    var active = !wrapper || !wrapper.hidden

    Array.prototype.forEach.call(buttons, function (button) {
      var page = Number(button.getAttribute('data-page'))
      var badge = button.querySelector('[data-pdf-order]')
      var at = -1
      for (var i = 0; i < rows.length; i++) {
        if (page >= rows[i].from && page <= rows[i].to) { at = i; break }
      }

      button.classList.toggle('is-outside', active && at === -1)
      if (!badge) return
      if (active && at >= 0) {
        badge.textContent = String(at + 1)
        badge.hidden = false
      } else if (active) {
        badge.hidden = true
      }
    })
  }


  /**
   * Where the document is cut, derived from the parts themselves so there is
   * one source of truth rather than a second list to keep in step.
   *
   * A cut before page N means N begins a new part. Page 1 always begins the
   * first part and is not a cut.
   */
  function boundaries() {
    return rows
      .map(function (row) { return row.from })
      .filter(function (from) { return from > 1 })
      .sort(function (a, b) { return a - b })
  }

  /** Contiguous parts from a set of cuts, covering the whole document. */
  function partsFrom(cuts, count) {
    var starts = [1]
    cuts.forEach(function (cut) {
      if (cut > 1 && cut <= count && starts.indexOf(cut) === -1) starts.push(cut)
    })
    starts.sort(function (a, b) { return a - b })

    return starts.map(function (start, index) {
      var next = starts[index + 1]
      return { from: start, to: next ? next - 1 : count }
    })
  }

  function cutAt(pageNumber) {
    if (!pageCount) return
    var cuts = boundaries()
    var at = cuts.indexOf(pageNumber)
    if (at === -1) cuts.push(pageNumber)
    else cuts.splice(at, 1)

    edited = true
    rows = partsFrom(cuts, pageCount)
    render()
    write()
  }

  /**
   * A handle between each pair of pages. Its own control rather than a click on
   * the page: the page button already means "choose this page" for the tools
   * that select pages, and one gesture meaning two things depending on the mode
   * is how a grid stops being legible.
   */
  function handles() {
    var tiles = form.querySelectorAll('[data-pdf-grid] [data-page]')
    if (!tiles.length) return
    var active = !wrapper || !wrapper.hidden
    var cuts = boundaries()

    Array.prototype.forEach.call(tiles, function (button) {
      var pageNumber = Number(button.getAttribute('data-page'))
      var item = button.parentNode
      if (!item) return

      var handle = item.querySelector('[data-cut]')
      // Nothing to cut before the first page: it always starts part one.
      if (pageNumber < 2 || !active) {
        if (handle) handle.remove()
        return
      }

      if (!handle) {
        handle = document.createElement('button')
        handle.type = 'button'
        handle.className = 'pdf-cut'
        handle.setAttribute('data-cut', String(pageNumber))
        handle.innerHTML = ''
        var line = document.createElement('span')
        line.className = 'pdf-cut-line'
        handle.appendChild(line)
        handle.addEventListener('click', function (event) {
          event.preventDefault()
          cutAt(pageNumber)
        })
        item.appendChild(handle)
      }

      var isCut = cuts.indexOf(pageNumber) !== -1
      handle.classList.toggle('is-cut', isCut)
      handle.setAttribute('aria-pressed', String(isCut))
      handle.setAttribute(
        'aria-label',
        (isCut ? 'Do not split' : 'Split') + ' before page ' + pageNumber,
      )
    })
  }

  function numberInput(value, onChange) {
    var node = document.createElement('input')
    node.type = 'number'
    node.min = '1'
    node.className = 'range-number'
    node.value = String(value)
    // Deliberately nameless: the text field is what gets posted.
    node.addEventListener('input', function () {
      edited = true
      onChange(Number(node.value))
    })
    return node
  }

  function render() {
    host.textContent = ''

    rows.forEach(function (row, index) {
      var line = document.createElement('div')
      line.className = 'range-row'

      var label = document.createElement('span')
      label.className = 'range-row-label'
      label.textContent = 'Range ' + (index + 1)

      var fromLabel = document.createElement('label')
      fromLabel.className = 'range-part'
      fromLabel.appendChild(document.createTextNode('from page '))
      fromLabel.appendChild(
        numberInput(row.from, function (value) {
          row.from = clamp(value, 1, limit())
          if (row.to < row.from) row.to = row.from
          write()
        })
      )

      var toLabel = document.createElement('label')
      toLabel.className = 'range-part'
      toLabel.appendChild(document.createTextNode('to '))
      toLabel.appendChild(
        numberInput(row.to, function (value) {
          row.to = clamp(value, row.from, limit())
          write()
        })
      )

      line.appendChild(label)
      line.appendChild(fromLabel)
      line.appendChild(toLabel)

      if (rows.length > 1) {
        var drop = document.createElement('button')
        drop.type = 'button'
        drop.className = 'range-drop'
        drop.title = 'Remove this range'
        drop.setAttribute('aria-label', 'Remove range ' + (index + 1))
        drop.textContent = '×'
        drop.addEventListener('click', function () {
          rows.splice(index, 1)
          render()
          write()
        })
        line.appendChild(drop)
      }

      host.appendChild(line)
    })

    var add = document.createElement('button')
    add.type = 'button'
    add.className = 'btn btn-quiet btn-sm range-add'
    add.textContent = '+ Add range'
    add.addEventListener('click', function () {
      var last = rows[rows.length - 1]
      var from = last ? Math.min(last.to + 1, limit()) : 1
      rows.push({ from: from, to: limit() })
      edited = true
      render()
      write()
    })
    host.appendChild(add)
  }

  /** Read whatever the field already holds, so a typed value is not thrown away. */
  function parse(value) {
    return String(value || '')
      .split(',')
      .map(function (part) { return part.trim() })
      .filter(function (part) { return part !== '' })
      .map(function (part) {
        var halves = part.split('-')
        var from = Number(halves[0])
        var to = halves.length > 1 && halves[1] !== '' ? Number(halves[1]) : from
        if (isNaN(from) || isNaN(to)) return null
        return { from: from, to: Math.max(from, to) }
      })
      .filter(Boolean)
  }

  rows = parse(field.value)
  if (!rows.length) rows = [{ from: 1, to: 1 }]

  document.addEventListener('pixelsmith:pages', function (event) {
    pageCount = Number(event.detail) || 0
    // Cover the whole document to begin with, which is what someone opening the
    // panel expects to see — unless they have already set something.
    if (!edited && rows.length === 1 && rows[0].from === 1) {
      rows[0].to = pageCount || rows[0].to
      render()
    }
    write()
    handles()
  })

  // The split mode changes which fields are on show; the marking and the
  // handles follow.
  form.addEventListener('change', function () {
    mark()
    handles()
  })

  render()
  write()
})()
