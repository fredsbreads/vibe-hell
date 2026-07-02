import Phaser from "phaser";
import { PlaceholderScene } from "./scenes/PlaceholderScene";

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: 800,
  height: 800,
  backgroundColor: "#101014",
  scene: [PlaceholderScene],
});
