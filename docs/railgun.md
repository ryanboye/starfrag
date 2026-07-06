# RAILGUN — charge-up wall-piercing power weapon (tinyclaw)

Slot 4 · pickup on deck7 at cell **(16,13)** (north core apron). The one weapon that would
be a trivial wallhack + damage cheat on a trusting client — so **every** decision is
server-authoritative.

## Feel
HOLD fire to spin up, RELEASE to fire. Release under `charge.minMs` = a dud (no shot, no
ammo). Damage scales `dmgLo → dmgHi` over `[minMs, fullMs]`; a full charge one-shots a
100-HP body. The rail **pierces** — it ignores walls and passes through every body along
`range` (longest in the game). Slow cadence + 3-round clip keep it a power weapon, not a
default.

Stats live in `shared/protocol.js` (`WEAPONS.railgun`): `rateMs 250, clip 3, reloadMs 1900,
dmgLo 34, dmgHi 110, range 60, charge {minMs 250, fullMs 1100}, pierce true`.

## Why it can't be cheated
- **The server times the hold.** `C2S.CHARGE` starts the server's clock; `C2S.SHOOT` (on
  release) reads elapsed time. The client's *claimed* charge is never trusted — a client
  that lies about its charge, or trusts its own hitscan, changes nothing. See
  `server.mjs resolveShot` + the `SHOOT`/`CHARGE` handlers.
- **The charge-gate is server-side.** `held < minMs` → the server drops the shot and spends
  no ammo. The client mirrors this only for prediction (HUD/ammo), never as the authority.
- **The pierce set + damage are server-side.** `resolveShot` walks every body within
  `HIT_RADIUS` along the ray (through walls) and applies `applyHit` per body with the
  server-derived `chargeFrac`.

## Client presentation (all cosmetic; server owns truth)
- **Charge:** press → `C2S.CHARGE` + a local clock. A crosshair **charge ring** sweeps
  clockwise — dim red under the min-gate, snapping to rail-purple + a white pulse the instant
  it's armed — plus a growing **muzzle energy ball** (procedural now; BMO's charge strip
  layers on top). Release → `C2S.SHOOT`.
- **Fire:** a first-person **rail flash** (bright vertical bloom, muzzle→crosshair) for the
  shooter; remotes see the world-space **rail beam** (`drawBeam`) streak along the shot ray,
  drawn *through* walls (ghosted) so the pierce is visible. Charge (0..1) rides on `S2C.SHOT`
  so everyone's beam intensity matches.

## Verification
- `tools/railgun-test.mjs` — raw-WS, **server-authoritative** proof (10/10): pickup grant,
  carbine-wall-occlusion control, SHOOT-without-CHARGE = nothing (anti-cheat), sub-min fizzle,
  pierce-through-wall-and-both-bodies with damage scaling, double-kill at full charge.
- `tools/railgun-verify.mjs` — one real headless client: charge ring + muzzle glow render,
  `chargeFrac` climbs 0→1, release spawns a rail + spends a round, sub-min tap costs nothing,
  and the viewmodel stays LOW on wide-short mobile-landscape (awfml QA). Proof shots →
  `docs/railgun-*.png`.

## Art drop contract (BMO — branch `art/railgun`)
Square POV frames on solid `#FF00FF`, two dark gloved hands from the bottom edge, barrel
foreshortened to center, **muzzle flash NOT baked in** (game.js overlays it), `topFrac ≈ 0.20`.
Same format as scatter/plasma. Drop into `client/assets/art/railgun/`:

| file | frames | notes |
|------|--------|-------|
| `hero.png`        | 1  | idle anchor (dark coils) |
| `charge/f0..f7.png` | 8  | spin-up, indexed by charge fraction 0→1 (NOT time); no discharge |
| `fire/f0..f4.png`    | 5  | discharge recoil + settle |
| `reload/f0..f7.png`  | 8  | breech rack → slug eject → reseat → slam; perfect loop |

The loader (`loadWeaponArt('railgun', { charge: 8, reload: 8, fire: 5 })`) + `drawGun`'s
charge/fire/reload strip picks are already wired. **Delivered by BMO on branch `art/railgun`**
(merged in) — the strips light up the viewmodel; charge indexes by charge fraction exactly
like reload indexes by progress. If a count changes, update that one `loadWeaponArt` call.
