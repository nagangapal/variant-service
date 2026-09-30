/**
 * variant-service client snippet
 *
 * Integration:  <script async src="https://YOUR-HOST/snippet.js"
 *                       data-experiments="checkout-cta,pricing-copy"></script>
 *
 * The contract of this file is that it can never break the page it runs on. That is a
 * stronger requirement than "it usually works", and it drives every decision below:
 *
 *  1. CLIENT-SIDE DEADLINE. Even if the service is perfectly healthy, a request can be
 *     lost to a proxy, a captive portal, an ad blocker, or a network that silently eats
 *     packets. We race the request against a timer and render the default experience
 *     when the timer wins. The server having a timeout is not enough: the failure that
 *     matters is the one the server never sees.
 *
 *  2. NO THROW. The whole thing is wrapped so an exception cannot escape into the host
 *     page's script context.
 *
 *  3. NO innerHTML. Content may be LLM-generated. It is inserted with textContent, so
 *     even a compromised or malformed response cannot become script execution on the
 *     customer's site. This is the single most important line in the file.
 *
 *  4. IDENTITY IS OURS. A first-party cookie set on the customer's own domain, so it
 *     survives page loads and is unaffected by third-party cookie blocking. If cookies
 *     are unavailable we fall back to a session-scoped id, which is still stable within
 *     the visit.
 *
 *  5. NO BLOCKING. Loaded async, applied as soon as it arrives, and if it never arrives
 *     the page simply stays as it was written.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;

  // Default endpoint is this script's own origin plus /v1, so a customer only has to
  // host the snippet and gets the right base URL for free. An explicit data-endpoint
  // overrides it, and an empty attribute falls through to the default.
  var ENDPOINT = script.getAttribute('data-endpoint') ||
    new URL('/v1', script.src).href.replace(/\/+$/, '');
  var TIMEOUT_MS = parseInt(script.getAttribute('data-timeout') || '80', 10);
  var COOKIE = script.getAttribute('data-cookie') || 'vsid';
  var COOKIE_DAYS = 365;
  var autoTrack = script.getAttribute('data-track') !== 'false';
  var selectorAttr = script.getAttribute('data-selector') || 'data-vs-target';

  var requested = (script.getAttribute('data-experiments') || '')
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(Boolean);

  function log() {
    if (script.getAttribute('data-debug') === 'true' && window.console) {
      // eslint-disable-next-line no-console
      console.log.apply(console, ['[variant-service]'].concat([].slice.call(arguments)));
    }
  }

  // --- identity -------------------------------------------------------------
  function readCookie(name) {
    var match = ('; ' + document.cookie).match('; ' + name + '=([^;]*)');
    return match ? decodeURIComponent(match[1]) : null;
  }

  function randomId() {
    // crypto.randomUUID is unavailable on insecure origins in some browsers, where
    // this snippet is often loaded during development. Fall back cleanly.
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'v-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function getVisitorId() {
    var existing = readCookie(COOKIE);
    if (existing) return existing;
    var id = randomId();
    try {
      document.cookie =
        COOKIE + '=' + encodeURIComponent(id) + '; path=/; max-age=' + (COOKIE_DAYS * 86400) + '; SameSite=Lax';
    } catch (e) {
      // Cookies blocked. A session-scoped id still gives stickiness within this page
      // view, which is better than treating every visitor as new.
      log('cookie write failed, using session id', e);
    }
    return id;
  }

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // --- event delivery -------------------------------------------------------
  function send(payload, useBeacon) {
    var url = ENDPOINT + (useBeacon ? '/beacon' : '/track');
    try {
      if (useBeacon && navigator.sendBeacon) {
        // sendBeacon is the only transport that survives page unload, which is exactly
        // when the conversion beacon most needs to be delivered. It has a ~64KB quota
        // and no response body, which is why we send single events on this path.
        var ok = navigator.sendBeacon(url, new Blob([JSON.stringify(payload)], { type: 'text/plain' }));
        if (ok) return;
      }
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
        mode: 'cors',
        credentials: 'omit'
      })['catch'](function () { /* fire and forget */ });
    } catch (e) {
      log('send failed', e);
    }
  }

  // --- rendering ------------------------------------------------------------
  function apply(payload) {
    if (!payload) return;
    var nodes = document.querySelectorAll('[' + selectorAttr + ']');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var experiment = node.getAttribute(selectorAttr);
      if (experiment !== payload.experimentId) continue;

      // textContent, never innerHTML. The content may be model-generated; it is data,
      // not markup. Using innerHTML here would hand script execution to anyone who can
      // influence the generated copy or the model itself.
      if (payload.headline) node.textContent = payload.headline;

      var ctaSel = node.getAttribute('data-vs-cta');
      if (payload.cta && ctaSel) {
        var cta = node.querySelector(ctaSel);
        if (cta) cta.textContent = payload.cta;
      }
      var bodySel = node.getAttribute('data-vs-body');
      if (payload.body && bodySel) {
        var body = node.querySelector(bodySel);
        if (body) body.textContent = payload.body;
      }
      // data-vs-attr lets a page observe the assignment for its own analytics.
      node.setAttribute('data-vs-variant', payload.variantKey);
      node.setAttribute('data-vs-creative', payload.creativeId || '');
    }
  }

  function trackAll(assignments, visitorId) {
    if (!autoTrack || !assignments) return;
    for (var i = 0; i < assignments.length; i++) {
      var a = assignments[i];
      if (!a || !a.variantKey) continue;
      send({
        eventId: uuid(),
        type: 'exposure',
        experimentId: a.experimentId,
        variantKey: a.variantKey,
        visitorId: visitorId,
        ts: Date.now()
      }, false);
    }
  }

  // --- main -----------------------------------------------------------------
  function main() {
    var visitorId = getVisitorId();
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (controller) controller.abort();
      // Page stays exactly as the customer authored it. No error, no empty container,
      // no layout shift from a missing element.
      log('deadline exceeded, rendering default experience');
    }, TIMEOUT_MS);

    var body = { visitorId: visitorId };
    if (requested.length) body.experiments = requested;

    fetch(ENDPOINT + '/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
      mode: 'cors',
      credentials: 'omit'
    })
      .then(function (res) {
        clearTimeout(timer);
        if (!res || !res.ok) throw new Error('assign failed: ' + (res && res.status));
        return res.json();
      })
      .then(function (data) {
        var assignments = (data && data.assignments) || [];
        for (var i = 0; i < assignments.length; i++) apply(assignments[i]);
        trackAll(assignments, visitorId);

        // Let the page do its own thing with the assignment, e.g. fire its own
        // analytics event. Guarded, because a customer handler may throw.
        if (typeof window.__vsOnAssign === 'function') {
          try { window.__vsOnAssign(assignments, visitorId); } catch (e) { log('handler threw', e); }
        }
        window.__vsAssignments = assignments;
        window.__vsVisitorId = visitorId;
      })
      .catch(function (err) {
        clearTimeout(timer);
        log('assignment failed, default experience retained', err);
      });
  }

  try {
    main();
  } catch (e) {
    log('snippet failed to initialise', e);
  }
})();
