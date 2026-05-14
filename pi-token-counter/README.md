# pi-token-counter

Live token counter widget for pi. Also hides pi's built-in working indicator, since the token widget replaces that status area.

Shows assistant streaming output with a small spinner, then settles into session token totals:

- input (`i`)
- output (`o`)
- cache read/write combined (`c`)
- total fallback on narrow terminals

The widget is rendered above the editor so it can be used alongside footer extensions without replacing them.
