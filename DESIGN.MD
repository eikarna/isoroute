---
version: alpha
name: EdgeRouter
description: A high-density, tactile engineering interface for a serverless AI gateway. Void-zinc canvas with hairline wireframe geometry, monospaced tabular data hierarchy, sub-150ms tactile micro-interactions, and zero AI-slop decoration. Speed beats delight; every element exists to accelerate developer workflows.
colors:
  primary: "#10b981"
  primary-dim: "rgba(16, 185, 129, 0.12)"
  primary-border: "rgba(16, 185, 129, 0.3)"
  canvas: "#09090b"
  surface-panel: "#121215"
  surface-card: "#18181b"
  surface-input: "#0d0d10"
  hairline: "rgba(255, 255, 255, 0.08)"
  hairline-subtle: "rgba(255, 255, 255, 0.04)"
  hairline-highlight: "rgba(255, 255, 255, 0.18)"
  ink: "#fafafa"
  body: "#d4d4d8"
  muted: "#a1a1aa"
  dim: "#71717a"
  status-ok: "#10b981"
  status-ok-dim: "rgba(16, 185, 129, 0.14)"
  status-warn: "#f59e0b"
  status-warn-dim: "rgba(245, 158, 11, 0.14)"
  status-err: "#ef4444"
  status-err-dim: "rgba(239, 68, 68, 0.14)"
typography:
  display:
    fontFamily: "'JetBrains Mono', 'Geist Mono', ui-monospace, monospace"
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.03em
  heading:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.01em
  body-md:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  mono-data:
    fontFamily: "'JetBrains Mono', 'Geist Mono', ui-monospace, monospace"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: -0.01em
  mono-stat:
    fontFamily: "'JetBrains Mono', 'Geist Mono', ui-monospace, monospace"
    fontSize: 22px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: -0.04em
  button:
    fontFamily: "'JetBrains Mono', 'Geist Mono', ui-monospace, monospace"
    fontSize: 11.5px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: 0.02em
rounded:
  none: 0px
  xs: 3px
  sm: 5px
  md: 8px
  lg: 12px
  pill: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  base: 16px
  lg: 24px
  xl: 32px
components:
  card:
    backgroundColor: "{colors.surface-panel}"
    border: "1px solid {colors.hairline}"
    rounded: "{rounded.md}"
    boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.03), 0 1px 2px rgba(0, 0, 0, 0.4)"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#000000"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
  button-secondary:
    backgroundColor: "{colors.surface-card}"
    border: "1px solid {colors.hairline}"
    textColor: "{colors.body}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
  input:
    backgroundColor: "{colors.surface-input}"
    border: "1px solid {colors.hairline}"
    textColor: "{colors.ink}"
    typography: "{typography.mono-data}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
  badge:
    rounded: "{rounded.xs}"
    padding: "2px 6px"
    typography: "{typography.mono-data}"
---

## Overview

EdgeRouter is an AI Gateway control interface designed under the **Tactile Engineering Utility** philosophy. It rejects modern "AI slop" — there are no purple-to-cyan decorative gradients, no oversized bloated cards, no 50px blurry glow filters, and no sluggish 400ms CSS transitions that induce perception lag.

The UI acts as a hardware-like developer instrument (analogous to Raycast, Linear, and Vercel infrastructure panels):
- **Speed Beats Delight:** If an interaction is executed dozens or hundreds of times per day (switching tabs, inspecting cascade routes, inspecting latency), animation is either zero-delay (0ms) or strictly sub-150ms hardware-accelerated transforms.
- **Keyboard & Monospace Priority:** All numerical data (tokens, latency in milliseconds, timestamps, RPM limits) use tabular figures (`font-variant-numeric: tabular-nums`) so values never jitter during streaming updates.
- **Tactile Grounding:** Depth in dark mode is communicated via subtle surface lightness gradation (`#09090b` canvas to `#121215` panel) paired with an inner 1px highlight (`inset 0 1px 0 rgba(255,255,255,0.03)`), eliminating floaty disconnects.

---

## Colors

### Brand & Accent
- **Emerald Primary** (`{colors.primary}` — `#10b981`): The utilitarian accent indicating operational vitality. Used strictly for active status indicators, copy confirmations, and the primary execution CTA.
- **Emerald Dim** (`{colors.primary-dim}` — `rgba(16, 185, 129, 0.12)`): Low-contrast background tint for healthy badges and active navigation pills.

### Surface Tiers (Dark Mode Depth Hierarchy)
- **Canvas** (`{colors.canvas}` — `#09090b`): The root viewport background. Void-zinc with zero color saturation to prevent eye fatigue.
- **Surface Panel** (`{colors.surface-panel}` — `#121215`): Container surface for bento sections, table wrappers, and form boxes.
- **Surface Card** (`{colors.surface-card}` — `#18181b`): Elevated element surface for secondary buttons, list items, and modal layers.
- **Surface Input** (`{colors.surface-input}` — `#0d0d10`): Inset recessed floor for textareas and inputs, communicating depth below the panel surface.

