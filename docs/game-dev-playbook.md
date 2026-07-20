# Game Dev Playbook — portable lessons

Patterns pulled from building Vibe Hell (Phaser 3 + TypeScript + Vite) that
aren't specific to that game — input handling, menu UI, collision, and
simulation/replay problems that come up in basically any real-time action
game, regardless of engine. Meant to be copied into a new project (or into
your global `~/.claude/CLAUDE.md`) so the next game doesn't relearn these
the hard way.

## Input & controllers

- Define a single input interface (e.g. `read(): InputState`) that both live
  device input and any scripted/recorded input satisfy. Everything
  downstream — movement, menus, abilities — consumes that `InputState` and
  never touches the gamepad/keyboard APIs directly. Pays for itself the
  moment you want automated testing or a replay/recording feature, since you
  can swap in a scripted source without touching any consumer.
- Expect real bugs in the engine's own gamepad plugin (stale pad references
  after a controller reconnects, sparse-array indexing when pads connect out
  of order). Don't assume "gamepad support" ships clean out of the box —
  test disconnect/reconnect explicitly.
- If a stick's raw analog magnitude drives something continuous (not just
  on/off movement), the typical ~0.2 deadzone will feel unresponsive. Lower
  it and retune from how it actually feels, rather than reusing a
  movement-tuned default.
- Keyboard focus, mouse hover, and gamepad navigation should all update one
  shared "what's currently focused" value — never track them as separate
  variables that are supposed to agree, because eventually they won't.

## Menus & UI state

- Any menu component needs a way to redraw itself (e.g. after a value
  changes) WITHOUT resetting focus to the first item. A naive `show()` that
  always resets focus will silently break any "adjust a value in place"
  interaction — a settings toggle, a stepper — the first time you build one.
- Directional navigation (move focus) and directional value-adjustment
  (change a slider/stepper) are different meanings of the same physical
  left/right input on the same screen — make sure one doesn't silently eat
  the other's input.
- When the same menu is reachable from two places (main menu, pause menu),
  share the actual component/state. A copy-pasted "second instance" will
  drift out of sync the first time you add a feature to only one of them.

## Collision & movement

- Anything whose speed can compound (chains, powerups, repeated bounces)
  needs an explicit hard cap. Unbounded multiplicative growth WILL eventually
  break physics/collision even if your own testing never happens to reach
  it — someone will.
- Checking collision only against an object's post-move endpoint each frame
  silently tunnels through small/thin hitboxes once its per-frame movement
  distance gets close to or exceeds the hitbox size. Track each fast-moving
  object's previous-frame position and use a swept (segment-vs-shape) check
  once speed is uncapped or can spike.
- Push objects back inside a boundary along the boundary's normal, with a
  small epsilon, rather than hard-stopping exactly at the line — avoids
  jittering/sticking right at the edge.
- If the boundary itself moves (rotates, resizes, scrolls), re-clamp every
  frame against the CURRENT boundary, not just at spawn — a position valid
  when something spawned can end up outside a boundary that swept past
  underneath it since.
- A "grace period" meant to forgive one too-fast repeat of some event needs
  an explicit used-once flag, not just a timer that resets on every
  occurrence — otherwise a fast enough repeat exploits the reset and gets
  unlimited grace instead of exactly one.

## Time, simulation & replay

- Decide per-mechanic whether it runs on real (wall-clock) time or your
  game's own scaled/simulated time, and don't let a single mechanic
  accidentally mix the two — this bug hides perfectly until timescale
  actually diverges from 1x, then it's very confusing to track down.
- For deterministic replay (death-cam, spectate, netcode, whatever), ALL
  simulation state must advance only from an explicit `delta` parameter
  passed into your update function — never from `Date.now()`,
  `performance.now()`, or any other ambient/nondeterministic read inside
  simulation code.
- The moment a mechanic changes from an instant trigger ("was this button
  pressed") to a held/continuous ability ("is this button down right now"),
  your recorded-input format needs the per-frame held state, not just the
  press edge. Easy to miss when a mechanic's design changes mid-project.
- For a resource whose max scales dynamically (a combo bonus, a chain
  multiplier), snap the current value to the new max immediately on any
  change to that max — both when it grows AND when it shrinks — so there's
  never even one frame of a stale "over-cap" or "under-cap" display.

## Workflow

- For anything touching movement/collision/replay, verify by actually
  driving the running game end-to-end (headless browser + save/restore
  hooks, or equivalent), not just by type-checking or testing in isolation.
  The bugs that matter in a real-time game mostly only show up when the real
  loop is actually running.
- If a value is normally recomputed every frame by a live update loop, a
  one-off manual override in a test gets silently overwritten on the very
  next frame. Construct a real scenario that produces the value you want
  instead of poking the field directly, or you'll "verify" against a state
  that never actually held.
- Turn on strict unused-parameter/unused-local checks from day one — they
  reliably catch the leftover parameter a mechanic redesign leaves behind.
