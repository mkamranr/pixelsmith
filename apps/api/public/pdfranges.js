// From/to rows for splitting a PDF into parts.
//
// The tool takes ranges as text — `1-6,10-12` — which is precise but asks the
// user to hold the syntax in their head. These rows write that same value, and
// mark the page grid so it is clear which part each page lands in.
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
  })

  // The split mode changes which fields are on show; the marking follows.
  form.addEventListener('change', mark)

  render()
  write()
})()
