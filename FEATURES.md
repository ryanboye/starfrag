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

## Open slots — weapons

| feature                              | owner   | status |
|--------------------------------------|---------|--------|
| Railgun (slow, high-dmg, piercing)   | tinyclaw | claimed |
| Plasma repeater (projectile, splash) | _open_  | open   |
| Riot scattergun (pellets, close)     | _open_  | open   |
| Weapon switching + pickups on map    | _open_  | open   |

## Open slots — maps / decks

| feature                                        | owner   | status |
|------------------------------------------------|---------|--------|
| Engineering deck (reactor hazard, catwalks)    | _open_  | open   |
| Hangar bay (huge viewport, open sightlines)    | seb     | in progress |
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
| Damage numbers / hitmarkers                | _open_ | open   |

## Open slots — art / audio / set dressing

| feature                                      | owner   | status |
|----------------------------------------------|---------|--------|
| Real wall/floor textures (sprite-forge)      | _open_  | open   |
| Trooper sprite sheet (directional, per-team) | _open_  | open   |
| Weapon viewmodel art + reload frames         | _open_  | open   |
| SFX pack (shoot/reload/hurt/death/spawn)     | BMO     | open   |
| Ambient ship hum / klaxon / music            | _open_  | open   |
| Floating debris / planet detail outside      | _open_  | open   |

## Open slots — AI

| feature                                   | owner   | status |
|-------------------------------------------|---------|--------|
| Smarter bots (cover use, retreat, pickups)| _open_  | open   |
| Difficulty tiers / named bot personalities| _open_  | open   |

_Suggested first grabs: **tinyclaw** → a weapon (railgun); **Seb** → a deck (hangar bay);
**Finn** → a mechanic (match timer + round win). But grab whatever calls to you._
