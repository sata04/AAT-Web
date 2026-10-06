---
name: aat-web-e2e-testing
description: How to E2E-test AAT-Web (analyzer) in a real browser — dev server, real OS-level file drags from Finder (macOS) or CDP/console fallbacks (Linux), Pyodide poster rendering, offline/cloud-disabled builds, and known pitfalls.
---

# AAT-Web E2E testing on macOS

## Dev server
- `pnpm dev` at repo root → Vite serves `apps/web` at http://localhost:5173.
- Local-first: no login needed. The cloud lanes intentionally show ローカルのみ / offline, and the console logs two `404 /api/v1/me` probes — expected when no Worker backend runs, not a bug.
- pnpm deps are usually preinstalled; `pnpm install` if not.

## Real file drags (Finder → browser)
The app has two drop paths: the empty-state FileDropZone, and the graph-area overlay
(`.graph-area__drop-hint`, text "CSVファイルをドロップして追加") once a dataset is open.
Test with real OS drags:
1. `open -R /abs/path/to/file.csv` — reveals AND selects the file in Finder, scrolling it into view. Far more reliable than scrolling to it.
2. Prefer Finder **icon view** (`osascript -e 'tell app "Finder" to set current view of front window to icon view'`). List view can leave the Name column scrolled off-screen, breaking drags.
3. Drag = `left_mouse_down` dead-center on the icon/label → several `mouse_move` steps → `screenshot` mid-drag (button still held) → `left_mouse_up` over the target. Pressing between icons starts a marquee selection instead of a file drag — retry dead-center.
4. Keep enough Chrome visible beside/below the Finder window to drop into the graph area.

File-picker fallback: click ファイルを開く → `Cmd+Shift+G` → type absolute path → Return → Open. Input has `multiple`.

## Keyboard navigation / skip link
- macOS default has Tab skipping links/buttons in Chrome. The skip link (グラフへ移動 → `#aat-graph`) is only reachable after enabling Full Keyboard Access:
  `defaults write NSGlobalDomain AppleKeyboardUIMode -int 3` (Chrome picks it up live; revert with `defaults delete NSGlobalDomain AppleKeyboardUIMode`).
- After clicking inside the page, Tab continues from the click's DOM position — the skip link sits BEFORE the toolbar, so test it right after a fresh load (`Cmd+R`, then Tab once) or Shift+Tab backwards.

## Held-modifier gestures (Shift+drag pan)
The computer tool's `key` modifier does NOT hold across a multi-action drag — a Shift+drag becomes a plain selection drag. Workaround that produced a real pan:
```
osascript -e 'tell application "System Events" to key down shift'
# ... computer-tool mouse drag ...
osascript -e 'tell application "System Events" to key up shift'
```
Caveats: while Shift is held, the mouse wheel becomes horizontal scroll (so release before wheel-zoom tests). Pan is a no-op at full data bounds — wheel-zoom in first, then Shift+drag shifts the x-range. Pan gestures live on uPlot's `.u-over`; selection drags too (post-change: SelectionOverlay binds `gestureLayer`, not its own div).

## Analysis timing
Analysis is fast — even a 200k-row CSV finishes in ~1s, so the new progress bar + 中止 (cancel) button is only visible for a blink. A screenshot right after drop may catch it; clicking cancel reliably isn't feasible by hand with stock fixtures.

## Exports
- Excelで書き出す / CSVで書き出す / PNGを保存 download to `~/Downloads` (verify with `ls -lt`). Chrome's download bubble opens top-right and OVERLAPS the export buttons — close it before clicking PNGを保存 or you re-open the previous file and get a macOS "no application set to open" dialog (OS-level, not an app bug — dismiss with Cancel).
- The PNG export posts a parity warning notice; notices stack at the top of the graph area, each dismissible via 閉じる.

## Console check
`browser_console` and `read_dom` tools may falsely report "Chrome is not in the foreground". Visual fallback: `Cmd+Opt+J` opens DevTools console — screenshot it. Note that docking DevTools shrinks the page viewport, moving every element — recompute click coordinates after toggling it.

## When a click "does nothing"
Before calling it an app bug, verify the hit target:
1. In DevTools console, get the element's real viewport rect: `el.getBoundingClientRect()`.
2. Check what actually sits there: `document.elementFromPoint(cx, cy)` — it should return the control, not an overlay.
3. A programmatic `el.click()` is NOT a reliable stand-in for a real click: it fires the handler but may not reproduce pointer/focus behavior, and can be misleading when a dialog or layout state differs. Prefer re-attempting a real click at the verified position.
4. Small toolbar/sidebar buttons (e.g. 列を選び直す, ?) are ~26px targets — a few px of drift lands in panel padding. Zoom first, then click dead-center.

