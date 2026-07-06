# STARFRAG art manifest

Real art for the arena, generated with the **sprite-forge** pipeline
(`/home/claudebot/repos/sprite-forge`) and wired into the raycaster in
`client/js/game.js`. Every asset here is regenerable from the prompt + provider
below. Providers follow the measured model-routing table in sprite-forge/README.md
(Scenario flux for textures/style, gpt-image-2 for POV composition + magenta sprites).
**Gemini image models are never used** (standing owner rule).

Sprites are authored on solid `#FF00FF` and chroma-keyed **in the browser at load**
with the forge keyer (so the committed PNGs stay raw/regenerable):

    m = min(r,b) - g;  m > 52 -> transparent;  18 < m <= 52 -> despill r,b -= (m-18)*0.8

## Assets

| file | provider / model | size | used for | wiring |
|---|---|---|---|---|
| `art/wall_hull.png`  | Scenario flux (flux.1-dev) | 256² | `TEX.HULL`, `TEX.PILLAR` | wall column sampler |
| `art/wall_tech.png`  | Scenario flux (flux.1-dev) | 256² | `TEX.TECH` (conduit pillars) | wall column sampler |
| `art/wall_panel.png` | Scenario flux (flux.1-dev) | 256² | `TEX.PANEL` (cover) | wall column sampler |
| `art/floor_deck.png` | Scenario flux (flux.1-dev) | 256² | floor plane | floor caster sampler |
| `art/carbine.png`    | gpt-image-2 | 800×533 | POV pulse-carbine viewmodel | `drawGun()` (bob/kick/dip) |
| `art/trooper.png`    | gpt-image-2 | 400×600 | enemy billboard — **front (S)** of the 8-way set | sprite blitter (`Net.players`) |
| `art/trooper_{se,e,ne,n,nw,w,sw}.png` | gpt-image-2 **images/edits** (img2img from `trooper.png`) | 400×600 | 7 other yaw views of the SAME trooper | 8-way directional pick (`pickTrooper`) |
| `art/scatter/hero.png` | gpt-image-2 | 512² | RIOT SCATTERGUN POV idle viewmodel | `drawGun()` (`WEAPON_ART.scatter`) |
| `art/scatter/reload/f0..7.png` | **video→frames** (kling img2vid → gpt-image-2 repair) | 512² | scattergun pump-action RELOAD animation | `drawGun()` reload-frame cycle |
| `art/scatter/fire/f0..4.png` | **video→frames** | 512² | scattergun FIRE animation (flash + shell eject) | `drawGun()` fire-frame cycle |
| `art/plasma/hero.png` | gpt-image-2 | 512² | PLASMA REPEATER POV idle viewmodel | `drawGun()` (`WEAPON_ART.plasma`) |
| `art/plasma/reload/f0..7.png` | **video→frames** | 512² | plasma energy-cell RELOAD animation (+ recharge arc) | `drawGun()` reload-frame cycle |

`TEX.REACTOR` stays procedural (pulsing orange emissive) and `TEX.VIEWPORT` stays the
raycast starfield/planet — both intentionally not textured. The muzzle flash is a
separate additive code overlay drawn at the carbine barrel tip on fire (never baked in).

## Prompts

- **wall_hull** — "Seamless tileable square texture of a dark grimy sci-fi spaceship
  bulkhead wall. Weathered scuffed metal plating with heavy horizontal panel seams,
  rows of rivets and bolts, rust streaks, grime, dents… Flat orthographic head-on view,
  evenly lit, no perspective, no text logos. High detail game PBR albedo texture."
- **wall_tech** — "…dark sci-fi spaceship engineering wall covered in pipes, conduits,
  cables and ducts, valve wheels, pressure gauges, junction boxes, hazard stripes.
  Muted teal-gray with amber accents. Flat orthographic head-on view…"
- **wall_panel** — "…flat texture of a sci-fi interior wall panel, viewed perfectly
  straight-on with zero perspective, like a flat material swatch. Dark-gray brushed
  metal panels, recessed seams, one thin glowing cyan light strip. No door, no scene…"
