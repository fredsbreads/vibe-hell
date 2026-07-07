import Phaser from "phaser";
import { TitleScene } from "./scenes/TitleScene";
import { MainScene } from "./scenes/MainScene";
import {
  patchPhaserGamepadPluginSparseArrayBug,
  patchPhaserGamepadPluginStalePadReferenceBug,
} from "./input/phaserGamepadPatch";

patchPhaserGamepadPluginSparseArrayBug();
patchPhaserGamepadPluginStalePadReferenceBug();

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: 800,
  height: 800,
  backgroundColor: "#101014",
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  physics: {
    default: "arcade",
    arcade: {
      debug: false,
    },
  },
  input: {
    gamepad: true,
  },
  scene: [TitleScene, MainScene],
});

// TEMP debug-only, for verifying the tiered-deflect experiment. Remove before merging.
(window as unknown as { __game: Phaser.Game }).__game = game;
