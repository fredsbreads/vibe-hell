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
| 3. Stop Wave | Large, slow-moving barrier/wave. | IMMUNE TO SLASH. Bypasses Dash i-frames completely. Must walk normally/position around it. |

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
3. **The Safe Lane Volley Rule:** Projectiles spawn in rhythmic bursts/volleys. Every volley must programmatically leave an interconnected 30% gap of empty nodes on the perimeter, guaranteeing a physical lane for the player to see, track, and position into.

## 5. Wave Loop & Progression Math

### Session Structure

- **Wave Length:** 45 seconds of active survival play.
- **Intermission:** A 3-to-4 second "Breather Window." All active screen objects are wiped, a wave transition graphic is rendered, and the arena changes shape or rotation properties.

### Procedural Difficulty Scaling

The game uses a global `DifficultyMultiplier` state which increments by 15% (+0.15) at the start of every wave.

- **Wave 1–2:** Spawns Basic projectiles only. Low speed, low density.
- **Wave 3:** Introduces Zoomers. Scaling speeds up.
- **Wave 4+:** Introduces Stop Waves. Full threat matrix enabled. Spawn frequency increases.
- **Intensity Cap:** Multiplier scaling plateaus at Wave 10 to ensure balanced processing boundaries.

### Scoring Configuration

- **Metric Title:** THREATS ENDURED
- **Logic:** Score increments by 1 whenever a Basic projectile is successfully deactivated by a player Slash, or whenever a projectile naturally flies outside of the playable field boundaries.

## 6. Technical Implementation Directives

- **Engine Target:** Phaser 3 Framework (2D Arcade Physics Module).
- **Language:** TypeScript.
- **Performance Rule:** Object Pooling. The engine must pre-instantiate a block of roughly 500 total projectile entities (split between Basic, Zoomer, and Stop Wave architectures) at initialization. The spawner manages state toggles (`setActive(true/false)` and visibility) rather than creating or destroying objects dynamically to prevent browser memory stutters.
