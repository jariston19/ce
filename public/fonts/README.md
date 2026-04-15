Optional self-hosted fonts

This app now bundles both `SF Pro` and `Inter` locally from `public/fonts/`.

Current font priority in `src/styles.css`:

- `SF Pro Text`
- `SF Pro Display`
- `Inter`
- Apple system fonts
- `Segoe UI Variable`
- `Segoe UI`
- `Roboto`
- `Helvetica Neue`
- `Arial`
- `system-ui`

Bundled font folders:

- `public/fonts/sf/`
- `public/fonts/inter/`

What to do on another PC:

- The app will use bundled `SF Pro` first.
- If any `SF Pro` files are unavailable, it will fall back to bundled `Inter`.
- After that, it will fall back to the system stack.

If you have properly licensed webfont files and want to self-host them:

1. Place your font files in this folder.
2. Add `@font-face` rules in `src/styles.css`.
3. Point the existing `--font-body` and `--font-display` variables to those hosted families first.

Recommended filenames if you later decide to host fonts here:

- `SF-Pro-Text-Regular.woff2`
- `SF-Pro-Text-Medium.woff2`
- `SF-Pro-Display-Regular.woff2`
- `SF-Pro-Display-Semibold.woff2`

Current bundled setup:

- `SF Pro Text` is the default body font.
- `SF Pro Display` is the default display font.
- `Inter` is retained as the bundled fallback backup.
