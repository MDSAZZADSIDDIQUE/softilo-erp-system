# Softilo logo pack

The Softilo logo is the **interlocking S**, two identical pieces turned around an orange signal square, beside the **softilo** wordmark, where the same square is the dot on the i.

## What's in each folder

| Folder | Version | Use it for |
|---|---|---|
| `01-primary-logo` | S + wordmark, side by side | The default. Website headers, documents, email signatures, invoices |
| `02-logo-with-tagline` | Primary logo with "Innovation • Leadership • Outcomes" | Letterheads, proposals, slides, banners, where there's room |
| `03-stacked-logo` | S above the wordmark | Square or narrow spaces: posters, merchandise, signage |
| `04-symbol` | The S on its own | Small spaces, watermarks, stamps, social avatars |
| `05-wordmark` | "softilo" on its own | When the S already appears nearby |
| `06-app-icon` | The S on a rounded tile (ink, orange, paper) | App icons and launchers. The `-square` files are full-bleed, for stores that round the corners themselves |
| `07-favicon` | Website icon set | `favicon.ico`, `favicon.svg`, `apple-touch-icon.png`, Android/PWA icons and a `site.webmanifest` |
| `08-social` | Profile pictures (1080 × 1080) and LinkedIn banners (1584 × 396) | LinkedIn, Fiverr, Facebook, X and other profiles |

## Colourways (folders 01–05)

| File suffix | Looks like | Use on |
|---|---|---|
| `full-colour` | Ink logo, orange square | White, cream or other light backgrounds |
| `reversed` | Cream logo, orange square | Dark backgrounds and photos |
| `black` | All black | One-colour printing, stamps, fax, engraving |
| `white` | All white | One-colour on dark: embossing, laser etching, dark merchandise |

## Which file format

| Format | When |
|---|---|
| **SVG** | Websites and design tools (Figma, Illustrator, Canva). Vector: sharp at any size |
| **PDF** | Printers and print design. Vector, transparent background, set at a real size in mm |
| **PNG** | Documents, slides, social media and anywhere SVG isn't accepted. Transparent, 1024 to 4096 px wide |
| **JPG** | Places that don't support transparency. Full colour on cream, reversed on ink |

For anything bigger than 4096 px (a billboard, a large banner) use the SVG or PDF, which scale without limit.

## Colours

| Name | HEX | RGB | Role |
|---|---|---|---|
| Ink | `#191712` | 25, 23, 18 | The logo, text |
| Paper | `#F2EEE5` | 242, 238, 229 | Backgrounds, reversed logo |
| Signal orange | `#D8431F` | 216, 67, 31 | The square, the only accent |

For print, ask the printer to match these HEX values. Approximate CMYK: Ink 0/8/28/90, Signal orange 0/69/86/15.

## Using the logo well

- **Clear space:** keep empty space around the logo at least as big as the orange square on the "i" (or, for the symbol on its own, the S's centre square). The files already include it.
- **Minimum size:** primary logo 96 px wide on screen or 25 mm in print. Symbol 16 px or 6 mm.
- **Don't:** stretch or squash it, rotate it, recolour the S or the square, add shadows or outlines, rearrange the S and wordmark, or put the full-colour logo on a busy or dark background (use `reversed`).

## Regenerating

These files are generated from the website's logo geometry (`src/lib/brand.ts`). If the logo changes, rebuild them from the repo root with:

```
python scripts/brand/export-logo-pack.py
```
