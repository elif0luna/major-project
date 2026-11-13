import * as THREE from "three";
import {
  ARENA_H,
  ARENA_W,
  PLAYER_MAX_HEALTH,
  PLAYER_MAX_STAMINA,
  PLAYER_RADIUS,
  WALLS,
  type PlayerSnap,
} from "@netcode/shared";

export type Drawn = PlayerSnap;

export interface ShotEffect {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  hit: boolean;
  blocked: boolean;
  until: number;
}

interface RenderState {
  players: Drawn[];
  myId: number | null;
  ghost: Drawn | null;
  flashing: ReadonlySet<number>;
  shots: readonly ShotEffect[];
  lagComp: boolean;
  prediction: boolean;
  interpolation: boolean;
  rtt: number | null;
  correction: number;
  route: string;
}

interface PlayerView {
  group: THREE.Group;
  body: THREE.Mesh;
  barrel: THREE.Mesh;
  ring: THREE.Mesh;
  bar: THREE.Sprite;
  barCanvas: HTMLCanvasElement;
  barTexture: THREE.CanvasTexture;
}

interface ShotView {
  line: THREE.Line;
  spark: THREE.Mesh;
}

let canvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.OrthographicCamera | null = null;
let hud: HTMLDivElement | null = null;
let ghostMesh: THREE.Mesh | null = null;
const players = new Map<number, PlayerView>();
const shotViews = new Map<ShotEffect, ShotView>();

function worldX(x: number) {
  return x - ARENA_W / 2;
}

function worldZ(y: number) {
  return y - ARENA_H / 2;
}

function makeMaterial(color: string, roughness = 0.65) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.12 });
}

function init() {
  if (renderer && scene && camera) return { renderer, scene, camera };

  canvas = document.getElementById("game") as HTMLCanvasElement | null;
  if (!canvas) throw new Error("Game canvas #game was not found");

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(ARENA_W, ARENA_H, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color("#111820");
  scene.fog = new THREE.Fog("#111820", 620, 1250);

  camera = new THREE.OrthographicCamera(-520, 520, 360, -360, 0.1, 2200);
  camera.position.set(0, 720, 560);
  camera.lookAt(0, 0, 0);

  const hemi = new THREE.HemisphereLight("#dce8ff", "#17202c", 1.6);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight("#ffffff", 2.1);
  sun.position.set(-280, 600, 260);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA_W, ARENA_H),
    new THREE.MeshStandardMaterial({ color: "#1a232e", roughness: 0.92 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(Math.max(ARENA_W, ARENA_H), 24, "#334153", "#253140");
  grid.position.y = 0.8;
  scene.add(grid);

  const borderMaterial = makeMaterial("#39495d");
  const borderHeight = 30;
  const borderThick = 8;
  const borderSpecs = [
    { x: 0, z: -ARENA_H / 2, w: ARENA_W, d: borderThick },
    { x: 0, z: ARENA_H / 2, w: ARENA_W, d: borderThick },
    { x: -ARENA_W / 2, z: 0, w: borderThick, d: ARENA_H },
    { x: ARENA_W / 2, z: 0, w: borderThick, d: ARENA_H },
  ];
  for (const spec of borderSpecs) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(spec.w, borderHeight, spec.d), borderMaterial);
    mesh.position.set(spec.x, borderHeight / 2, spec.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  const wallMaterial = makeMaterial("#667487");
  for (const wall of WALLS) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(wall.w, 48, wall.h), wallMaterial);
    mesh.position.set(worldX(wall.x + wall.w / 2), 24, worldZ(wall.y + wall.h / 2));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  ghostMesh = new THREE.Mesh(
    new THREE.TorusGeometry(PLAYER_RADIUS + 4, 1.8, 8, 48),
    new THREE.MeshBasicMaterial({ color: "#57f29b", transparent: true, opacity: 0.5 }),
  );
  ghostMesh.rotation.x = Math.PI / 2;
  ghostMesh.visible = false;
  scene.add(ghostMesh);

  hud = document.createElement("div");
  hud.className = "webgl-hud";
  document.getElementById("game-area")?.appendChild(hud);

  return { renderer, scene, camera };
}

function createBarSprite() {
  const barCanvas = document.createElement("canvas");
  barCanvas.width = 160;
  barCanvas.height = 42;
  const barTexture = new THREE.CanvasTexture(barCanvas);
  const material = new THREE.SpriteMaterial({ map: barTexture, transparent: true, depthTest: false });
  const bar = new THREE.Sprite(material);
  bar.scale.set(72, 19, 1);
  return { bar, barCanvas, barTexture };
}

function drawBars(view: PlayerView, p: Drawn, label: string) {
  const context = view.barCanvas.getContext("2d");
  if (!context) return;

  context.clearRect(0, 0, view.barCanvas.width, view.barCanvas.height);
  context.fillStyle = "rgba(4, 8, 14, 0.76)";
  context.fillRect(0, 0, 160, 42);

  context.fillStyle = "#dce8f8";
  context.font = "13px Consolas, monospace";
  context.fillText(label, 8, 14);

  context.fillStyle = "#202936";
  context.fillRect(8, 19, 144, 8);
  context.fillStyle = "#e65361";
  context.fillRect(8, 19, 144 * Math.max(0, Math.min(1, p.health / PLAYER_MAX_HEALTH)), 8);

  context.fillStyle = "#202936";
  context.fillRect(8, 31, 144, 6);
  context.fillStyle = "#58a6ff";
  context.fillRect(8, 31, 144 * Math.max(0, Math.min(1, p.stamina / PLAYER_MAX_STAMINA)), 6);

  view.barTexture.needsUpdate = true;
}

function createPlayerView(id: number): PlayerView {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(PLAYER_RADIUS, 22, 6, 18),
    makeMaterial("#57f29b"),
  );
  body.position.y = 30;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(3.5, 3.5, 36, 12),
    makeMaterial("#dbe7f5", 0.42),
  );
  barrel.rotation.z = -Math.PI / 2;
  barrel.position.set(24, 34, 0);
  barrel.castShadow = true;
  group.add(barrel);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(PLAYER_RADIUS + 5, 2, 8, 48),
    new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.88 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 2;
  ring.visible = false;
  group.add(ring);

  const { bar, barCanvas, barTexture } = createBarSprite();
  bar.position.y = 75;
  group.add(bar);

  const view = { group, body, barrel, ring, bar, barCanvas, barTexture };
  players.set(id, view);
  scene!.add(group);
  return view;
}