### Wireframe Hairlines
- **Hairline** (`{colors.hairline}` — `rgba(255, 255, 255, 0.08)`): Crisp 1px boundary separating panels and table rows.
- **Hairline Highlight** (`{colors.hairline-highlight}` — `rgba(255, 255, 255, 0.18)`): Used on hover states and active focus rings.

### Semantic Status
- **Status OK** (`{colors.status-ok}` — `#10b981`): HTTP 200 responses, verified OAuth tokens.
- **Status Warn** (`{colors.status-warn}` — `#f59e0b`): Circuit-breaker rate limits (HTTP 429), token expiration warnings.
- **Status Error** (`{colors.status-err}` — `#ef4444`): HTTP 500/502/503/504 errors, network timeouts.

---

## Typography

### Hierarchy
- **`display`** (20px / weight 600 / JetBrains Mono / tracking -0.03em): Used exclusively for the navbar title.
- **`mono-stat`** (22px / weight 600 / JetBrains Mono / tracking -0.04em): Metric value counters.
- **`heading`** (14px / weight 600 / System Sans / tracking -0.01em): Section titles.
- **`mono-data`** (12px / weight 500 / JetBrains Mono): Code snippets, route IDs, model slugs, table cell data.
- **`body-md`** (13px / weight 400 / System Sans): Descriptive guidelines and helper text.
- **`button`** (11.5px / weight 600 / JetBrains Mono): Action trigger labels.

### Principles
- **No Weight Shifting:** Font weight never changes on hover or selection states to eliminate visual reflow.
- **Tabular Numerics:** All monospace blocks enforce `font-variant-numeric: tabular-nums` to ensure exact column alignment across fluctuating token totals.

---

## Layout & Spatial Geometry

- **4-Point Grid Rule:** Every padding, margin, gap, and height value must be an integer multiple of 4px (`4`, `8`, `12`, `16`, `24`, `32`).
- **Button Proportions:** Button horizontal padding is strictly `2x` the vertical padding (`padding: 8px 16px` for primary, `6px 12px` for compact).
- **Nested Radius Formula:** Inner radius equals outer radius minus container gap (`R_inner = R_outer - gap`).

---

## Motion & Interaction (Emil Kowalski Laws)

- **UI Duration Floor:** All interactive transitions must complete in `<150ms`.
- **Zero-Animation for High-Frequency Actions:** Keyboard navigation (`ArrowUp`/`ArrowDown`), row selection, and tab switches use instant visual swaps (0ms).
- **Physical Feedback:**
  - Button `:active` state triggers a subtle scale transform: `transform: scale(0.98)` or `translateY(1px)`.
  - Focus rings use dual-layer box-shadow (`box-shadow: 0 0 0 1px #10b981, 0 0 0 3px rgba(16, 185, 129, 0.2)`), never raw browser outline.
- **Hardware Acceleration:** All animated properties are restricted exclusively to `transform` and `opacity`. Width, height, margin, and top/left are never animated.

---

## Components

**`card`** — Standard content plate. Built with `{colors.surface-panel}`, a 1px `{colors.hairline}` border, and an inner 1px highlight `inset 0 1px 0 rgba(255,255,255,0.03)` to anchor depth.

**`button-primary`** — Primary trigger CTA. High contrast solid `{colors.primary}` with black ink. Depresses `1px` on `:active`.

**`button-secondary`** — Elevated neutral button `{colors.surface-card}` with `{colors.hairline}` border. Hovers to `{colors.hairline-highlight}` without layout shift.

**`input`** — Recessed text entry field. Background `{colors.surface-input}` with mono typeface. Glows with `{colors.primary-border}` on `:focus`.

**`badge`** — Compact metadata capsule for HTTP status codes, priority ranks, and provider types. Uses saturated color pairing with translucent tint (`rgba(...)`).

---

## Responsive Behavior

| Viewport | Breakpoint | Adaptation Strategy |
|---|---|---|
| Desktop | > 1024px | Full 2-column bento grid; dual list + form layout. |
| Tablet | 768px – 1024px | Metric strip scales 2x2; forms stack below lists. |
| Mobile | < 768px | Single column flow; horizontal scrollable navigation bar; padding drops to 12px. |

### Touch Targets
- All buttons and interactive inputs enforce a minimum touch bounding box of `40px` (or `44px` on mobile screens).

---

## Known Gaps

- Dark mode is the canonical and exclusive theme (light mode is intentionally omitted for developer eye comfort).
- Complex multi-level drag-and-drop animations are omitted in favor of explicit priority numbers (`priority: 10`) for determinism.
