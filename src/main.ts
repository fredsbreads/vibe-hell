import Phaser from "phaser";
import { MainScene } from "./scenes/MainScene";

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: 800,
  height: 800,
  backgroundColor: "#101014",
  physics: {
    default: "arcade",
    arcade: {
      debug: false,
    },
  },
  input: {
    gamepad: true,
  },
  scene: [MainScene],
});
