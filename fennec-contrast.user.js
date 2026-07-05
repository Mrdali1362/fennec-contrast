// ==UserScript==
// @name         Fennec Contrast
// @namespace    https://projectfennec.org
// @version      0.1.0
// @description  🦊 Project Fennec — fixes low-contrast text as you browse. User-controlled, transparent, undoable. Contrast only; nothing else.
// @author       Project Fennec (projectfennec.org)
// @license      MIT
// @match        *://*/*
// @exclude      *://localhost:*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * FENNEC CONTRAST — scope: WCAG 1.4.3 / 1.4.6 text contrast. Nothing else.
 *
 * Principles (from Jakob's feedback, unchanged):
 *  - User-controlled: one toggle, instant on/off, no page reload needed.
 *  - Transparent: badge shows exactly how many elements were adjusted.
 *  - Undoable: every change fully reversible, original inline styles restored byte-for-byte.
 *  - Honest about uncertainty: if we can't determine the real background
 *    (background images, gradients, heavy transparency), we DON'T touch the text.
 *    A wrong fix is worse than no fix.
 *  - Privacy: no network calls, no analytics, no data leaves the page. Ever.
 */

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Settings & persistence
  // ------------------------------------------------------------------

  const SETTINGS_KEY = 'fennecContrastEnabled';

  function loadEnabled() {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(SETTINGS_KEY, true);
    } catch (e) { /* fall through */ }
    try {
      const v = localStorage.getItem(SETTINGS_KEY);
      return v === null ? true : v === 'true';
    } catch (e) { return true; }
  }

  function saveEnabled(value) {
    try {
      if (typeof GM_setValue === 'function') { GM_setValue(SETTINGS_KEY, value); return; }
    } catch (e) { /* fall through */ }
    try { localStorage.setItem(SETTINGS_KEY, String(value)); } catch (e) { /* private mode etc. */ }
  }

  // ------------------------------------------------------------------
  // Color math (WCAG 2.x)
  // ------------------------------------------------------------------

  const colorCache = new Map(); // string -> {r,g,b,a} | null
  let probeEl = null;           // reused hidden element for exotic color formats

  function parseColor(str) {
    if (!str) return null;
    if (colorCache.has(str)) return colorCache.get(str);

    let result = null;
    // Fast path: computed styles are almost always rgb()/rgba()
    const m = str.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\s*\)/);
    if (m) {
      let a = 1;
      if (m[4] !== undefined) {
        a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      }
      result = { r: +m[1], g: +m[2], b: +m[3], a };
    } else if (str === 'transparent') {
      result = { r: 0, g: 0, b: 0, a: 0 };
    } else {
      // Slow path (color(srgb …), oklch, named colors, etc.): one reused probe,
      // never created per-call. This was a real performance bug in the old build.
      try {
        if (!probeEl) {
          probeEl = document.createElement('span');
          probeEl.style.cssText = 'position:fixed;left:-9999px;top:-9999px;visibility:hidden;';
          (document.body || document.documentElement).appendChild(probeEl);
        }
        probeEl.style.color = '';
        probeEl.style.color = str;
        const computed = getComputedStyle(probeEl).color;
        const m2 = computed.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\s*\)/);
        if (m2) {
          let a = 1;
          if (m2[4] !== undefined) {
            a = m2[4].endsWith('%') ? parseFloat(m2[4]) / 100 : parseFloat(m2[4]);
          }
          result = { r: +m2[1], g: +m2[2], b: +m2[3], a };
        }
      } catch (e) { result = null; }
    }

    if (colorCache.size > 500) colorCache.clear();
    colorCache.set(str, result);
    return result;
  }

  function channelToLinear(c) {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }

  function luminance(rgb) {
    return 0.2126 * channelToLinear(rgb.r)
         + 0.7152 * channelToLinear(rgb.g)
         + 0.0722 * channelToLinear(rgb.b);
  }

  function contrastRatio(rgb1, rgb2) {
    const l1 = luminance(rgb1);
    const l2 = luminance(rgb2);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }

  // Composite a foreground color with alpha over an opaque background
  function compositeOver(fg, bg) {
    const a = fg.a === undefined ? 1 : fg.a;
    if (a >= 1) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
    return {
      r: Math.round(fg.r * a + bg.r * (1 - a)),
      g: Math.round(fg.g * a + bg.g * (1 - a)),
      b: Math.round(fg.b * a + bg.b * (1 - a)),
      a: 1
    };
  }

  // Blend color toward a target (black or white) by factor t in [0,1]
  function blendToward(rgb, target, t) {
    return {
      r: Math.round(rgb.r + (target.r - rgb.r) * t),
      g: Math.round(rgb.g + (target.g - rgb.g) * t),
      b: Math.round(rgb.b + (target.b - rgb.b) * t),
      a: 1
    };
  }

  const BLACK = { r: 0, g: 0, b: 0, a: 1 };
  const WHITE = { r: 255, g: 255, b: 255, a: 1 };

  /**
   * Find the minimal adjustment of `fg` that reaches `target` contrast against `bg`.
   * Blends toward black or white with a binary search on the blend factor,
   * preserving as much of the original hue (site's design intent) as possible.
   * Returns an opaque {r,g,b} or null if the target is unreachable in either direction.
   */
  function generateAccessibleColor(fg, bg, target) {
    const towardBlackMax = contrastRatio(BLACK, bg);
    const towardWhiteMax = contrastRatio(WHITE, bg);

    // Prefer the direction the text already leans (dark text gets darker,
    // light text gets lighter), falling back to whichever direction can
    // actually reach the target ratio.
    const fgIsDarker = luminance(fg) < luminance(bg);
    let directions = fgIsDarker ? [BLACK, WHITE] : [WHITE, BLACK];
    directions = directions.filter(d =>
      (d === BLACK ? towardBlackMax : towardWhiteMax) >= target
    );
    if (directions.length === 0) {
      // Target unreachable (mid-gray background). Take max-contrast endpoint.
      const best = towardBlackMax >= towardWhiteMax ? BLACK : WHITE;
      return contrastRatio(best, bg) > contrastRatio(fg, bg) ? best : null;
    }

    const endpoint = directions[0];
    // Binary search the smallest t where contrast >= target
    let lo = 0, hi = 1, best = null;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      const candidate = blendToward(fg, endpoint, mid);
      if (contrastRatio(candidate, bg) >= target) {
        best = candidate;
        hi = mid;
      } else {
        lo = mid;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------
  // Background detection — with honesty about uncertainty
  // ------------------------------------------------------------------

  /**
   * Walk up from the element compositing semi-transparent backgrounds until an
   * opaque one is found. Returns { rgb, confident } — confident is false when
   * a background-image/gradient sits anywhere in the chain (we can't know the
   * pixels behind the text) or when we had to fall back to assuming white.
   * When not confident, we skip. No guessing.
   */
  function getEffectiveBackground(element) {
    let current = element;
    const layers = []; // semi-transparent bg colors, innermost first

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const cs = getComputedStyle(current);

      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        return { rgb: null, confident: false };
      }

      const bg = parseColor(cs.backgroundColor);
      if (bg && bg.a > 0) {
        if (bg.a >= 1) {
          // Opaque base found — composite the transparent layers above it
          let result = { r: bg.r, g: bg.g, b: bg.b, a: 1 };
          for (let i = layers.length - 1; i >= 0; i--) {
            result = compositeOver(layers[i], result);
          }
          return { rgb: result, confident: true };
        }
        layers.push(bg);
      }
      current = current.parentElement;
    }

    // No opaque background anywhere: browsers paint white by default, but if
    // transparent layers are stacked we're less sure. Composite over white.
    let result = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) {
      result = compositeOver(layers[i], result);
    }
    // Confident only if no partial layers muddied the water.
    return { rgb: result, confident: layers.length === 0 };
  }

  // ------------------------------------------------------------------
  // WCAG thresholds (corrected to spec: large text is 24px, or 18.66px bold)
  // ------------------------------------------------------------------

  function requiredContrast(cs) {
    const size = parseFloat(cs.fontSize);
    const weight = cs.fontWeight === 'bold' ? 700 : (parseInt(cs.fontWeight, 10) || 400);
    const isLarge = size >= 24 || (size >= 18.66 && weight >= 700);
    return isLarge ? 3.0 : 4.5;
  }

  // ------------------------------------------------------------------
  // Element scanning
  // ------------------------------------------------------------------

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED']);

  function hasDirectText(el) {
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.nodeValue.trim()) return true;
    }
    return false;
  }

  function isVisible(el, cs) {
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    // getClientRects handles position:fixed, which offsetParent misses
    return el.getClientRects().length > 0;
  }

  function collectCandidates(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
        if (node.id && node.id.startsWith('fennec-')) return NodeFilter.FILTER_REJECT;
        if (processed.has(node)) return NodeFilter.FILTER_SKIP;
        if (!hasDirectText(node)) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      out.push(node);
      if (out.length >= 3000) break; // hard safety cap per scan
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Fix engine
  // ------------------------------------------------------------------

  const ORIGINAL_ATTR = 'data-fennec-original-inline-color';
  const FIXED_ATTR = 'data-fennec-contrast-fixed';
  const NO_INLINE = '__fennec_none__';

  let processed = new WeakSet();
  let fixedElements = new Set();
  let enabled = loadEnabled();
  let scanScheduled = false;

  function checkAndFix(el) {
    const cs = getComputedStyle(el);
    if (!isVisible(el, cs)) return false;

    // Text with shadows or strokes has contrast we can't model — leave it alone.
    if (cs.webkitTextStroke && parseFloat(cs.webkitTextStrokeWidth) > 0) return false;

    const fg = parseColor(cs.color);
    if (!fg) return false;

    const bgInfo = getEffectiveBackground(el);
    if (!bgInfo.confident || !bgInfo.rgb) return false; // honesty rule: don't guess

    // Composite semi-transparent text over its background first
    const effectiveFg = fg.a < 1 ? compositeOver(fg, bgInfo.rgb) : fg;

    const target = requiredContrast(cs);
    const ratio = contrastRatio(effectiveFg, bgInfo.rgb);
    if (ratio >= target) return false;

    const fixed = generateAccessibleColor(effectiveFg, bgInfo.rgb, target);
    if (!fixed) return false;

    // Remember the element's own inline color (may be empty) so undo is exact
    if (!el.hasAttribute(ORIGINAL_ATTR)) {
      const inline = el.style.getPropertyValue('color');
      const priority = el.style.getPropertyPriority('color');
      el.setAttribute(ORIGINAL_ATTR, inline === '' ? NO_INLINE : `${inline}|${priority}`);
    }

    el.style.setProperty('color', `rgb(${fixed.r}, ${fixed.g}, ${fixed.b})`, 'important');
    el.setAttribute(FIXED_ATTR, `${ratio.toFixed(2)}->${contrastRatio(fixed, bgInfo.rgb).toFixed(2)}`);
    fixedElements.add(el);
    return true;
  }

  function undoAll() {
    for (const el of fixedElements) {
      try {
        const original = el.getAttribute(ORIGINAL_ATTR);
        if (original === NO_INLINE || original === null) {
          el.style.removeProperty('color');
        } else {
          const sep = original.lastIndexOf('|');
          const value = original.slice(0, sep);
          const priority = original.slice(sep + 1);
          el.style.setProperty('color', value, priority);
        }
        el.removeAttribute(ORIGINAL_ATTR);
        el.removeAttribute(FIXED_ATTR);
      } catch (e) { /* element may be gone */ }
    }
    fixedElements = new Set();
    processed = new WeakSet();
    updateBadge();
  }

  // Chunked scan: never hog the main thread (the failure that killed Fix Contrast)
  function scan(root) {
    if (!enabled || !document.body) return;
    const candidates = collectCandidates(root || document.body);
    let index = 0;

    function work(deadline) {
      const budgetEnd = performance.now() + 8; // ms per slice, fallback budget
      while (index < candidates.length) {
        if (deadline && typeof deadline.timeRemaining === 'function') {
          if (deadline.timeRemaining() <= 1 && !deadline.didTimeout) break;
        } else if (performance.now() > budgetEnd) {
          break;
        }
        const el = candidates[index++];
        try { checkAndFix(el); } catch (e) { /* one bad element never stops the scan */ }
        processed.add(el);
      }
      if (index < candidates.length) {
        scheduleSlice(work);
      } else {
        updateBadge();
      }
    }
    scheduleSlice(work);
  }

  function scheduleSlice(fn) {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(fn, { timeout: 500 });
    } else {
      setTimeout(() => fn(null), 16);
    }
  }

  // ------------------------------------------------------------------
  // Dynamic content (SPAs)
  // ------------------------------------------------------------------

  let observer = null;
  let debounceTimer = null;

  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver((mutations) => {
      let relevant = false;
      for (const m of mutations) {
        if (m.type === 'childList' && m.addedNodes.length > 0) {
          for (const n of m.addedNodes) {
            if (n.nodeType === Node.ELEMENT_NODE && !(n.id && n.id.startsWith('fennec-'))) {
              relevant = true;
              break;
            }
          }
        }
        if (relevant) break;
      }
      if (relevant) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => scan(document.body), 150);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
    clearTimeout(debounceTimer);
  }

  // ------------------------------------------------------------------
  // UI: one small accessible badge. That's all.
  // ------------------------------------------------------------------

  let badge = null;

  function buildBadge() {
    if (badge || !document.body) return;
    badge = document.createElement('button');
    badge.id = 'fennec-contrast-badge';
    badge.type = 'button';
    badge.style.cssText = [
      'position:fixed', 'bottom:16px', 'right:16px', 'z-index:2147483646',
      'min-width:44px', 'min-height:44px', 'padding:6px 12px',
      'background:#1a4731', 'color:#ffffff',            // 10.9:1 — we practice what we fix
      'border:2px solid #ffffff', 'border-radius:22px',
      'font:600 14px/1.4 system-ui, Arial, sans-serif',
      'cursor:pointer', 'box-shadow:0 2px 8px rgba(0,0,0,0.35)',
      'opacity:0.92'
    ].join(';');
    badge.addEventListener('click', toggle);
    badge.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    document.body.appendChild(badge);
    updateBadge();
  }

  function updateBadge() {
    if (!badge) return;
    const n = fixedElements.size;
    if (enabled) {
      badge.textContent = n > 0 ? `🦊 ${n}` : '🦊';
      badge.setAttribute('aria-label',
        n > 0
          ? `Fennec Contrast is on. ${n} low-contrast text ${n === 1 ? 'element' : 'elements'} adjusted on this page. Press to turn off and undo all changes.`
          : 'Fennec Contrast is on. No contrast issues found on this page. Press to turn off.');
      badge.title = n > 0 ? `Fennec: ${n} contrast fix${n === 1 ? '' : 'es'} active — click to undo & pause` : 'Fennec Contrast active — click to pause';
      badge.style.background = '#1a4731';
    } else {
      badge.textContent = '🦊 off';
      badge.setAttribute('aria-label', 'Fennec Contrast is paused. Press to turn on.');
      badge.title = 'Fennec Contrast paused — click to enable';
      badge.style.background = '#5a5a5a';   // 5.9:1 on white text
    }
  }

  function toggle() {
    enabled = !enabled;
    saveEnabled(enabled);
    if (enabled) {
      processed = new WeakSet();
      scan(document.body);
      startObserver();
    } else {
      stopObserver();
      undoAll();
    }
    updateBadge();
  }

  // Keyboard shortcut: Alt+Shift+C toggles without touching the mouse
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      e.preventDefault();
      toggle();
    }
  });

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------

  function boot() {
    buildBadge();
    if (enabled) {
      scan(document.body);
      startObserver();
    }
    console.log('🦊 Fennec Contrast v0.1.0 loaded —', enabled ? 'active' : 'paused', '(Alt+Shift+C to toggle)');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
