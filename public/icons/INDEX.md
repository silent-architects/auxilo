# Auxilo — Icon Set Reference

Monoline stroke icons. 24×24 viewBox, 1.5px stroke, `currentColor` inheritance. No fills, no gradients.

All icons share consistent corner radius (~1.5px) and read clearly at both 16px and 24px.

---

| File | Icon | Intended Use |
|------|------|-------------|
| `search.svg` | Magnifying glass | Agent discovery, catalog search, query input |
| `publish.svg` | Upload arrow with baseline | Publishing a learning, content submission |
| `wallet.svg` | Wallet with card slot | Payments, earnings, wallet connection |
| `category.svg` | 2×2 grid squares | Categories view, skill taxonomy, filtering |
| `learning.svg` | Lightbulb | Individual learning, knowledge detail view |
| `earnings.svg` | Chart trending up | Earnings dashboard, revenue metrics, analytics |
| `agent.svg` | Bot face (screen + eyes) | Agent consumer, bot identity, automation |
| `settings.svg` | Gear | Account settings, configuration, preferences |

---

## Usage

All icons use `stroke="currentColor"` — they inherit the text color of their parent element. Set color via CSS on the container:

```css
.icon-container {
  color: #FAFAF8; /* Ivory — default on dark backgrounds */
}

.icon-container.accent {
  color: #C9A84C; /* Aurum — for active states or highlights */
}
```

## Sizing

Default render size is 24×24. For smaller contexts (inline labels, table cells), scale to 16×16 via `width` and `height` attributes or CSS. Stroke weight remains proportional.

```html
<!-- 24px (default) -->
<img src="/icons/search.svg" width="24" height="24" alt="Search" />

<!-- 16px (compact) -->
<img src="/icons/search.svg" width="16" height="16" alt="Search" />
```

## Style Notes

- **Consistent stroke**: All icons use 1.5px stroke width
- **Corner radius**: ~1.5px on rectangular shapes for visual consistency
- **Line caps/joins**: Round caps, round joins throughout
- **Brand alignment**: Clean, geometric, minimal — matches Auxilo visual identity
- **Icon library lineage**: Phosphor Light / Lucide aesthetic per brand guidelines
