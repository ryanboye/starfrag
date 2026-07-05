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
| `art/trooper.png`    | gpt-image-2 | 400×600 | enemy billboard | sprite blitter (`Net.players`) |

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

## Regenerating

    cd /home/claudebot/repos/sprite-forge/generators
    node scenario-gen.mjs "<wall/floor prompt>" out.png flux.1-dev 1024x1024
    node gen-image.mjs   "<gun/trooper prompt>" out.png 3:2   # or 2:3
    # then downscale (convert -resize) and drop into client/assets/art/

Cloudflare caches `js/*` for 5 days; the HTML is served fresh, so bump the
`?v=` query on the `game.js` script tag in `index.html` after any client change.