- **floor_deck** — "…top-down flat texture of a sci-fi metal deck floor… riveted steel
  deck plates in a grid with recessed seams, tread pattern, scuffs, a faint hazard
  stripe. Dark steel gray. Uniform even flat lighting, no perspective…"
- **carbine** — "First-person weapon viewmodel, POV of a chunky heavy sci-fi pulse
  carbine gripped in two dark armored hands entering from the very bottom edge. Barrel
  strongly foreshortened, pointing away into the screen toward the center crosshair.
  Dark gunmetal with a glowing cyan energy cell… Solid flat pure magenta #FF00FF
  background, no environment, no muzzle flash." (aspect 3:2)
- **trooper** — "Full-body sci-fi enemy soldier sprite, viewed straight from the front,
  facing camera. Heavy armored space marine in dark tactical armor, full helmet with a
  glowing red-orange visor, rifle across the chest. Whole body in frame, feet at bottom.
  Solid flat pure magenta #FF00FF background, no ground, no shadow." (aspect 2:3)
- **trooper_{se..sw}** (8-way turnaround) — derived from `trooper.png` (the front/S
  view) with **gpt-image-2 `images/edits`** (img2img holds identity best across angles;
  see sprite-forge LEARNINGS): each call re-states the identity anchors (dark gunmetal
  armor, red-visor helmet, '09' pauldron, skull knee decal, pulse carbine) and asks for
  one rotated view (front-3/4, side profile, rear-3/4, direct rear). Generated 1024×1536,
  flattened onto magenta, downscaled to 400×600. Tool: `generators/gen-edit.mjs`.

## Weapon animations — the VIDEO→FRAMES pipeline

The scattergun + plasma fire/reload viewmodels are **video-derived** (sprite-forge
`forge/animate.md`): a gpt-image-2 POV **hero** frame is the start image for a
**kling-v2-1 img2vid** (`scenario-custom.mjs`) driven by a motion prompt + the
counter-prompt kit (locked camera, no VFX, first=last loop); `ffmpeg -vf fps=8`
extracts frames; 5–8 are picked; each is **repaired** with gpt-image-2 `images/edits`
(`[frame, hero]`, "match the reference, solid pure-magenta bg, crisp edges") to
restore full chroma margin; the repaired frames are downscaled to 512² and committed.
`drawGun()` cycles them: reload frames win over fire frames, and the video motion
carries the animation (procedural dip suppressed). Muzzle flash stays a separate
tinted overlay. The FULL flow (hero → video → extracted → picked → repaired → in-game)
is receipted in [`../../docs/pipeline/`](../../docs/pipeline/README.md); raw frames +
source .mp4s live on the box in `scratch-art/forge/`.

**Viewmodel sizing rule (drawGun):** every viewmodel is sized so its visible barrel
tip lands on `GUN_TOP_Y ≈ 0.54·SCREEN_H`, keeping the gun in the BOTTOM ~46% of the
fixed 384×240 framebuffer — crosshair + upper view always clear, even on wide-short
mobile-landscape aspects (with `object-fit:contain`).

- **scatter/hero** — "…chunky heavy sci-fi pump-action scattergun… fat cylindrical
  magazine tube under a ribbed pump forestock, wide twin-barrel muzzle foreshortened
  to the crosshair, hazard-orange accents, glowing amber ammo readout… bottom two-
  thirds, solid pure magenta #FF00FF." (1:1)
- **plasma/hero** — "…sleek high-tech sci-fi plasma repeater rifle… glowing acid-green
  plasma coils and vents, translucent green energy chamber, foreshortened to the
  crosshair, neon-green emissive accents… solid pure magenta #FF00FF." (1:1)

## Regenerating

    cd /home/claudebot/repos/sprite-forge/generators
    node scenario-gen.mjs "<wall/floor prompt>" out.png flux.1-dev 1024x1024
    node gen-image.mjs   "<gun/trooper prompt>" out.png 3:2   # or 2:3
    # then downscale (convert -resize) and drop into client/assets/art/

Cloudflare caches `js/*` for 5 days; the HTML is served fresh, so bump the
`?v=` query on the `game.js` script tag in `index.html` after any client change.
