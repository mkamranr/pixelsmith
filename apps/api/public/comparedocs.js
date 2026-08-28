// Two documents side by side, with what changed marked on them.
//
// The comparison already writes a report saying "page 3: this line left, this
// line arrived", which is accurate and is a lookup exercise. This shows it: both
// originals rendered, removals marked in red on the left, additions in green on
// the right, and a list you can click to jump to any of them.
//
// The boxes come from the change list the comparison wrote, so what is drawn
// here is exactly what the report describes — one source, two presentations.
'use strict'
;(function () {
  var root = document.querySelector('[data-compare-docs]')
  if (!root) return

  var sides = {
    before: root.querySelector('[data-cmp-scroll="before"]'),
    after: root.querySelector('[data-cmp-scroll="after"]'),
  }
  var listNode = root.querySelector('[data-cmp-changes]')
  var countNode = root.querySelector('[data-cmp-count]')
  var status = root.querySelector('[data-cmp-status]')
  if (!sides.before || !sides.after) return

  var WIDTH = 460

  function say(message) {
    if (status) status.textContent = message
  }

  function loadPdfjs() {
    return import(root.getAttribute('data-pdfjs')).then(function (pdfjs) {
      pdfjs.GlobalWorkerOptions.workerSrc = root.getAttribute('data-pdfjs-worker')
      return pdfjs
    })
  }

  function open(url) {
    return fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('could not read ' + url)
        return res.arrayBuffer()
      })
      .then(function (bytes) {
        return loadPdfjs().then(function (pdfjs) {
          return pdfjs.getDocument({
            data: new Uint8Array(bytes),
            standardFontDataUrl: root.getAttribute('data-pdfjs-fonts'),
            cMapUrl: root.getAttribute('data-pdfjs-cmaps'),
          }).promise
        })
      })
  }

  /** One page, rendered, with an empty layer over it for the highlights. */
  function renderPage(doc, number) {
    return doc.getPage(number).then(function (page) {
      var natural = page.getViewport({ scale: 1 })
      var scale = WIDTH / natural.width
      var viewport = page.getViewport({ scale: scale })
      var canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)

      var holder = document.createElement('div')
      holder.className = 'cmp-page'
      holder.setAttribute('data-cmp-page', String(number))
      holder.appendChild(canvas)

      var marks = document.createElement('div')
      marks.className = 'cmp-marks'
      marks.setAttribute('data-cmp-marks', String(number))
      holder.appendChild(marks)

      var label = document.createElement('span')
      label.className = 'cmp-page-number'
      label.textContent = String(number)
      holder.appendChild(label)

      return page
        .render({ canvasContext: canvas.getContext('2d'), viewport: viewport })
        .promise.then(function () {
          page.cleanup()
          return { node: holder }
        })
    })
  }

  /**
   * Draw one change over the page it belongs to.
   *
   * Positioned as a percentage of the page rather than in pixels. The canvas is
   * rendered at one size and displayed at whatever the column allows — a narrow
   * window shrinks it — so a mark placed at a pixel offset drifts away from the
   * words underneath, which is exactly what it did. A proportion of the page is
   * true at any display size, including after the window is resized.
   *
   * Nothing is drawn if the page it names is not there, which happens when one
   * document is shorter than the other.
   */
  function mark(container, change, index) {
    var marks = container.querySelector('[data-cmp-marks="' + change.page + '"]')
    if (!marks) return null

    var size = change.pageSize
    if (!size || !size.width || !size.height) return null
    var percent = function (value, of) {
      return (value / of) * 100 + '%'
    }

    var node = document.createElement('span')
    node.className = 'cmp-mark is-' + change.kind
    node.setAttribute('data-cmp-mark', String(index))
    node.style.left = percent(change.box.x, size.width)
    node.style.top = percent(change.box.y, size.height)
    node.style.width = percent(Math.max(1, change.box.width), size.width)
    node.style.height = percent(Math.max(1, change.box.height), size.height)
    marks.appendChild(node)
    return node
  }

  // ---- keeping the two sides together -------------------------------------

  /**
   * Scroll sync by proportion rather than by pixels: the two documents can be
   * different lengths, and matching raw offsets would drift apart immediately.
   * `settling` stops the two from pushing each other back and forth.
   */
  var settling = false
  function follow(source, target) {
    source.addEventListener('scroll', function () {
      if (settling) return
      var range = source.scrollHeight - source.clientHeight
      if (range <= 0) return
      settling = true
      var proportion = source.scrollTop / range
      target.scrollTop = proportion * (target.scrollHeight - target.clientHeight)
      // Released on the next frame, once the scroll it caused has been handled.
      requestAnimationFrame(function () {
        settling = false
      })
    })
  }

  // ---- putting it together ------------------------------------------------

  /**
   * The list first, then the pages.
   *
   * The change list needs only the comparison's own output, so it appears at
   * once; rendering both documents takes as long as it takes and fills in
   * behind it. Waiting for every page before showing anything meant staring at
   * "rendering…" for twenty seconds on a three-page document, and far worse on
   * a real one.
   */
  function buildList(changes) {
    if (countNode) countNode.textContent = changes.length ? '(' + changes.length + ')' : ''
    if (!changes.length) {
      say('The two documents match.')
      return
    }
    if (!listNode) return

    changes.forEach(function (change, index) {
      var item = document.createElement('li')
      var button = document.createElement('button')
      button.type = 'button'
      button.className = 'cmp-change is-' + change.kind

      var where = document.createElement('span')
      where.className = 'cmp-where'
      where.textContent =
        'Page ' + change.page + (change.kind === 'removed' ? ' · removed' : ' · added')
      var what = document.createElement('span')
      what.className = 'cmp-what'
      what.textContent = change.text
      button.appendChild(where)
      button.appendChild(what)

      button.addEventListener('click', function () {
        var container = sides[change.side]
        // Looked up now rather than captured: the page it sits on may not have
        // been drawn when this entry was made.
        var node = container && container.querySelector('[data-cmp-mark="' + index + '"]')
        var page = container && container.querySelector('[data-cmp-page="' + change.page + '"]')

        var lit = root.querySelectorAll('.cmp-mark.is-lit')
        for (var i = 0; i < lit.length; i += 1) lit[i].classList.remove('is-lit')
        var chosen = root.querySelectorAll('.cmp-change.is-chosen')
        for (var j = 0; j < chosen.length; j += 1) chosen[j].classList.remove('is-chosen')
        button.classList.add('is-chosen')
        if (node) node.classList.add('is-lit')

        // The container is scrolled directly rather than by scrollIntoView:
        // that scrolls every scrollable ancestor including the window, so
        // clicking an entry dragged the whole page about.
        if (!page || !container) return
        var top = node
          ? page.offsetTop + node.offsetTop - container.clientHeight / 2 + node.offsetHeight / 2
          : page.offsetTop - 12
        container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
      })

      item.appendChild(button)
      listNode.appendChild(item)
    })
  }

  fetch(root.getAttribute('data-compare-changes'))
    .then(function (res) {
      return res.json()
    })
    .then(function (list) {
      var changes = list.changes || []
      buildList(changes)
      if (changes.length) say('Drawing the documents…')

      /** Marks for a side are attached as each of its pages appears. */
      function drawSide(which, url) {
        return open(url).then(function (doc) {
          var chain = Promise.resolve()
          for (var number = 1; number <= doc.numPages; number += 1) {
            chain = chain.then(
              (function (pageNumber) {
                return function () {
                  return renderPage(doc, pageNumber).then(function (drawn) {
                    sides[which].appendChild(drawn.node)
                    changes.forEach(function (change, index) {
                      if (change.side === which && change.page === pageNumber) {
                        mark(sides[which], change, index)
                      }
                    })
                  })
                }
              })(number),
            )
          }
          return chain
        })
      }

      return Promise.all([
        drawSide('before', root.getAttribute('data-compare-before')),
        drawSide('after', root.getAttribute('data-compare-after')),
      ]).then(function () {
        if (changes.length) say('')
        follow(sides.before, sides.after)
        follow(sides.after, sides.before)
      })
    })
    .catch(function (err) {
      // The report is still there and still correct; only the view failed.
      say('The documents could not be shown here — the report has the detail. (' + err.message + ')')
    })
})()
