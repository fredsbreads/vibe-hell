# Game Design Document: Vibe Hell (Working Title)

## 1. Executive Summary

**Genre:** Top-Down 2D Arcade Bullet Hell / Twin-Stick Kinetic Puzzle

**Target Platform:** Web Browser (PC/Mac with PlayStation 5 DualSense Controller Support)

**Core Concept:** A high-speed, score-based survival game where the player utilizes unrestricted mobility and active directional slashing to neutralize a shifting, geometry-altering arena of hostile projectiles.

**Gameplay Flow:** An endless survival loop structured around 45-second waves of compounding mathematical difficulty, punctuated by brief geometric intermissions.

## 2. The Twin-Stick "Rock, Paper, Scissors" Matrix

The game decouples player movement from player aiming to create a highly tactical, fluid defensive loop. The player must choose the correct input state to counter incoming threats.

| Projectile Name | Behavior Profile | Counter Strategy |
| --- | --- | --- |
| 1. Basic | Medium speed; aims at the player once at launch, then flies a fixed straight line; bounces off the stadium walls. | Evade via movement, or use a timed directional Slash to deflect it. |
| 2. Zoomer | Highly fast; fires in straight, linear trajectories. | Execute a timed Dash to utilize invincibility frames (i-frames) and phase through it, or use a timed directional Slash to deflect it. |
| 3. Stop Wave | A thin, solid bar spanning the full width of the arena, sweeping from one side clean across to the opposite side. No gap - walking through it is completely harmless. Not destroyed by contact; it's a persistent hazard, not an obstacle. | IMMUNE TO SLASH. A pure Dash counter: normal movement passes through it freely, but dashing into it cancels the dash and inflicts damage, bypassing the i-frames Dash would normally grant. Deflected projectiles also pass through it with no interaction. |
| 4. Chaser | Fast, like a Zoomer, but bounces off the stadium walls; unlike Basic's predictable mirror bounce, it re-aims dead at the player's current position at the instant of each bounce, so it keeps re-committing to the chase instead of settling into a fixed rebound path. Slower than a pure Zoomer to offset the extra threat of persistent re-aiming. | Execute a timed Dash to phase through it (i-frames), or use a timed directional Slash to deflect it. Not a hard counter type - normal contact deals 1 HP like Basic/Zoomer. |

## 3. Player Character Specification & Input Layout

### Health System

- **Health:** Fixed 3 HP (represented via UI heart pips).
- **Damage:** Every projectile collision deducts exactly 1 HP. No instant-kill mechanics exist.

### DualSense / PS5 Control Scheme

- **Left Analog Stick:** Controls omnidirectional movement velocity ($x$ and $y$ vectors).
- **Right Analog Stick:** Decoupled from movement. Controls a $360^\circ$ aiming angle calculated via vector coordinates (Math.atan2).

**Unrestricted Evade (Dash):**

- **Trigger:** L2 Trigger or Cross (X) Button.
- **Properties:** A rapid, short-distance burst of movement granting brief invincibility frames (i-frames).
- **Cooldown:** A short buffer cooldown after each dash prevents infinite invincibility spamming; i-frames also linger briefly past the end of the dash's movement, so invincibility doesn't cut out the instant the burst stops.
- **Hard Counter:** Dashing into a Stop Wave cancels the dash animation, bypasses i-frames, and inflicts 1 damage.

**The Mobile Strike (Slash):**

- **Trigger:** R2 Trigger or Right Bumper (R1).
- **Properties:** A short-range melee attack executed along the precise aiming angle of the Right Analog Stick. Can be performed seamlessly while moving at full speed.
- **Cooldown:** A firm cooldown to prevent mindless attack spam.
- **Deflection:** Connecting with a Basic, Zoomer, or Chaser doesn't destroy it outright - it redirects the projectile along the player's locked-in aim angle at its original speed, turning it friendly (rendered in a uniform teal, regardless of its original type). A deflected projectile mirror-bounces off the arena wall up to 3 times before despawning, and destroys any hostile projectile it touches for the rest of its lifetime - each such kill scores identically to a direct Slash hit. It never damages the player, and is completely inert against Stop Wave (passes through with no interaction, same as it being immune to Slash in the first place).

## 4. Threat & Spawner Architecture

### The Shape-Shifting Arena

**The Environment:** A geometric arena bounded by solid perimeter walls.

**Evolution of the Arena:**

The arena supports multiple boundary shapes (Circle, Pentagon, Hexagon, Octagon) with rotation, so bouncing projectiles' deflection math isn't fixed to one static geometry. A new shape is randomly chosen during every intermission's countdown (never repeating the immediately preceding one), so a run's arena keeps changing without ever needing a wave transition to also decide *which* shape comes next in a fixed order. Also reachable manually via a debug toggle, for testing a specific shape on demand. Square exists in code but is currently excluded from rotation - it pinches in enough at the edges to feel cramped, especially on later/harder waves where maneuvering room matters most.

### Fair-Play Spawner Rules

To ensure the game loop remains 100% skill-winnable, the perimeter spawner algorithm enforces three restrictions:

1. **Perimeter Only:** All projectiles spawn strictly at the absolute boundary lines of the stadium. Projectiles never materialize inside the playable field.
2. **Dynamic Perimeter Filtering:** The spawner checks the player's real-time 2D coordinates. It temporarily disables spawning points on the perimeter nodes closest to the player, eliminating unreactable point-blank spawns.
3. **The Safe Lane Rule:** The perimeter always maintains a contiguous gap of empty spawn nodes - roughly a fifth of the boundary - that slowly sweeps around over time, guaranteeing a physical lane the player can see, track, and position into.

## 5. Wave Loop & Progression Math

### Session Structure

- **Wave Length:** 45 seconds of active survival play.
- **Intermission:** A brief "Breather Window." All active screen objects are wiped and a wave transition graphic is rendered before the next wave begins.

### Procedural Difficulty Scaling

Difficulty scales along two independent axes so a single wave transition never compounds both at once: a global `DifficultyMultiplier` "pace" that steps up 15% (+0.15) on every wave, and the threat roster, which grows on its own schedule. Whenever a wave introduces a new threat type, the pace holds steady for that wave instead of also stepping up.

- **Wave 1:** Spawns Basic projectiles only.
- **Wave 2:** Introduces Zoomers. Pace holds steady.
- **Wave 3:** Pace steps up.
- **Wave 4:** Introduces Chasers. Pace holds steady.
- **Wave 5:** Pace steps up.
- **Wave 6:** Introduces Stop Waves. Full threat matrix enabled. Pace holds steady.
- **Wave 7+:** Pace steps up every wave.
- **Intensity Cap:** Multiplier scaling plateaus after 10 pace steps (Wave 12) to ensure balanced processing boundaries.

### Scoring Configuration

- **Metric Title:** THREATS ENDURED
- **Logic:** Score increments by 1 whenever a Slash connects with a projectile (deflecting it), and by another 1 for every hostile projectile that deflected projectile subsequently destroys on contact. A projectile that naturally flies outside the playable field boundaries unhandled is not scored.

## 6. Technical Implementation Directives

- **Engine Target:** Phaser 3 Framework (2D Arcade Physics Module).
- **Language:** TypeScript.
- **Performance Rule:** Object Pooling. The engine must pre-instantiate a fixed pool of projectile entities per threat type at initialization, sized to what that type's peak on-screen count could realistically be. The spawner manages state toggles (`setActive(true/false)` and visibility) rather than creating or destroying objects dynamically to prevent browser memory stutters.
