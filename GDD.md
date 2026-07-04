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
| 1. Basic | Medium speed; tracks player; bounces off the stadium walls. | Evade via movement, or use a timed directional Slash to instantly deactivate it. |
| 2. Zoomer | Highly fast; fires in straight, linear trajectories. | Execute a timed Dash to utilize invincibility frames (i-frames) and phase through it. |
| 3. Stop Wave | A thin, solid bar spanning the full width of the arena, sweeping from one side clean across to the opposite side. No gap - walking through it is completely harmless. Not destroyed by contact; it's a persistent hazard, not an obstacle. | IMMUNE TO SLASH. A pure Dash counter: normal movement passes through it freely, but dashing into it cancels the dash and inflicts damage, bypassing the i-frames Dash would normally grant. |
| 4. Chaser | Fast, like a Zoomer, but bounces off the stadium walls; unlike Basic's predictable mirror bounce, it re-aims dead at the player's current position at the instant of each bounce, so it keeps re-committing to the chase instead of settling into a fixed rebound path. Slower than a pure Zoomer to offset the extra threat of persistent re-aiming. | Execute a timed Dash to phase through it (i-frames), or use a timed directional Slash to instantly deactivate it. Not a hard counter type - normal contact deals 1 HP like Basic/Zoomer. |

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
- **Cooldown:** Features a minor 0.2-second buffer cooldown to prevent infinite invincibility spamming.
- **Hard Counter:** Dashing into a Stop Wave cancels the dash animation, bypasses i-frames, and inflicts 1 damage.

**The Mobile Strike (Slash):**

- **Trigger:** R2 Trigger or Right Bumper (R1).
- **Properties:** A short-range melee attack executed along the precise aiming angle of the Right Analog Stick. Can be performed seamlessly while moving at full speed.
- **Cooldown:** Strict 0.5-second cooldown to prevent mindless attack spam.

## 4. Threat & Spawner Architecture

### The Shape-Shifting Arena

**The Environment:** A geometric arena bounded by solid perimeter walls.

**Evolution of the Arena:**

- **Waves 1–2:** Completely static boundary (Circle or Square). Projectile deflections are highly predictable.
- **Waves 3–4 (The Spin):** The arena begins slowly rotating over time, dynamically altering deflection math for bouncing Basic projectiles.
- **Waves 5+ (Shape-Shift):** During wave intermissions, the physical arena walls morph into entirely different configurations (e.g., transforming from a Circle into an Octagon or Star), completely shifting the spatial puzzle layout.

### Fair-Play Spawner Rules

To ensure the game loop remains 100% skill-winnable, the perimeter spawner algorithm enforces three restrictions:

1. **Perimeter Only:** All projectiles spawn strictly at the absolute boundary lines of the stadium. Projectiles never materialize inside the playable field.
2. **Dynamic Perimeter Filtering:** The spawner checks the player's real-time 2D coordinates. It temporarily disables spawning points on the perimeter nodes closest to the player, eliminating unreactable point-blank spawns.
3. **The Safe Lane Volley Rule:** Projectiles spawn in rhythmic bursts/volleys. Every volley must programmatically leave an interconnected 20% gap of empty nodes on the perimeter, guaranteeing a physical lane for the player to see, track, and position into.

## 5. Wave Loop & Progression Math

### Session Structure

- **Wave Length:** 45 seconds of active survival play.
- **Intermission:** A 3-to-4 second "Breather Window." All active screen objects are wiped, a wave transition graphic is rendered, and the arena changes shape or rotation properties.

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
- **Logic:** Score increments by 1 whenever a Basic projectile is successfully deactivated by a player Slash, or whenever a projectile naturally flies outside of the playable field boundaries.

## 6. Technical Implementation Directives

- **Engine Target:** Phaser 3 Framework (2D Arcade Physics Module).
- **Language:** TypeScript.
- **Performance Rule:** Object Pooling. The engine must pre-instantiate a block of roughly 500 total projectile entities (split between Basic, Zoomer, and Stop Wave architectures) at initialization. The spawner manages state toggles (`setActive(true/false)` and visibility) rather than creating or destroying objects dynamically to prevent browser memory stutters.