function syncPlayer(p: Drawn, myId: number | null, flashing: boolean) {
  const view = players.get(p.id) ?? createPlayerView(p.id);
  const isMe = p.id === myId;
  const color = !p.alive ? "#657080" : isMe ? "#57f29b" : "#ff6767";
  const barrelColor = !p.alive ? "#788292" : "#dbe7f5";

  (view.body.material as THREE.MeshStandardMaterial).color.set(color);
  (view.barrel.material as THREE.MeshStandardMaterial).color.set(barrelColor);
  view.group.position.set(worldX(p.x), 0, worldZ(p.y));
  view.group.rotation.y = -Math.atan2(p.aimY, p.aimX);
  view.group.visible = true;
  view.body.scale.setScalar(p.alive ? 1 : 0.82);
  view.barrel.visible = p.alive;
  view.ring.visible = flashing;

  drawBars(view, p, `${isMe ? "YOU" : `P${p.id}`}  ${p.score}`);
}

function syncShots(activeShots: readonly ShotEffect[]) {
  for (const [shot, view] of shotViews) {
    if (activeShots.includes(shot)) continue;
    scene!.remove(view.line);
    scene!.remove(view.spark);
    shotViews.delete(shot);
  }

  const now = performance.now();
  for (const shot of activeShots) {
    let view = shotViews.get(shot);
    if (!view) {
      const points = [
        new THREE.Vector3(worldX(shot.fromX), 38, worldZ(shot.fromY)),
        new THREE.Vector3(worldX(shot.toX), 38, worldZ(shot.toY)),
      ];
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: shot.hit ? "#ffe176" : shot.blocked ? "#a4b7cb" : "#6bb4ff", transparent: true }),
      );
      const spark = new THREE.Mesh(
        new THREE.SphereGeometry(shot.hit ? 8 : 5, 16, 10),
        new THREE.MeshBasicMaterial({ color: shot.hit ? "#fff2bc" : "#90c8ff", transparent: true }),
      );
      spark.position.set(worldX(shot.toX), 42, worldZ(shot.toY));
      scene!.add(line);
      scene!.add(spark);
      view = { line, spark };
      shotViews.set(shot, view);
    }

    const alpha = Math.max(0, Math.min(1, (shot.until - now) / 140));
    (view.line.material as THREE.LineBasicMaterial).opacity = alpha;
    (view.spark.material as THREE.MeshBasicMaterial).opacity = alpha;
  }
}

function syncHud(state: RenderState) {
  if (!hud) return;

  const me = state.players.find((p) => p.id === state.myId) ?? null;
  const enemy = state.players.find((p) => p.id !== state.myId) ?? null;
  const hp = me ? `${Math.round(me.health)}/${PLAYER_MAX_HEALTH}` : "--";
  const stamina = me ? `${Math.round(me.stamina)}%` : "--";
  const enemyHp = enemy ? `${Math.round(enemy.health)}/${PLAYER_MAX_HEALTH}` : "--";

  hud.innerHTML = `
    <div class="hud-panel">
      <div class="hud-title">NET STRIKE</div>
      <div class="hud-grid">
        <span>Health</span><strong>${hp}</strong>
        <span>Stamina</span><strong>${stamina}</strong>
        <span>Score</span><strong>${me?.score ?? 0} - ${enemy?.score ?? 0}</strong>
        <span>Opponent</span><strong>${enemyHp}</strong>
      </div>
    </div>
    <div class="hud-panel hud-net">
      <div><span>Route</span><strong>${state.route}</strong></div>
      <div><span>RTT</span><strong>${state.rtt === null ? "--" : `${state.rtt.toFixed(0)} ms`}</strong></div>
      <div><span>Correction</span><strong>${state.correction.toFixed(1)} px</strong></div>
      <div><span>Prediction</span><strong class="${state.prediction ? "on" : "off"}">${state.prediction ? "ON" : "OFF"}</strong></div>
      <div><span>Interpolation</span><strong class="${state.interpolation ? "on" : "off"}">${state.interpolation ? "ON" : "OFF"}</strong></div>
      <div><span>Lag Compensation</span><strong class="${state.lagComp ? "on" : "off"}">${state.lagComp ? "ON" : "OFF"}</strong></div>
    </div>
  `;
}

export function render(state: RenderState) {
  const engine = init();
  const activeIds = new Set(state.players.map((p) => p.id));

  for (const [id, view] of players) {
    if (activeIds.has(id)) continue;
    view.group.visible = false;
  }

  for (const p of state.players) {
    syncPlayer(p, state.myId, state.flashing.has(p.id));
  }

  if (ghostMesh) {
    ghostMesh.visible = Boolean(state.ghost);
    if (state.ghost) {
      ghostMesh.position.set(worldX(state.ghost.x), 3, worldZ(state.ghost.y));
    }
  }

  syncShots(state.shots);
  syncHud(state);
  engine.renderer.render(engine.scene, engine.camera);
}
