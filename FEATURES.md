# STARFRAG — features board

Claim a slot by putting your name in the **owner** column and opening a PR. Add new rows
freely. Status: `open` · `claimed` · `in progress` · `done`. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the how-to guides.

## Built (the scaffold)

| feature                                   | owner | status |
|-------------------------------------------|-------|--------|
| authoritative ws server + 20 Hz netcode   | BMO   | done   |
| 2.5D raycaster renderer + viewports/planet| BMO   | done   |
| pulse carbine (fire, reload, muzzle flash)| BMO   | done   |
| hitscan damage / death / respawn / frags  | BMO   | done   |
| killfeed + scoreboard HUD                  | BMO   | done   |
| bot mode (`?bot=1`) + `bot.mjs` + service  | BMO   | done   |
| playtest-link integration (T to report)    | BMO   | done   |
| map-as-named-data + shared compile         | BMO   | done   |
| combat feel: blood/gibs, sparks, hit-marker | BMO  | done   |
| combat feel: screen-kick, roll, kill-hitstop| BMO  | done   |
| reactive crosshair (blooms/tightens)        | BMO  | done   |
| plasma bolts that travel (client-visual v1) | BMO  | done   |

## Open slots — weapons

| feature                              | owner   | status |
|--------------------------------------|---------|--------|
| Railgun (slow, high-dmg, piercing)   | tinyclaw | claimed |
| Plasma repeater (fast projectile)    | BMO     | done ✅ (hero viewmodel + video fire/reload anim) |
| Riot scattergun (pellets, close)     | BMO     | done ✅ (video pump-action fire + reload anim) |
| Weapon switching + pickups on map    | BMO     | done ✅ (server-authoritative grab/switch, per-weapon ammo) |

## Open slots — maps / decks

| feature                                        | owner   | status |
|------------------------------------------------|---------|--------|
| Engineering deck (reactor hazard, catwalks)    | _open_  | open   |
| Hangar bay (huge viewport, open sightlines)    | seb     | done ✅ |
| Cryo-quarters (tight corridors, ambush maze)   | _open_  | open   |
| Map rotation / voting between rounds           | _open_  | open   |

## Open slots — mechanics

| feature                                   | owner   | status |
|-------------------------------------------|---------|--------|
| Powerups (health/armor/quad) — wire pickups| _open_ | open   |
| Jump pads / zero-g zones                   | _open_ | open   |
| Match timer + round win + intermission     | _open_ | open   |
| Remote-player interpolation (smooth motion)| _open_ | open   |
| Armor as a damage-absorbing stat           | _open_ | open   |
| Damage numbers (hit-markers ✅ shipped)     | _open_ | open   |
| **Server-authoritative projectile travel** (bolts are client-visual v1 today — hits are still instant server hitscan; move spawn/advance/collide+damage onto server.mjs so bolts can be *really* dodged) | _open_ | open |
| Airlock objective — arm 4 consoles, open bay-door, vent enemies out to win | seb | claimed |

## Open slots — art / audio / set dressing

| feature                                      | owner   | status |
|----------------------------------------------|---------|--------|
| Real wall/floor textures (sprite-forge)      | BMO     | done ✅ |
| 8-way directional enemy player sprites       | BMO     | in progress |
| Weapon viewmodel art (carbine)               | BMO     | done ✅ |
| Weapon fire+reload ANIM (video→frames pipeline) | BMO   | done ✅ (scattergun + plasma; sprite-forge kling img2vid) |
| SFX pack (shoot/reload/hurt/death/spawn + per-weapon) | BMO | done ✅ |
| Ambient ship hum / klaxon / music            | _open_  | open   |
| Floating debris / planet detail outside      | _open_  | open   |

## Open slots — AI

| feature                                   | owner   | status |
|-------------------------------------------|---------|--------|
| Smarter bots (cover use, retreat, pickups)| _open_  | open   |
| Difficulty tiers / named bot personalities| _open_  | open   |

_Suggested first grabs: **tinyclaw** → a weapon (railgun); **Seb** → a deck (hangar bay);
**Finn** → a mechanic (match timer + round win). But grab whatever calls to you._
