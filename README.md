# 🦊 Fennec Contrast

**Fixes low-contrast text while you browse. One thing, done honestly.**

Low-contrast text is the single most common accessibility failure on the web — it affects roughly 8 in 10 of the world's top million websites, year after year. If you've ever squinted at pale gray text on a white background, you've met the problem.

Fennec Contrast is a free, open-source userscript that fixes it as you browse. It measures every piece of text against the WCAG contrast standard (4.5:1 for normal text, 3:1 for large text) and, when text fails, adjusts the color just enough to make it readable — and no further. A pale brand blue becomes a darker blue, not black. Sites keep their look; you get to read them.

Part of [Project Fennec](https://projectfennec.org) — web without barriers.

---

## Install (two clicks)

1. **Install a userscript manager** (one-time setup):
   - [Violentmonkey](https://violentmonkey.github.io/) — open source, recommended
   - [Tampermonkey](https://www.tampermonkey.net/) — Chrome, Edge, Firefox, Safari

2. **[Click here to install Fennec Contrast](../../raw/main/fennec-contrast.user.js)** — your userscript manager will open an install screen. Click *Install*. Done.

A small 🦊 badge appears in the bottom-right corner of every page, showing how many text elements were adjusted.

**Verify it works:** open the [live test page](https://Mrdali1362.github.io/fennec-contrast/fennec-test-page.html) — the badge should show **7**, and the page explains what each section should (and shouldn't) do.

## Controls

| Action | How |
|---|---|
| Pause + undo everything | Click the 🦊 badge |
| Resume | Click the badge again |
| Keyboard toggle | `Alt+Shift+C` |

Your on/off choice is remembered across pages and sessions. Undo is exact — every element returns to its precise original state.

## Design principles

These come from the accessibility community's experience with tools that got this wrong — especially the failed "overlay" products that websites impose on visitors:

- **You control it.** You install it, you toggle it, you can undo everything with one click. No website decides this for you.
- **Honest about uncertainty.** If Fennec can't determine the real background behind text — images, gradients, heavy transparency — it **leaves the text alone**. A wrong fix is worse than no fix. This is enforced in code, not just promised.
- **Minimal change.** Fixes are computed by binary search for the *smallest* color adjustment that reaches the WCAG threshold. Design intent is respected; hues are preserved.
- **Private. Actually private.** No network calls, no accounts, no analytics, no telemetry. Nothing leaves your browser. The entire script is one readable file — audit it yourself.
- **Deliberately small.** Contrast only. Doing one thing verifiably well beats doing ten things approximately.

## What it does technically

- Computes WCAG 2.x relative luminance and contrast ratios for visible text
- Resolves the *effective* background by walking ancestors and alpha-compositing semi-transparent layers (including semi-transparent text itself)
- Applies spec-correct thresholds: 4.5:1, or 3:1 for large text (≥24px, or ≥18.66px bold)
- Watches for dynamically added content (SPAs) via a debounced MutationObserver
- Processes in small idle-time slices so it never makes pages feel slow

## Known limitations (v0.1)

Stated plainly, because trust is the whole product:

- **Text over images/gradients is skipped** — by design, until we can be *right* about it rather than fast
- No Shadow DOM traversal yet
- No iframes yet (`@noframes`)
- Text with strokes or heavy shadows is left alone (its contrast can't be modeled reliably)
- Contrast is the only thing this fixes — reading order, alt text, labels, and everything else are out of scope here

## Reporting problems

This is an early version. **"It broke on my favorite site" is exactly the feedback we need.** Please [open an issue](../../issues) with:

1. The page URL (or a description if it's private)
2. What happened vs. what you expected
3. Browser + userscript manager

If a fix ever makes something *worse*, that's a priority bug — the honesty rule failed, and we want to know immediately.

## Contributing

Issues, testing reports, and pull requests welcome. The one rule: changes must respect the design principles above — especially *honest about uncertainty*. Features that guess will not be merged.

## License

[MIT](LICENSE) — free to use, modify, and share.

---

*Fennec Contrast is an assistive tool, not a compliance product. It helps you read the web; it does not make websites WCAG-compliant, and site owners should never rely on visitors' tools as a substitute for building accessible sites. The goal is a web where this script is unnecessary.*
