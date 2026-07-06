# Weapon animation pipeline — video → frames

Every STARFRAG weapon fire/reload animation is made with the **sprite-forge
VIDEO→FRAMES pipeline** (`/home/claudebot/repos/sprite-forge`, `forge/animate.md`).
This folder is the receipt for that flow. The numbered files walk the exact chain,
end to end, for each animation.

## The chain (what each numbered file shows)

1. **HERO** — a POV weapon viewmodel generated with **gpt-image-2** (`gen-image.mjs`)
   on solid `#FF00FF`: two armored hands from the bottom edge, barrel foreshortened
   to the crosshair. (`*-1-hero.png`)
2. **VIDEO** — the hero is the start frame for a **kling-v2-1 img2vid**
   (`scenario-custom.mjs`) driven by the motion prompt + the *counter-prompt kit*
   (locked camera, no VFX, first=last frame loop). (`*-2-…-video.mp4` — one kept
   in-repo as the representative; the others live on the box in `scratch-art/forge/`)
3. **EXTRACT** — `ffmpeg -vf fps=8` pulls ~40 frames; here they are contact-sheeted.
   (`*-3-…-extracted-40frames.png`)
4. **PICK** — 5–8 frames spanning the motion are chosen and laid out as a cycle,
   eyeballed for readability + loop. (`*-4/9-…-picked-*.png`)
5. **REPAIR (mandatory)** — each picked frame goes through **gpt-image-2 images/edits**
   (`gen-edit.mjs`) with `[frame, hero]` refs: match the reference exactly, restore a
   solid pure-magenta background (full chroma margin) + crisp edges. The before/after
   is shown. For FIRE frames the prompt explicitly *preserves* the muzzle flash, smoke
   and ejecting shell casings. (`*-5/10-…-repair-before-after.png`)
6. **KEY + RUNTIME** — the repaired frames are downscaled to 512² and committed under
   `client/assets/art/<weapon>/{hero,fire,reload}/`. The client keys them in-browser
   with the game's exact keyer (`m = min(r,b) - g`) and cycles them in `drawGun()`.
   The final in-game keyed cycle (over the deck colour) is shown.
   (`*-6/11/5-…-ingame-keyed.png`)

## What shipped

| weapon | hero | fire anim | reload anim |
|---|---|---|---|
| RIOT SCATTERGUN | ✅ | ✅ 5-frame (flash → brass shell eject → smoke → settle) | ✅ 8-frame pump-action (grip → rack → chamber → return) |
| PLASMA REPEATER | ✅ | bolt + green flash (fast 165 ms cadence — a frame strip would flicker) | ✅ 8-frame energy-cell swap → coil recharge arc |
| PULSE CARBINE | ✅ (existing) | muzzle flash overlay | procedural dip |

The **final, keyed, in-game frames** are the committed game assets under
`client/assets/art/scatter/**` and `client/assets/art/plasma/**`. The **full-res raw
frames, all repaired frames, and every source .mp4** stay on the box in
`scratch-art/forge/{scatter,plasma}/` (gitignored — 200 MB) for inspection.
</content>
