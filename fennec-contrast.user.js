// ==UserScript==
// @name         Fennec Contrast
// @namespace    https://projectfennec.org
// @version      0.1.7
// @description  🦊 Project Fennec — fixes low-contrast text as you browse. User-controlled, transparent, undoable. Contrast only; nothing else.
// @author       Project Fennec (projectfennec.org)
// @license      MIT
// @match        *://*/*
// @exclude      *://localhost:*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
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
 *
 * v0.1.1 (2026-07-05) — Dark-mode fix, from the first field bug report:
 *   v0.1.0 assumed a white background when no ancestor declared one, which
 *   darkened light text in dark-mode apps (Gmail) whose backgrounds live on
 *   non-ancestor layers or the browser canvas. Now: (1) hit-test the layers
 *   painted beneath the text via elementsFromPoint, (2) treat a dark
 *   color-scheme canvas as unknowable, (3) never "fix" near-white text
 *   against a merely-assumed white background.
 *
 * v0.1.2 (2026-07-06) — Same Gmail bug persisted; architectural fix:
 *   Background detection is now PAINT-ORDER-FIRST (hit-test stack via
 *   elementsFromPoint) instead of DOM-ancestor-first. The ancestor walk can
 *   report a background that exists in the DOM but is visually painted over
 *   by another layer — the hit-test stack reflects what's actually drawn.
 *   Ancestor walk demoted to fallback for offscreen elements. Added
 *   diagnostics: Alt+Shift+D (or window.fennecReport()) dumps every fix
 *   with its detected colors, ratios, and background source.
 *
 * v0.1.3 (2026-07-06) — Transparency for humans, not just developers:
 *   tester feedback: "it shows 1 issue but I can't see what it is." The
 *   badge now opens a panel listing every change in plain language
 *   (text snippet + before/after contrast ratios); selecting one scrolls
 *   to and highlights the element. Undo moved into the panel. Alt+Shift+C
 *   still toggles instantly; Escape closes the panel.
 *
 * v0.1.4 (2026-07-07) — Explain the silences, not just the fixes:
 *   field case: axe flagged orange banner text that Fennec skipped, and
 *   the diagnostics couldn't say why — Fennec only logged actions, never
 *   abstentions. Added why-mode: Alt+Shift+W then click any text (or
 *   fennecWhy($0) in the console) prints the full decision trace —
 *   visibility, detected colors, background source, thresholds, measured
 *   ratio, and the exact skip reason or would-be fix. Dry-run only.
 *
 * v0.1.5 (2026-07-07) — One number, one meaning:
 *   tester report: badge said 3, panel showed 1. The badge counted every
 *   fix since page load; the panel counted only elements still in the DOM.
 *   SPA re-renders remove fixed elements, leaving ghost counts. Now stale
 *   fixes are pruned everywhere the count is shown: detached elements are
 *   reverted and released for fresh evaluation if the site re-attaches
 *   them. Badge and panel now always answer the same question: fixes
 *   ACTIVE on this page right now. Also: tiny/symbol-only text entries in
 *   the panel now say what element they are.
 *
 * v0.1.6 (2026-07-07) — The polarity rule; a fix must never look worse:
 *   field report: white price digits on saturated red-orange (≈3.8:1,
 *   a WCAG 2 failure) were "fixed" to a passing 4.5:1 gray that human
 *   eyes read as WORSE. That's a known flaw in the WCAG 2 formula (it
 *   ignores polarity; APCA/WCAG 3 addresses it). New rule: fixes may
 *   never flip text across its light/dark polarity — light text stays
 *   light, dark stays dark. If the target ratio is unreachable on the
 *   text's own side, Fennec refuses and leaves the design alone (traced
 *   as an explicit skip reason in why-mode). Sole exception: text with
 *   ~identical luminance to its background (invisible) may be rescued in
 *   either direction. Full unit suite re-run: all regressions pass, the
 *   price-tag case is now refused.
 *
 * v0.1.7 (2026-07-07) — The #949494 postmortem; worst bug so far:
 *   tester proved a "fix" of #949494 on #FF3927 = 1.2:1 — Fennec made
 *   text nearly invisible. Root cause: the red shape was a ::before
 *   pseudo-element, invisible to BOTH background resolvers, so Fennec
 *   confidently resolved "white", saw white-on-white, and the v0.1.6
 *   invisible-text exception rescued it into the minimal 3.0:1 gray for
 *   white — #949494 exactly (fingerprint verified in unit tests: that
 *   gray on the real red = 1.18:1, matching the report). Three fixes:
 *   (1) painted ::before/::after anywhere in the resolution chain now
 *   means the background is unknowable — skip; (2) the invisible-text
 *   rescue exception is removed — polarity rule is now absolute;
 *   (3) sanity check: text (nearly) identical to its resolved background
 *   is hidden text or a misread — never colorized. 13/13 unit tests pass.
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
   * Blends toward black or white with a binary search on the blend factor.
   *
   * POLARITY RULE (v0.1.6, tightened v0.1.7): the fix must never flip text
   * across its light/dark polarity. If the required ratio can't be reached
   * on the text's own side, return null and leave the text alone. The
   * v0.1.6 "invisible text rescue" exception is REMOVED: text matching its
   * resolved background is more often the signature of a MISREAD background
   * (pseudo-element case, 2026-07-07: white price digits "rescued" to a
   * 1.2:1 gray) or intentionally hidden text — both mean don't touch.
   */
  function generateAccessibleColor(fg, bg, target) {
    const fgIsDarker = luminance(fg) < luminance(bg);
    const endpoint = fgIsDarker ? BLACK : WHITE;

    if (contrastRatio(endpoint, bg) < target) {
      return null; // refuse: unreachable without flipping polarity
    }

    // Binary search the smallest blend factor where contrast >= target
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
   * v0.1.2: Background resolution is now PAINT-ORDER-FIRST. The DOM-ancestor
   * walk (v0.1.0/0.1.1) can be fooled by backgrounds that exist in the DOM but
   * are visually painted over by other layers (dark themes over legacy light
   * containers — suspected Gmail root cause). The hit-test stack reflects what
   * the browser actually draws, in order, including non-ancestor layers.
   */
  function getEffectiveBackground(element) {
    // PRIMARY: what is actually painted beneath this element
    const visual = getVisualBackground(element);
    if (visual) return visual;

    // FALLBACK (element offscreen or not hit-testable): DOM-ancestor walk
    let current = element;
    const layers = []; // semi-transparent bg colors, innermost first

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      if (hasPseudoBackground(current)) {
        return { rgb: null, confident: false, source: 'ancestor:pseudo-element' };
      }
      const cs = getComputedStyle(current);

      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        return { rgb: null, confident: false, source: 'ancestor:image' };
      }

      const bg = parseColor(cs.backgroundColor);
      if (bg && bg.a > 0) {
        if (bg.a >= 1) {
          let result = { r: bg.r, g: bg.g, b: bg.b, a: 1 };
          for (let i = layers.length - 1; i >= 0; i--) {
            result = compositeOver(layers[i], result);
          }
          return { rgb: result, confident: true, source: 'ancestor' };
        }
        layers.push(bg);
      }
      current = current.parentElement;
    }

    // Nothing declared anywhere. If the page opted into a dark canvas,
    // "white" is a lie — skip rather than guess.
    const rootScheme = (getComputedStyle(document.documentElement).colorScheme || '').toLowerCase();
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (rootScheme.includes('dark') && (prefersDark || !rootScheme.includes('light'))) {
      return { rgb: null, confident: false, source: 'canvas:dark' };
    }

    // Last resort: assume the default white canvas — flagged as an ASSUMPTION
    // so checkAndFix applies the light-text suspicion guard.
    let result = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) {
      result = compositeOver(layers[i], result);
    }
    return { rgb: result, confident: layers.length === 0, assumed: true, source: 'assumed-white' };
  }

  /**
   * v0.1.7: Pseudo-element backgrounds (::before/::after with a fill) are
   * invisible to BOTH resolvers — they're not DOM ancestors and don't appear
   * in elementsFromPoint. A skewed ::before painted the red price tag that
   * both methods looked straight through, resolving "white" with full
   * confidence. If any element in the chain carries a painted pseudo, we
   * can't know what's really behind the text. Honesty rule: skip.
   */
  function hasPseudoBackground(el) {
    for (const which of ['::before', '::after']) {
      let ps;
      try { ps = getComputedStyle(el, which); } catch (e) { continue; }
      if (!ps || !ps.content || ps.content === 'none') continue;
      if (ps.backgroundImage && ps.backgroundImage !== 'none') return true;
      const bg = parseColor(ps.backgroundColor);
      if (bg && bg.a > 0) return true;
    }
    return false;
  }

  /**
   * Resolve the background by walking the hit-test stack at the element's
   * center — top to bottom in PAINT order. Composites translucent layers,
   * stops at the first opaque one. Returns null when the element can't be
   * hit-tested (offscreen, covered in a way that hides it from the stack).
   */
  function getVisualBackground(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return null;

    let stack;
    try { stack = document.elementsFromPoint(x, y); } catch (e) { return null; }
    if (!stack || stack.length === 0) return null;

    // Start at the element itself; if an overlay hides it from the stack
    // (transparent click-targets are common), start at its nearest ancestor
    // present in the stack — everything from there down is painted beneath.
    let start = stack.indexOf(element);
    if (start === -1) {
      start = stack.findIndex(el => el !== element && el.contains(element));
      if (start === -1) return null;
    }

    const layers = [];
    for (let i = start; i < stack.length; i++) {
      if (hasPseudoBackground(stack[i])) {
        return { rgb: null, confident: false, source: 'visual:pseudo-element' };
      }
      const cs = getComputedStyle(stack[i]);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        return { rgb: null, confident: false, source: 'visual:image' };
      }
      const bg = parseColor(cs.backgroundColor);
      if (bg && bg.a > 0) {
        if (bg.a >= 1) {
          let result = { r: bg.r, g: bg.g, b: bg.b, a: 1 };
          for (let j = layers.length - 1; j >= 0; j--) {
            result = compositeOver(layers[j], result);
          }
          return { rgb: result, confident: true, source: 'visual' };
        }
        layers.push(bg);
      }
    }
    return null; // fell through to canvas — let the fallback logic decide
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
  let fixLog = []; // debug records: why each fix happened (Alt+Shift+D to dump)
  let enabled = loadEnabled();
  let scanScheduled = false;

  function checkAndFix(el, trace) {
    const t = trace ? (m) => trace.push(m) : null;
    const cs = getComputedStyle(el);
    if (!isVisible(el, cs)) {
      if (t) t('SKIP: element not visible (display/visibility/opacity/zero-size)');
      return false;
    }

    // Text with shadows or strokes has contrast we can't model — leave it alone.
    if (cs.webkitTextStroke && parseFloat(cs.webkitTextStrokeWidth) > 0) {
      if (t) t('SKIP: text-stroke present — contrast not modelable');
      return false;
    }

    const fg = parseColor(cs.color);
    if (!fg) {
      if (t) t('SKIP: could not parse text color: ' + cs.color);
      return false;
    }
    if (t) t('Text color: ' + cs.color);

    const bgInfo = getEffectiveBackground(el);
    if (t) t('Background: ' + (bgInfo.rgb ? `rgb(${bgInfo.rgb.r},${bgInfo.rgb.g},${bgInfo.rgb.b})` : 'UNRESOLVED')
      + ` — source: ${bgInfo.source || '?'}, confident: ${!!bgInfo.confident}${bgInfo.assumed ? ', ASSUMED' : ''}`);
    if (!bgInfo.confident || !bgInfo.rgb) {
      if (t) t('SKIP: background not confidently resolved (image/gradient/translucent layers in paint stack, or dark canvas) — honesty rule: Fennec does not guess');
      return false; // honesty rule: don't guess
    }

    // Composite semi-transparent text over its background first
    const effectiveFg = fg.a < 1 ? compositeOver(fg, bgInfo.rgb) : fg;
    if (t && fg.a < 1) t(`Text has alpha ${fg.a} — composited to rgb(${effectiveFg.r},${effectiveFg.g},${effectiveFg.b})`);

    // Suspicion guard: very light text + a background we only ASSUMED to be
    // white is the signature of a dark-mode app we failed to read (the Gmail
    // bug). Designers don't put near-white text on white on purpose. Skip.
    if (bgInfo.assumed && luminance(effectiveFg) > 0.5) {
      if (t) t('SKIP: near-white text on a merely-ASSUMED white background (dark-mode guard)');
      return false;
    }

    const target = requiredContrast(cs);
    if (t) t(`Font: ${cs.fontSize}, weight ${cs.fontWeight} → ${target === 3 ? 'LARGE text' : 'normal text'}, required ratio ${target}:1`);
    const ratio = contrastRatio(effectiveFg, bgInfo.rgb);
    if (t) t(`Measured contrast: ${ratio.toFixed(2)}:1`);

    // Sanity check (v0.1.7): text that is (nearly) the SAME color as its
    // resolved background is either intentionally hidden text or the
    // signature of a background we misread. Colorizing it is wrong in both
    // cases — this is how white price digits became 1.2:1 gray.
    if (ratio < 1.05) {
      if (t) t('SKIP: text and resolved background are essentially the same color — either intentionally hidden text or Fennec misread the background. Refusing to colorize.');
      return false;
    }

    if (ratio >= target) {
      if (t) t(`PASS: ${ratio.toFixed(2)} ≥ ${target} — no fix needed`);
      return false;
    }

    const fixed = generateAccessibleColor(effectiveFg, bgInfo.rgb, target);
    if (!fixed) {
      if (t) t('SKIP: reaching the required ratio would flip the text\'s light/dark polarity (e.g., white→gray on a colored background). WCAG 2 math would call that a pass; human eyes would call it worse. Fennec refuses.');
      return false;
    }

    if (t) {
      t(`WOULD FIX: rgb(${fixed.r},${fixed.g},${fixed.b}) → ${contrastRatio(fixed, bgInfo.rgb).toFixed(2)}:1 (diagnosis is a dry run; nothing was applied)`);
      return false;
    }

    // Remember the element's own inline color (may be empty) so undo is exact
    if (!el.hasAttribute(ORIGINAL_ATTR)) {
      const inline = el.style.getPropertyValue('color');
      const priority = el.style.getPropertyPriority('color');
      el.setAttribute(ORIGINAL_ATTR, inline === '' ? NO_INLINE : `${inline}|${priority}`);
    }

    const newRatio = contrastRatio(fixed, bgInfo.rgb);
    el.style.setProperty('color', `rgb(${fixed.r}, ${fixed.g}, ${fixed.b})`, 'important');
    el.setAttribute(FIXED_ATTR, `${ratio.toFixed(2)}->${newRatio.toFixed(2)} via ${bgInfo.source || 'unknown'}`);
    fixedElements.add(el);
    fixLog.push({
      el,
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().slice(0, 40),
      fg: `rgb(${effectiveFg.r},${effectiveFg.g},${effectiveFg.b})`,
      bg: `rgb(${bgInfo.rgb.r},${bgInfo.rgb.g},${bgInfo.rgb.b})`,
      bgSource: bgInfo.source || 'unknown',
      before: +ratio.toFixed(2),
      after: +newRatio.toFixed(2),
      target
    });
    return true;
  }

  /**
   * v0.1.5: Prune fixes whose elements the site has removed from the DOM
   * (SPA re-renders). The badge counted every fix ever made; the panel only
   * showed living ones — two different numbers for the same question.
   * Pruned elements are reverted (free — they're detached) and released
   * from `processed`, so if the site re-attaches them they get a fresh
   * evaluation instead of stale bookkeeping.
   */
  function pruneStale() {
    for (const el of fixedElements) {
      if (!el.isConnected) {
        try { revertElement(el); } catch (e) { /* already gone entirely */ }
        processed.delete(el);
        fixedElements.delete(el);
      }
    }
    fixLog = fixLog.filter(f => f.el && f.el.isConnected);
  }

  function revertElement(el) {
    const original = el.getAttribute(ORIGINAL_ATTR);
    if (original === NO_INLINE || original === null) {
      el.style.removeProperty('color');
    } else {
      const sep = original.lastIndexOf('|');
      el.style.setProperty('color', original.slice(0, sep), original.slice(sep + 1));
    }
    el.removeAttribute(ORIGINAL_ATTR);
    el.removeAttribute(FIXED_ATTR);
  }

  function undoAll() {
    for (const el of fixedElements) {
      try { revertElement(el); } catch (e) { /* element may be gone */ }
    }
    fixedElements = new Set();
    fixLog = [];
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
    badge.addEventListener('click', onBadgeActivate);
    badge.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onBadgeActivate(); }
    });
    document.body.appendChild(badge);
    updateBadge();
  }

  function onBadgeActivate() {
    if (!enabled) { toggle(); return; }
    openPanel();
  }

  function updateBadge() {
    if (!badge) return;
    pruneStale();
    const n = fixedElements.size;
    if (enabled) {
      badge.textContent = n > 0 ? `🦊 ${n}` : '🦊';
      badge.setAttribute('aria-label',
        n > 0
          ? `Fennec Contrast is on. ${n} low-contrast text ${n === 1 ? 'element' : 'elements'} adjusted on this page. Press to review the changes.`
          : 'Fennec Contrast is on. No contrast issues found on this page. Press for options.');
      badge.title = n > 0 ? `Fennec: ${n} contrast fix${n === 1 ? '' : 'es'} — click to review` : 'Fennec Contrast active — click for options';
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
    if (panel) closePanel();
    updateBadge();
  }

  // ------------------------------------------------------------------
  // Fixes panel — transparency without DevTools
  // ------------------------------------------------------------------

  let panel = null;

  const BTN_BASE = [
    'display:block', 'width:100%', 'text-align:left', 'min-height:44px',
    'padding:10px 12px', 'margin:0 0 6px 0', 'background:#ffffff', 'color:#1a1a1a',
    'border:1px solid #767676', 'border-radius:8px',
    'font:400 14px/1.4 system-ui, Arial, sans-serif', 'cursor:pointer'
  ].join(';');

  function openPanel() {
    if (panel) { closePanel(); return; }
    pruneStale();

    panel = document.createElement('div');
    panel.id = 'fennec-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Fennec Contrast: changes on this page');
    panel.style.cssText = [
      'position:fixed', 'bottom:72px', 'right:16px', 'z-index:2147483647',
      'width:min(340px, calc(100vw - 32px))', 'max-height:min(420px, 70vh)',
      'overflow-y:auto', 'background:#ffffff', 'color:#1a1a1a',
      'border:2px solid #1a4731', 'border-radius:12px', 'padding:14px',
      'font:400 14px/1.5 system-ui, Arial, sans-serif',
      'box-shadow:0 4px 16px rgba(0,0,0,0.35)'
    ].join(';');

    const heading = document.createElement('h2');
    heading.textContent = '🦊 Fennec Contrast';
    heading.style.cssText = 'font-size:16px;margin:0 0 4px 0;color:#1a4731;';
    panel.appendChild(heading);

    const entries = fixLog.filter(f => f.el && f.el.isConnected);
    const intro = document.createElement('p');
    intro.style.cssText = 'margin:0 0 10px 0;font-size:13px;';
    intro.textContent = entries.length === 0
      ? (enabled ? 'No text was changed on this page.' : 'Fennec is paused. No changes active.')
      : `${entries.length} low-contrast text ${entries.length === 1 ? 'element' : 'elements'} adjusted. Select one to highlight it on the page:`;
    panel.appendChild(intro);

    entries.forEach((f, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.style.cssText = BTN_BASE;
      const label = f.text && f.text.length >= 3
        ? `“${f.text}${f.text.length >= 40 ? '…' : ''}”`
        : (f.text ? `“${f.text}” (a small <${f.tag}> element)` : `<${f.tag}> element`);
      btn.textContent = `${i + 1}. ${label} — contrast ${f.before}:1 → ${f.after}:1`;
      btn.setAttribute('aria-label',
        `Change ${i + 1} of ${entries.length}: ${f.text || f.tag + ' element'}. ` +
        `Contrast improved from ${f.before} to 1, to ${f.after} to 1. Press to highlight it on the page.`);
      btn.addEventListener('click', () => highlightFix(f.el));
      panel.appendChild(btn);
    });

    if (entries.length > 0) {
      const undoBtn = document.createElement('button');
      undoBtn.type = 'button';
      undoBtn.style.cssText = BTN_BASE + ';background:#1a4731;color:#ffffff;border-color:#1a4731;font-weight:600;margin-top:4px;';
      undoBtn.textContent = 'Undo all & pause Fennec';
      undoBtn.addEventListener('click', toggle);
      panel.appendChild(undoBtn);
    }

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.style.cssText = BTN_BASE + ';margin-bottom:0;';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', closePanel);
    panel.appendChild(closeBtn);

    document.body.appendChild(panel);
    document.addEventListener('keydown', panelEscHandler, true);
    const first = panel.querySelector('button');
    if (first) first.focus();
  }

  function closePanel() {
    if (!panel) return;
    document.removeEventListener('keydown', panelEscHandler, true);
    panel.remove();
    panel = null;
    if (badge) badge.focus();
  }

  function panelEscHandler(e) {
    if (e.key === 'Escape') { e.preventDefault(); closePanel(); }
  }

  function highlightFix(el) {
    if (!el || !el.isConnected) return;
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    const prevOutline = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = '3px solid #c2410c';
    el.style.outlineOffset = '2px';
    setTimeout(() => {
      el.style.outline = prevOutline;
      el.style.outlineOffset = prevOffset;
    }, 2500);
  }

  // Keyboard shortcut: Alt+Shift+C toggles without touching the mouse
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      e.preventDefault();
      toggle();
    }
    // Alt+Shift+D: dump a diagnostic report of every fix to the console
    if (e.altKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      dumpReport();
    }
    // Alt+Shift+W: why-mode — click any text to get a decision trace
    if (e.altKey && e.shiftKey && (e.key === 'W' || e.key === 'w')) {
      e.preventDefault();
      toggleWhyMode();
    }
  });

  function dumpReport() {
    console.group('🦊 Fennec Contrast v0.1.7 — diagnostic report');
    console.log('Enabled:', enabled, '| Fixes on this page:', fixLog.length);
    console.log('Root color-scheme:', getComputedStyle(document.documentElement).colorScheme,
      '| prefers-color-scheme dark:', window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (fixLog.length) {
      console.table(fixLog);
      console.log('For a wrong fix: note its bgSource. "visual" = paint-order hit-test, ' +
        '"ancestor" = DOM walk fallback, "assumed-white" = default canvas assumption.');
    } else {
      console.log('No fixes applied.');
    }
    console.groupEnd();
  }

  // Also reachable from the console for testers: window.fennecReport()
  try {
    const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    w.fennecReport = dumpReport;
    w.fennecWhy = diagnoseElement;
  } catch (e) { /* sandboxed */ }

  // ------------------------------------------------------------------
  // Why-mode: Alt+Shift+W, then click any text → full decision trace
  // ------------------------------------------------------------------

  let whyMode = false;

  function toggleWhyMode() {
    whyMode = !whyMode;
    document.documentElement.style.cursor = whyMode ? 'crosshair' : '';
    console.log(whyMode
      ? '🦊 Why-mode ON — click any text on the page and Fennec will explain its decision in this console. (Click is intercepted; nothing will activate.)'
      : '🦊 Why-mode off.');
  }

  document.addEventListener('click', (e) => {
    if (!whyMode) return;
    e.preventDefault();
    e.stopPropagation();
    whyMode = false;
    document.documentElement.style.cursor = '';
    diagnoseElement(e.target);
  }, true);

  /**
   * Explain Fennec's decision for an element: finds the nearest text-bearing
   * element (click targets are often inner spans/icons) and runs the full
   * check pipeline in dry-run mode, printing every step and skip reason.
   * Console: fennecWhy($0) after selecting an element in the inspector.
   */
  function diagnoseElement(target) {
    let el = target;
    while (el && el.nodeType === Node.ELEMENT_NODE && !hasDirectText(el)) {
      el = el.parentElement;
    }
    if (!el || el.nodeType !== Node.ELEMENT_NODE) {
      console.log('🦊 No text-bearing element found there. Try clicking directly on text.');
      return;
    }
    const snippet = (el.textContent || '').trim().slice(0, 50);
    console.group(`🦊 Fennec diagnosis — <${el.tagName.toLowerCase()}> “${snippet}”`);
    if (el.hasAttribute(FIXED_ATTR)) {
      console.log('This element WAS fixed by Fennec:', el.getAttribute(FIXED_ATTR));
    }
    const trace = [];
    try { checkAndFix(el, trace); } catch (err) { trace.push('ERROR during check: ' + err.message); }
    trace.forEach(line => console.log('•', line));
    console.groupEnd();
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------

  function boot() {
    buildBadge();
    if (enabled) {
      scan(document.body);
      startObserver();
    }
    console.log('🦊 Fennec Contrast v0.1.7 loaded (Alt+Shift+W = why-mode) —', enabled ? 'active' : 'paused', '(Alt+Shift+C to toggle)');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
