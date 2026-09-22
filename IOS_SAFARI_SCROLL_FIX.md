# iOS Safari bottom-nav scroll fix

## Before
Logged-in shell used `h-screen` (`100vh`) with a nested `flex-1 overflow-auto` main column and a bottom tab bar as a sibling. On iPhone Safari / in-app browsers, `100vh` is often taller than the *visible* viewport, so the tab bar sat below the fold. Users scrolled only inside the main column and could not reach the bottom menu. Nested lead lists and dialogs could also leave scroll feeling stuck; home indicator had no safe-area padding on the nav.

## After
- Shell uses **`100dvh`** (`.app-shell`) so chrome fits the dynamic visible viewport.
- **One primary scroll** (`.app-shell-main`) with `min-height: 0`, `-webkit-overflow-scrolling: touch`, `overscroll-behavior-y: contain`.
- Bottom nav (`.app-shell-bottom-nav`) stays **outside** that scroll node, with `padding-bottom: max(…, env(safe-area-inset-bottom))`.
- Nested lead lists use `overscroll-contain`; dialogs use `max-h` with `dvh` + safe-area; body overflow unlocks when no dialog/camera is open.
- Desktop layout unchanged in structure (same header / main / tabs).

## Files
- `app/globals.css` — `.app-shell`, `.app-shell-main`, `.app-shell-bottom-nav`
- `app/page.tsx` — shell/nav classes, toast offset, scroll unlock effect
- `components/ui/dialog.tsx` — safe max-height + overscroll
