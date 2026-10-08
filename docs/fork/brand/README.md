# lobi — logo guidelines

## 1. The logo

**Idea:** a tile split into two mirrored halves, held together by one core. Many worktrees, one shared index.

The ember core appears twice: as the centre of the symbol, and as the dot of the `i` in the wordmark. The wordmark is drawn as paths on the same geometry, not typed in a font.

| Version | Light background | Dark background |
|---|---|---|
| Horizontal (primary) | `lobi-horizontal.svg` | `lobi-horizontal-reversed.svg` |
| Stacked | `lobi-stacked.svg` | `lobi-stacked-reversed.svg` |
| Symbol | `lobi-symbol.svg` | `lobi-symbol-reversed.svg` |
| Symbol, 32 px and below | `lobi-symbol-small.svg` | `lobi-symbol-small-reversed.svg` |
| Wordmark | `lobi-wordmark.svg` | `lobi-wordmark-reversed.svg` |
| One colour | `one-colour/*-black.svg` | `one-colour/*-white.svg` |

Other files:

- `lobi-app-icon.svg` and `lobi-app-icon-maskable.svg`: square app icons on ink.
- `web/`: `favicon.ico`, `favicon.svg`, PNG icons, `site.webmanifest` and `head-snippet.html`.
- `lobi-social-preview.png`: the 1280 × 640 GitHub social preview image.

The reversed versions are not plain colour swaps. White on dark looks heavier, so their gaps are 2 units wider.

## 2. Construction

The symbol sits on a 256-unit grid and uses one negative width, N:

- **Tile:** 192 units square, with smooth (continuous-curvature) corners.
- **Gap:** N, splitting the tile into two halves.
- **Clearance ring:** N, between the core and the halves.
- **Sizes:** N = 16 in the master, 32 in the small cut, 18 in the reversed version.

## 3. Clear space

Keep a clear zone of **1 × the core's diameter** on every side of the logo. The zone scales with the logo.

## 4. Minimum size

| Version | Screen |
|---|---|
| Horizontal | 96 px wide |
| Stacked | 64 px wide |
| Symbol | 16 px, using the small cut at 32 px and below |

## 5. Colour

| Name | HEX | RGB | CMYK (approx.) | Pantone (nearest) |
|---|---|---|---|---|
| Ember | `#FF5A36` | 255 90 54 | 0 65 79 0 | 171 C |
| Ink | `#16181D` | 22 24 29 | 70 60 50 90 (rich black) | Black 6 C |
| Paper | `#FFFFFF` | 255 255 255 | 0 0 0 0 | — |

Check CMYK and Pantone against a printed swatch before you print.

Contrast (WCAG ratio):

- Ember on white: 3.1 : 1. This is enough for a graphic, but too low for small text.
- Ember on GitHub dark (`#0D1117`): 6.1 : 1.
- Ember on Ink: 5.7 : 1.

Approved logo and background pairs:

- Full colour on white or light grey.
- Reversed on Ink or GitHub dark.
- One-colour black on white.
- One-colour white on Ember.

## 6. In a README (light and dark themes)

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/fork/brand/lobi-horizontal-reversed.svg">
  <img alt="lobi" src="docs/fork/brand/lobi-horizontal.svg" width="320">
</picture>
```

## 7. Don'ts

- Don't stretch, rotate, or recolour the logo outside the palette.
- Don't add shadows, outlines, or gradients.
- Don't put the Ink symbol on a dark background. It disappears; use the reversed version.
- Don't move or resize the parts of a lockup.
- Don't retype the wordmark in a font.
- Don't use the master symbol below 32 px. Use the small cut instead.

## 8. Notes

This identity is for the lobi-GitNexus fork only. It is not the logo of upstream GitNexus. Before any commercial use, get a professional trademark search. No font is used: every letter is a path.
