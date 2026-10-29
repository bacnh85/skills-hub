---
version: alpha
name: Skills Portal
description: A card catalog for agent skills — a ruled ledger, not a SaaS dashboard.
colors:
  paper: "#F5F2EC"
  surface: "#FCFAF6"
  ink: "#1F2B26"
  ink-soft: "#5A6660"
  rule: "#D9D3C7"
  forest: "#1E6B50"
  forest-soft: "#E4EEE8"
  amber: "#8A5B12"
  amber-soft: "#F5EBD8"
  rust: "#8A3423"
  rust-soft: "#F6E5E1"
  inverse: "#1B2521"
  inverse-ink: "#EDEAE3"
typography:
  display:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontWeight: 600
    letterSpacing: "-0.015em"
  body:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontWeight: 400
  mono:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
rounded:
  sm: 3px
  md: 6px
spacing:
  unit: 8px
components:
  card:
    background: "{colors.surface}"
    border: "1px solid {colors.rule}"
    radius: "{rounded.md}"
---

# Skills Portal — Design System

## Direction

**Concept:** a library card catalog / ruled ledger for agent skills. Not a SaaS
dashboard. The page should feel like an index of records: ruled rows, mono
numerals, visible structure, no decoration.

**Mood:** ruled · exact · quiet. Paper stock, ink, one forest accent.

**Signature element:** the oversized index numeral (`01`, `02`, …) set in IBM
Plex Mono at reduced contrast beside each ledger row — the catalog's own
numbering system, doing real work (row index), not ornament.

## Colors

| Token | Hex | Use |
|---|---|---|
| paper | `#F5F2EC` | page background — warm desk, never white |
| surface | `#FCFAF6` | cards, panels |
| ink | `#1F2B26` | body text (green-black, not pure black) |
| ink-soft | `#5A6660` | metadata, labels |
| rule | `#D9D3C7` | hairlines between rows |
| forest | `#1E6B50` | the single accent: primary actions, "published" |
| amber | `#8A5B12` | pending / needs-review status |
| rust | `#8A3423` | errors, security flags, revoked |
| inverse | `#1B2521` | the one dark band (header) |
| inverse-ink | `#EDEAE3` | text on inverse |

Support colors encode meaning only (status). They are never decorative.

## Typography

IBM Plex Sans (600 display / 400 body) + IBM Plex Mono for all identifiers,
semver strings, counts and hashes. Numbers get `font-variant-numeric: tabular-nums`
so columns align — the ledger property that makes the tables read as records.

Scale (1.25): 0.8125 / 1 / 1.25 / 1.5625 / 1.953 / 2.44rem.

## Layout

8px grid via `--sp-1..8`. Rows are a fixed column grid (name · category ·
version · status · actions) at identical x-positions across every row; hairline
separators; metadata never wraps to a second line.

## Elevation

Two levels only: `--el-sm` (cards, inset panels) and `--el-md` (the one modal /
drawer). No shadow as texture.

## Shapes

Radius 3px (inputs, badges) and 6px (cards). Nothing rounder — this is a ledger.

## Components & states

Every control ships default / hover / focus-visible / active / disabled.
Status pills: published (forest-soft), pending (amber-soft), draft (rule),
deprecated (rust-soft). Motion: one page-load reveal, gated behind
`prefers-reduced-motion: no-preference`.

## Do's & Don'ts

- Do let whitespace and rules separate content; a border is the last resort.
- Do put real content in every state (no "Lorem", no "Acme").
- Don't add gradients, glass, glow, or a third shadow level.
- Don't use pure white or pure black anywhere.
