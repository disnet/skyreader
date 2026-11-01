// The app shell's breakpoint, in one place for both CSS and JS.
//
// Two layouts: the framed desktop shell (navigation rail, toolbar strip, content
// card) and the phone layout (no rail, a bottom bar that slides away on scroll,
// window scrolling). Which one you get is not only a matter of width. A mouse
// driven window between 851px and 1000px — a desktop PWA, a half-screen window,
// a laptop at 150% scaling — has room for the rail and has no use for a bar
// built for thumbs, so it gets the frame. A touch screen keeps the phone layout
// up to 1000px, as it always has.
//
// The two queries are exact complements (a primary pointer is one of fine,
// coarse or none), so every width lands in exactly one layout. They use only the
// Level 3 `pointer` feature, not `not (…)`, so older Safari parses all of it.
//
// CSS writes `@media (--shell-framed)` / `@media (--shell-mobile)`;
// postcss.shell-media.js swaps in the queries below. JS reads the same strings.

/** Widest viewport that always gets the phone layout. */
export const SHELL_NARROW_MAX = 850;

/** Widest viewport that gets the phone layout on a touch (or pointerless) screen. */
export const SHELL_TOUCH_MAX = 1000;

/** The framed desktop shell. */
export const SHELL_FRAMED_QUERY = `(min-width: ${SHELL_TOUCH_MAX + 1}px), (min-width: ${SHELL_NARROW_MAX + 1}px) and (pointer: fine)`;

/** The phone layout: the complement of SHELL_FRAMED_QUERY. */
export const SHELL_MOBILE_QUERY = `(max-width: ${SHELL_NARROW_MAX}px), (max-width: ${SHELL_TOUCH_MAX}px) and (pointer: coarse), (max-width: ${SHELL_TOUCH_MAX}px) and (pointer: none)`;
