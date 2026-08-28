// First-page thumbnails for document results.
//
// Every result used to be rendered in an <img>, which for a PDF is a broken
// image icon with the filename as alt text. The page now renders a labelled
// tile instead, and this replaces that tile with the actual first page where
// the browser can draw one.
//
// Progressive enhancement in the strict sense: the tile is already correct and
// readable, so nothing here is required. If pdf.js fails to load, the fetch is
// refused, or the file has been swept, the tile stays exactly as it was.
'use strict'
;(function () {
  var root = document.querySelector('[data-doc-thumbs]')
  if (!root) return

  var tiles = [].slice.call(document.querySelectorAll('[data-doc-tile]'))
  if (!tiles.length) return

  var WIDTH = 240
  var pdfjsReady = null

  function loadPdfjs() {
    if (!pdfjsReady) {
      pdfjsReady = import(root.getAttribute('data-pdfjs')).then(function (pdfjs) {
        pdfjs.GlobalWorkerOptions.workerSrc = root.getAttribute('data-pdfjs-worker')
        return pdfjs
      })
    }
    return pdfjsReady
  }

  function thumbnail(url) {
    return fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('unavailable')
        return res.arrayBuffer()
      })
      .then(function (bytes) {
        return loadPdfjs().then(function (pdfjs) {
          return pdfjs.getDocument({
            data: new Uint8Array(bytes),
            // Served from here: there is no CDN to fall back on, and the
            // default relative path 404s once per page.
            standardFontDataUrl: root.getAttribute('data-pdfjs-fonts'),
            cMapUrl: root.getAttribute('data-pdfjs-cmaps'),
          }).promise
        })
      })
      .then(function (doc) {
        return doc.getPage(1).then(function (page) {
          var natural = page.getViewport({ scale: 1 })
          var viewport = page.getViewport({ scale: WIDTH / natural.width })
          var canvas = document.createElement('canvas')
          canvas.width = Math.ceil(viewport.width)
          canvas.height = Math.ceil(viewport.height)
          canvas.className = 'doc-thumb'
          return page
            .render({ canvasContext: canvas.getContext('2d'), viewport: viewport })
            .promise.then(function () {
              page.cleanup()
              doc.destroy()
              return { canvas: canvas, pages: doc.numPages }
            })
        })
      })
  }

  // One at a time. A results page can hold thirty documents, and rendering them
  // all at once would compete with the page the reader is trying to look at.
  function next() {
    var tile = tiles.shift()
    if (!tile) return
    var url = tile.getAttribute('data-doc-tile')

    thumbnail(url)
      .then(function (drawn) {
        tile.textContent = ''
        tile.classList.add('has-thumb')
        tile.appendChild(drawn.canvas)
        if (drawn.pages > 1) {
          var badge = document.createElement('span')
          badge.className = 'doc-pages'
          badge.textContent = drawn.pages + ' pages'
          tile.appendChild(badge)
        }
      })
      .catch(function () {
        // The tile it already has says what the file is. Leave it.
      })
      .then(next)
  }

  next()
})()
