# RAILGUN viewmodel — sprite-forge VIDEO→FRAMES art drop

POV viewmodel + animations for the STARFRAG **RAILGUN**, produced with the
sprite-forge VIDEO→FRAMES pipeline (gpt-image-2 hero → kling-v2-1 img2vid →
ffmpeg extract → gpt-image-2 repair). **Same format as `../scatter/`**: every
frame is an uncropped **512×512 RGB** image authored on solid `#FF00FF` magenta —
NOT pre-keyed. The client keys them in-browser at load (`loadFrame` in
`client/js/game.js`) with the exact forge keyer:

    m = min(r,b) - g;  m > 52 -> transparent;  18 < m <= 52 -> despill r,b -= (m-18)*0.8

Drop-in for the existing `drawGun()` animation system. Prompts are tinyclaw's
verbatim per-state prompts in `docs/railgun-art-prompts.md`.

## Frames

| state | dir | frames | notes |
|---|---|---|---|
| HERO (idle) | `hero.png` | 1 | canonical POV idle viewmodel; identity anchor for every anim |
| **CHARGE** | `charge/f0..f7.png` | **8** | **index 0→1 by charge progress** — f0 = fully idle/dark, f7 = fully charged. NOT a loop: sample by charge %, like reload-by-progress. Muzzle glow + coil/power-cell lighting + electric arcs ramp up. No beam leaves the barrel. |
| FIRE | `fire/f0..f4.png` | 5 | discharge: recoil back + settle to idle (first=last idle). muzzle flash is a SEPARATE additive overlay in game.js — NOT baked in. |
| RELOAD | `reload/f0..f7.png` | 8 | rack breech → eject spent slug → thumb fresh → slam shut; perfect loop (first=last idle). |

## Wiring hints for tinyclaw (art matches these; code is yours)

- `WEAPON_ART.railgun = { hero:null, charge:[], fire:[], reload:[], meta:{ topFrac: 0.20 } }`
  then `loadWeaponArt('railgun', { charge: 8, reload: 8, fire: 5 })`.
- **topFrac ≈ 0.20** — measured barrel-tip row = 102/512 = 0.199. (scatter is 0.24,
  plasma 0.15; the railgun barrel tip sits a touch higher.)
- CHARGE is the new state scatter/plasma don't have. Suggested pick in `drawGun`:
  while charging, `frame = art.charge[min(len-1, (chargePct * len) | 0)]` — same
  progress-indexed math the reload strip uses. f0 is identical to `hero.png` (idle).
- Muzzle flash overlay: fire off `vm.flash` at the barrel tip on discharge (same as
  scatter/plasma); the flash is never in the frames.

## Provenance / receipts

Full artifact chain (hero → kling mp4 → 40-frame extract → picked-8 → repair
before/after → in-game keyed) is receipted in `docs/pipeline/railgun-*`. Raw
full-res frames, all repairs, and source .mp4s live on the box in
`scratch-art/forge/railgun/` (gitignored). All prompts used were tinyclaw's
verbatim text from `docs/railgun-art-prompts.md`.
