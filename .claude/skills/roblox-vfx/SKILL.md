---
name: roblox-vfx
description: "Use when making, tuning or reviewing a Roblox visual effect: particles, trail, beam, dash, hit spark, camera shake, a calm preset, flash limits (effect maken, deeltjes, te fel, flits)."
last_reviewed: 2026-11-11
---

# roblox-vfx: how to build effects that read and clean up

An effect has to read at full speed on a phone, fit the palette, respect the flash limit and clean itself up. More
particles is not better: a plain effect with clear timing beats a busy one.

## When to use
- A new effect, a tuning pass ("too much", "flashes too often"), or a review of an effect module.
- Not for: game feel without visuals (`game-feel`); sound (`audio-design`); UI motion (`roblox-ui`).

## 1. Understand the ask
One line each: what the effect is for in play (feedback, reward, warning, mood), how strong it should feel, how big
it is on screen, and whose screen it is on (the player's own, or other players').

## 2. Split it into parts
List the pieces before choosing tools: core flash, body, sparks, trail, ground mark, light, sound cue, camera
response. Drop any piece that does not serve the purpose.

## 3. Pick the tool per part
| Need | Use |
|---|---|
| Many small soft pieces: sparkle, dust, smoke, embers | ParticleEmitter (`Emit(n)` for a one-shot burst, `Rate` for a loop) |
| A ribbon that follows motion: dash, glide, sword arc | Trail on two attachments |
| A band between two points: beam, tether, lightning | Beam (curve, width, texture scroll) |
| A shape particles cannot draw: ring, shockwave, crescent | a MeshPart or a flat textured plane, tweened |
| Motion over time: grow, fade, orbit | TweenService for simple curves; one RunService connection with a clear end per frame |
| A soft glow in a dark zone | a small PointLight on large effects only |
Meshes and textures are original or properly licensed; nothing is copied from another game. A placeholder is labelled
as one, and an asset is never called uploaded unless it was.

## 4. Plan the timeline
Impact: build-up, hot frame, release, body, residue, clean-up. Starting numbers (tune per project style bible): hot
frame under 0.1 s, body 0.2 to 0.4 s, secondary 0.3 to 0.8 s, ground 0.3 to 0.7 s, tail 0.6 to 2 s at very low
brightness. When an effect feels long, shorten every phase. Loops: appear, settle, idle, react to movement, disappear.

## 5. Colour and readability
- Value order inside an effect: a white-hot or cream core, the element or rarity colour at the edges, a dark rim
  (from the project palette, never flat grey).
- One base hue plus at most one hot accent. Rarity effects tint one greyscale texture with the rarity colours.
- Budget: at most 1 ground effect at a time, at most 3 large pieces, about a third of the screen covered at most
  (more only for a rare ultimate). Other players' effects get half the particles and no screen-space layers.

## 6. Flash limit and comfort (hard rules)
- At most **3 full-screen flashes in any 1 second**, through one client gate (for example a `tryFlash()` function).
  Every effect that flashes, shakes or slows time asks the gate first.
- No saturated red full-screen flash. No strobing: no loop that alternates more than 3 times a second (WCAG 2.3.1).
- A **calm preset** (the default on low-end devices and a first-start choice for everyone): no flashes (a bar flash,
  a small vignette and a direction marker instead), no hit-stop, no camera shake or FOV kick, half the particles, no
  screen-space layers. Respect `GuiService.ReducedMotionEnabled`. The preset is client-only.
- Every effect has a low, mid and high tier; the calm preset forces low.

## 7. Code rules
- Effects run on the client; the server only says what happened. Other players see a cheaper version.
- Pool emitters and parts; never create instances per frame.
- Every RunService connection has an end and is disconnected; every effect has a cancel path (death, zone change,
  calm preset switched on mid-effect).
- Never leave a temporary effect running. Never invent an API: check an unsure one in the Roblox documentation.

## 8. Test and refine
Each effect needs a spec that proves clean-up (instance count back to the start, no connections left) and that the
flash gate refuses the fourth flash in a second, plus retained captures of the low and high tier and of the calm
preset, looked at on a phone-size view. Fix the weakest part (timing, layering, readability, cost) and look again.
Never claim a visual check that did not happen.

## Provenance
Method after fwjelaa (FWJ STUDIOS), through the adapted skill of an owner Roblox project (): understanding the
ask, splitting an effect into parts, a tool per part, a staged timeline, intensity tiers, testing and refining. The
source document has no licence grant, so only the method is used, paraphrased in our own words; no text is copied.
Excluded: the source wording, themed examples (gore, blood-coloured magic, hype framing), planning around paid VFX
plugins and paid mesh tools, a five-demo first task, "visually overwhelming" as a goal, and every project-specific 
zone and number (the numbers above are pack starting points, not a project style bible).