## Onboarding state
`localStorage['aat.onboarding.v1']` gates the welcome/hints — clear it via DevTools console for a fresh first-run (`localStorage.removeItem(...)`; DevTools warns once about pasting, typed input is unaffected). Re-showing the welcome from help is broken while datasets are loaded (auto-close effect) — test re-entry on an empty workspace.

## Bad-data fixtures
tests/fixtures/csv contains intentional edge cases: missing_sync_point / non_monotonic_time / non_numeric_mixed all import but stack WARNING notices (fallbacks announced, not errors). Useful for the notice stack; hard errors are hard to trigger from fixtures.

---

# Linux VM notes (Devin sessions)

Verified on the Linux VM while testing the in-browser Pyodide poster engine.

## App button handlers are pointerdown, not click

Analyzer buttons (正式ポスター図を作成, 選択を解除, toolbar actions) run on `pointerdown`/`pointerup` handlers. A synthetic `el.click()` in the console does **not** trigger them. To drive one programmatically (e.g. a small target defeats coordinates), dispatch the full sequence:

```js
for (const t of ['pointerdown','pointerup','click'])
  el.dispatchEvent(t === 'click'
    ? new MouseEvent('click', {bubbles:true})
    : new PointerEvent(t, {bubbles:true}));
```

## Selector traps

- `section[aria-label="ポスター図"] button` selects the real poster-section button. Searching the whole document for the text `正式ポスター図` can match the toolbar **PNGを保存** button — its tooltip/title contains that string.
- Small sidebar buttons (~24px) need exact coordinates; verify with `document.elementFromPoint(x,y)` and mark the target first with `el.style.outline='3px solid lime'` before committing a click.

## DevTools console pitfalls

- **Literal Japanese in typed console code gets mangled** (IME/clipboard) → SyntaxError. Always use `\uXXXX` escapes in selectors/strings (e.g. `'\u4f5c\u6210'` for 作成).
- Page clicks steal DevTools console focus — re-click the console input line before typing.
- `document.title = '...'` is a reliable one-line readout channel when you can't read console return values.

## Relaunched Chrome loses CDP

If Chrome is closed and relaunched without `--remote-debugging-port=9222`, `browser_console`/`read_dom` stop working. Either relaunch with the flag or fall back to DevTools-console typing + `document.title` readouts + screenshots.

## Poster-engine specifics (Pyodide in a worker)

- First render takes ~15–20s cold (Pyodide boot + wheel load); console logs `Loading Pillow, contourpy, …` then `Loaded …`.
- Runtime cache: `/pyodide/` assets land in the **`aat-poster-engine`** Cache Storage bucket after one online render (≈14 entries). Check via `caches.keys()` / `(await (await caches.open('aat-poster-engine')).keys()).length` — expect the entries to be `Request` objects keyed on the full URL.
- Expected benign console noise when signed out: `404 /api/v1/me` probes, and `ERR_FILE_NOT_FOUND` for stale blob: URLs left over from a pre-reload session. Anything mentioning CSP, `wasm-unsafe-eval`, worker creation failure, or "Invalid base URL" is a real failure.
- PNG-save verification: real clicks on the `PNG を保存` link are easy to miss; `document.querySelector('a[download]').click()` works — check `~/Downloads/*_poster.png` (`ls -lt`).

## Offline / service-worker testing

- The **dev server emits no SW** — offline verification needs the production build: `pnpm --filter @aat/web build` then `pnpm --filter @aat/web exec vite preview --port 4173`.
- Stronger than the DevTools offline checkbox: actually **kill the preview server** (`curl` → 000) so every fetch must come from SW precache or runtime cache. Then reload — the app shell comes from precache, `/pyodide/*` from `aat-poster-engine`.

## Cloud-disabled build

`VITE_AAT_CLOUD_ENABLED=false pnpm --filter @aat/web exec vite --port 5174`. Expected: footer loses the クラウド同期 lane, no サインイン text anywhere, and cloud-only routes (`/sign-in` etc.) do not render their screens — observed behavior: they land on the analyzer. The poster engine still works fully (cloud-out only removes cloud modules).

## Devin secrets needed

None — all flows above work signed-out (local-first).
