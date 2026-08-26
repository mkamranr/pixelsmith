// HTML to image: render a preview without creating a job.
//
// The form still posts normally to create a real job, so the page works with
// this script absent. The preview only saves you from committing to a job to
// find out that the viewport was wrong.
'use strict'
;(function () {
  var form = document.querySelector('form[data-htmlshot]')
  if (!form) return

  var empty = form.querySelector('[data-shot-empty]')
  var result = form.querySelector('[data-shot-result]')
  var busy = form.querySelector('[data-shot-busy]')
  var errorBox = form.querySelector('[data-shot-error]')
  var image = form.querySelector('[data-shot-image]')
  var meta = form.querySelector('[data-shot-meta]')

  var currentUrl = null
  var inFlight = false

  function show(state) {
    empty.hidden = state !== 'empty'
    result.hidden = state !== 'result'
    busy.hidden = state !== 'busy'
    if (state !== 'error') errorBox.hidden = true
  }

  function fail(message) {
    errorBox.hidden = false
    errorBox.textContent = message
    // Keep any previous render on screen; losing it on a failed retry is worse
    // than showing a stale image next to the reason.
    show(image.src ? 'result' : 'empty')
    errorBox.hidden = false
  }

  function conditionalFields() {
    var conditional = form.querySelectorAll('[data-show-when-field]')
    function apply() {
      Array.prototype.forEach.call(conditional, function (node) {
        var source = form.elements[node.getAttribute('data-show-when-field')]
        if (!source) return
        var allowed = (node.getAttribute('data-show-when-equals') || '').split(',')
        node.hidden = allowed.indexOf(source.value) === -1
      })
    }
    form.addEventListener('change', apply)
    form.addEventListener('input', apply)
    apply()
  }

  async function preview() {
    if (inFlight) return
    var data = new FormData(form)
    var payload = {}
    data.forEach(function (value, key) {
      if (key === '_csrf') return
      payload[key] = value
    })
    // Checkboxes absent from FormData mean false, which the server would
    // otherwise fill in from the schema default.
    ;['fullPage', 'blockThirdParty', 'hideOverlays'].forEach(function (key) {
      payload[key] = data.has(key)
    })

    if (payload.source === 'url' && !String(payload.url || '').trim()) {
      fail('Enter a web address first.')
      return
    }
    if (payload.source === 'html' && !String(payload.html || '').trim()) {
      fail('Paste some HTML first.')
      return
    }

    inFlight = true
    show('busy')

    try {
      var response = await fetch('/api/preview/html-to-image', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': data.get('_csrf') },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        var detail
        try {
          detail = (await response.json()).error.message
        } catch (err) {
          detail = 'The preview failed (' + response.status + ').'
        }
        fail(detail)
        return
      }

      var blob = await response.blob()
      if (currentUrl) URL.revokeObjectURL(currentUrl)
      currentUrl = URL.createObjectURL(blob)
      image.src = currentUrl
      if (meta) {
        meta.textContent =
          (payload.source === 'url' ? payload.url : 'pasted HTML') +
          ' — ' + payload.width + 'px wide, ' + Math.round(blob.size / 1024) + ' KB'
      }
      show('result')
    } catch (err) {
      fail('Could not reach the server for a preview.')
    } finally {
      inFlight = false
    }
  }

  Array.prototype.forEach.call(form.querySelectorAll('[data-shot-refresh]'), function (button) {
    button.addEventListener('click', preview)
  })

  // Enter in the URL field previews rather than submitting a job by accident.
  var urlField = form.elements.url
  if (urlField) {
    urlField.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault()
        preview()
      }
    })
  }

  conditionalFields()
})()
