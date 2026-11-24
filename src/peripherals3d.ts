import * as THREE from 'three';
import { TaperTube3D, approach, clamp, mix, smoothstep } from './keyboard3d';

export type PeripheralMode = 'keyboard' | 'tablet' | 'gamepad';

/**
 * World units per pixel of the 2D engine's gamepad artwork. The 2D gamepad
 * silhouette is 284 px wide, so this keeps the 3D model the exact same
 * proportions the hand-tuned 2D model has.
 */
const PAD_SCALE = 0.0055;

/** Button accents copied from the 2D engine so both models read the same. */
const PAD_ACCENTS: Record<number, string> = {
  0: '#66d17a', // A
  1: '#ff6b6b', // B
  2: '#ffd34d', // Y
  3: '#5aa9ff', // X
};

/** Button ids as mapped by the Rust side (gilrs / XInput). */
const PAD_FACE_BUTTONS = [0, 1, 2, 3];
const PAD_BUMPERS = [5, 7];
const PAD_TRIGGERS = [4, 6];
const PAD_DPAD = [13, 14, 15, 16];
const PAD_PLAYER_LEDS = [19, 20, 21, 22];

interface PadButton3D {
  id: number;
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  base: THREE.Color;
  glow: number;
  press: number;
  x: number;
  z: number;
  radius: number;
  /** How far the part travels when it is held down. */
  travel: number;
  /** Direction the part travels (local space). */
  dir: THREE.Vector3;
  /** Resting position, so the press offset never accumulates. */
  rest: THREE.Vector3;
}

const labelTextureCache = new Map<string, THREE.CanvasTexture>();

function makePadLabelTexture(label: string, accent: string): THREE.CanvasTexture {
  const key = `${label}|${accent}`;
  const cached = labelTextureCache.get(key);
  if (cached) return cached;

  const c = document.createElement('canvas');
  c.width = 96;
  c.height = 96;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 96, 96);
  g.font = '800 44px "Segoe UI", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = accent;
  g.fillText(label, 48, 50);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  labelTextureCache.set(key, tex);
  return tex;
}

/** Soft radial blob used as the grounded contact shadow of a desk object. */
function makeBlobShadowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(128, 128, 18, 128, 128, 124);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.46)');
  grad.addColorStop(0.55, 'rgba(0, 0, 0, 0.20)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The 2D engine draws the gamepad as a wide hybrid silhouette with two grips
 * and a notch between them. The very same bezier outline is reused here as a
 * THREE.Shape so the 3D body is the 2D body, only with real depth.
 */
function makeGamepadBodyShape(): THREE.Shape {
  const s = new THREE.Shape();
  const X = (v: number) => v * PAD_SCALE;
  const Z = (v: number) => (v - 5) * PAD_SCALE;

  s.moveTo(X(-52), Z(-30));
  s.quadraticCurveTo(X(0), Z(-40), X(52), Z(-30));
  s.bezierCurveTo(X(86), Z(-30), X(112), Z(-22), X(126), Z(0));
  s.bezierCurveTo(X(142), Z(26), X(140), Z(48), X(118), Z(49));
  s.bezierCurveTo(X(96), Z(50), X(80), Z(34), X(64), Z(30));
  s.bezierCurveTo(X(40), Z(36), X(-40), Z(36), X(-64), Z(30));
  s.bezierCurveTo(X(-80), Z(34), X(-96), Z(50), X(-118), Z(49));
  s.bezierCurveTo(X(-140), Z(48), X(-142), Z(26), X(-126), Z(0));
  s.bezierCurveTo(X(-112), Z(-22), X(-86), Z(-30), X(-52), Z(-30));
  s.closePath();
  return s;
}

/** The tablet body is a rounded trapezoid: narrower at the far edge. */
function makeTabletBodyShape(halfW: number, depth: number): THREE.Shape {
  const s = new THREE.Shape();
  const r = 0.07;
  const topHalf = halfW * 0.88;
  const botHalf = halfW;
  const topZ = -depth / 2;
  const botZ = depth / 2;

  s.moveTo(-topHalf + r, topZ);
  s.lineTo(topHalf - r, topZ);
  s.quadraticCurveTo(topHalf, topZ, topHalf + 0.02, topZ + r);
  s.lineTo(botHalf - 0.02, botZ - r);
  s.quadraticCurveTo(botHalf, botZ, botHalf - r, botZ);
  s.lineTo(-botHalf + r, botZ);
  s.quadraticCurveTo(-botHalf, botZ, -botHalf + 0.02, botZ - r);
  s.lineTo(-topHalf - 0.02, topZ + r);
  s.quadraticCurveTo(-topHalf, topZ, -topHalf + r, topZ);
  s.closePath();
  return s;
}

/** Extrudes a shape into a slab whose top face sits at `topY`. */
function extrudeSlab(shape: THREE.Shape, height: number, color: string, topY = 0): THREE.Mesh {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
    curveSegments: 12,
  });
  geo.rotateX(Math.PI / 2);
  geo.translate(0, topY + height, 0);
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
}

interface Stick3D {
  base: THREE.Mesh;
  knob: THREE.Mesh;
  knobMat: THREE.MeshBasicMaterial;
  x: number;
  z: number;
  axisX: number;
  axisY: number;
  press: number;
}

/**
 * A real 3D gamepad: extruded body, analog sticks that tilt with the axes,
 * a D-pad, face buttons, bumpers, triggers and the player LED strip.
 */
export class Gamepad3D {
  public readonly group = new THREE.Group();

  private readonly buttons = new Map<number, PadButton3D>();
  private readonly sticks: Stick3D[] = [];
  private readonly ledMats: THREE.MeshBasicMaterial[] = [];
  private readonly bodyMat: THREE.MeshBasicMaterial;
  private readonly rimMat: THREE.MeshBasicMaterial;
  private readonly accentMat: THREE.MeshBasicMaterial;
  private readonly shadowTex = makeBlobShadowTexture();

  private accent = new THREE.Color('#d4f044');
  private rumble = 0;
  private visible = 0;
  private visibleTarget = 0;
  private readonly basePos = new THREE.Vector3(0.2, 0.0, 1.16);

  constructor() {
    this.group.position.copy(this.basePos);

    // Grounded contact shadow.
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.9, 0.95),
      new THREE.MeshBasicMaterial({
        map: this.shadowTex,
        transparent: true,
        depthWrite: false,
        opacity: 0.75,
      }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.002;
    this.group.add(shadow);

    // Dark under-shell + graphite body + a lighter top face, the same three
    // tone split the 2D model uses.
    const under = extrudeSlab(makeGamepadBodyShape(), 0.045, '#191d24', -0.045);
    this.bodyMat = new THREE.MeshBasicMaterial({ color: '#3a4150' });
    const body = extrudeSlab(makeGamepadBodyShape(), 0.028, '#3a4150', 0);
    body.material = this.bodyMat;
    this.rimMat = new THREE.MeshBasicMaterial({ color: '#6a7484' });
    const topFace = extrudeSlab(makeGamepadBodyShape(), 0.022, '#6a7484', 0.03);
    this.group.add(under, body, topFace);

    // Inner panel so the top face reads as a separate surface.
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(1.3, 0.4),
      new THREE.MeshBasicMaterial({ color: '#2b313b' }),
    );
    plate.rotation.x = -Math.PI / 2;
    plate.position.set(0, 0.0525, 0.0);
    this.group.add(plate);

    this.accentMat = new THREE.MeshBasicMaterial({ color: '#d4f044' });

    this.buildFaceButtons();
    this.buildDpad();
    this.buildSticks();
    this.buildShoulders();
    this.buildCenterButtons();
    this.buildPlayerLeds();
  }

  private addButton(
    id: number,
    x: number,
    z: number,
    radius: number,
    height: number,
    color: string,
    opts?: { travel?: number; dir?: [number, number, number]; label?: string },
  ): PadButton3D {
    const geo = new THREE.CylinderGeometry(radius, radius * 0.94, height, 20);
    const mat = new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    const rest = new THREE.Vector3(x, 0.0525 + height / 2, z);
    mesh.position.copy(rest);
    this.group.add(mesh);

    const entry: PadButton3D = {
      id,
      mesh,
      mat,
      base: new THREE.Color(color),
      glow: 0,
      press: 0,
      x,
      z,
      radius,
      travel: opts?.travel ?? 0.012,
      dir: new THREE.Vector3(...(opts?.dir ?? [0, -1, 0])),
      rest,
    };
    this.buttons.set(id, entry);

    if (opts?.label) {
      const labelGeo = new THREE.PlaneGeometry(radius * 1.5, radius * 1.5);
      labelGeo.rotateX(-Math.PI / 2);
      const labelMesh = new THREE.Mesh(
        labelGeo,
        new THREE.MeshBasicMaterial({
          map: makePadLabelTexture(opts.label, '#1d2027'),
          transparent: true,
          depthWrite: false,
        }),
      );
      // Parented to the button so the label follows the press animation.
      labelMesh.position.set(0, height / 2 + 0.001, 0);
      labelMesh.renderOrder = 6;
      mesh.add(labelMesh);
    }
    return entry;
  }

  private buildFaceButtons(): void {
    // Face cluster sits on the left of the screen, matching the mirrored
    // "cat is holding the pad" view the 2D engine uses.
    const clusterX = -68 * PAD_SCALE;
    const clusterZ = 2 * PAD_SCALE;
    const spread = 14 * PAD_SCALE;
    const positions: Record<number, [number, number]> = {
      0: [clusterX, clusterZ + spread], // A
      1: [clusterX - spread, clusterZ], // B
      2: [clusterX, clusterZ - spread], // Y
      3: [clusterX + spread, clusterZ], // X
    };
    for (const id of PAD_FACE_BUTTONS) {
      const [x, z] = positions[id];
      this.addButton(id, x, z, 9.5 * PAD_SCALE, 0.016, PAD_ACCENTS[id], {
        label: ['A', 'B', 'Y', 'X'][id],
      });
    }
  }

  private buildDpad(): void {
    const cx = 30 * PAD_SCALE;
    const cz = 8 * PAD_SCALE;
    const arm = 9 * PAD_SCALE;
    const thickness = 8 * PAD_SCALE;
    const cross = new THREE.Mesh(
      new THREE.BoxGeometry(arm * 2.05, 0.014, thickness),
      new THREE.MeshBasicMaterial({ color: '#454c5a' }),
    );
    cross.position.set(cx, 0.0595, cz);
    this.group.add(cross);
    const cross2 = new THREE.Mesh(
      new THREE.BoxGeometry(thickness, 0.014, arm * 2.05),
      new THREE.MeshBasicMaterial({ color: '#454c5a' }),
    );
    cross2.position.set(cx, 0.0595, cz);
    this.group.add(cross2);

    // D-pad directions: 13 = up (far), 14 = down (near), 15 = left, 16 = right.
    const dirs: Array<[number, number, number, number]> = [
      [13, cx, cz - arm * 0.72, 0],
      [14, cx, cz + arm * 0.72, 1],
      [15, cx - arm * 0.72, cz, 2],
      [16, cx + arm * 0.72, cz, 3],
    ];
    for (const [id, x, z] of dirs) {
      const geo = new THREE.BoxGeometry(7 * PAD_SCALE, 0.017, 7 * PAD_SCALE);
      const mat = new THREE.MeshBasicMaterial({ color: '#666f7e' });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, 0.0605, z);
      this.group.add(mesh);
      this.buttons.set(id, {
        id,
        mesh,
        mat,
        base: new THREE.Color('#666f7e'),
        glow: 0,
        press: 0,
        x,
        z,
        radius: 4 * PAD_SCALE,
        travel: 0.008,
        dir: new THREE.Vector3(0, -1, 0),
        rest: new THREE.Vector3(x, 0.0605, z),
      });
    }
  }

  private buildSticks(): void {
    const spots: Array<[number, number]> = [
      [-26 * PAD_SCALE, 8 * PAD_SCALE],
      [64 * PAD_SCALE, 8 * PAD_SCALE],
    ];
    for (const [x, z] of spots) {
      const well = new THREE.Mesh(
        new THREE.CylinderGeometry(15.5 * PAD_SCALE, 15.5 * PAD_SCALE, 0.012, 24),
        new THREE.MeshBasicMaterial({ color: '#1e2229' }),
      );
      well.position.set(x, 0.0525, z);
      this.group.add(well);

      const knobMat = new THREE.MeshBasicMaterial({ color: '#565e6c' });
      const knob = new THREE.Mesh(
        new THREE.CylinderGeometry(10.5 * PAD_SCALE, 11.5 * PAD_SCALE, 0.03, 24),
        knobMat,
      );
      knob.position.set(x, 0.0525 + 0.02, z);
      this.group.add(knob);

      this.sticks.push({ base: well, knob, knobMat, x, z, axisX: 0, axisY: 0, press: 0 });
    }
  }

  private buildShoulders(): void {
    // Bumpers sit on the top (far) edge of the body.
    for (const id of PAD_BUMPERS) {
      const x = id === 5 ? -94 * PAD_SCALE : 54 * PAD_SCALE;
      const z = -32 * PAD_SCALE;
      const geo = new THREE.BoxGeometry(40 * PAD_SCALE, 0.026, 11 * PAD_SCALE);
      const mat = new THREE.MeshBasicMaterial({ color: '#353b46' });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, 0.062, z);
      this.group.add(mesh);
      this.buttons.set(id, {
        id,
        mesh,
        mat,
        base: new THREE.Color('#353b46'),
        glow: 0,
        press: 0,
        x,
        z,
        radius: 6 * PAD_SCALE,
        travel: 0.014,
        dir: new THREE.Vector3(0, -1, 0),
        rest: new THREE.Vector3(x, 0.062, z),
      });
    }

    // Triggers peek out behind the body.
    for (const id of PAD_TRIGGERS) {
      const x = id === 4 ? -98 * PAD_SCALE : 68 * PAD_SCALE;
      const z = -43 * PAD_SCALE;
      const geo = new THREE.BoxGeometry(30 * PAD_SCALE, 0.03, 13 * PAD_SCALE);
      const mat = new THREE.MeshBasicMaterial({ color: '#252a33' });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, 0.05, z);
      this.group.add(mesh);
      this.buttons.set(id, {
        id,
        mesh,
        mat,
        base: new THREE.Color('#252a33'),
        glow: 0,
        press: 0,
        x,
        z,
        radius: 6 * PAD_SCALE,
        travel: 0.02,
        dir: new THREE.Vector3(0, 0, -1),
        rest: new THREE.Vector3(x, 0.05, z),
      });
    }
  }

  private buildCenterButtons(): void {
    const spots: Array<[number, number, number, string]> = [
      [17, -14 * PAD_SCALE, -25 * PAD_SCALE, 'Share'],
      [8, 14 * PAD_SCALE, -25 * PAD_SCALE, 'View'],
      [9, 0, -25 * PAD_SCALE, 'Menu'],
      [10, 0, -3 * PAD_SCALE, 'Guide'],
    ];
    for (const [id, x, z, label] of spots) {
      const geo = new THREE.CylinderGeometry(5 * PAD_SCALE, 5 * PAD_SCALE, 0.014, 18);
      const mat = new THREE.MeshBasicMaterial({ color: '#565e6c' });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, 0.0525 + 0.007, z);
      this.group.add(mesh);
      this.buttons.set(id, {
        id,
        mesh,
        mat,
        base: new THREE.Color('#565e6c'),
        glow: 0,
        press: 0,
        x,
        z,
        radius: 5 * PAD_SCALE,
        travel: 0.01,
        dir: new THREE.Vector3(0, -1, 0),
        rest: new THREE.Vector3(x, 0.0525 + 0.007, z),
      });
    }
  }

  private buildPlayerLeds(): void {
    for (const id of PAD_PLAYER_LEDS) {
      const x =
        id === 19 ? 48 * PAD_SCALE : id === 20 ? 30 * PAD_SCALE : id === 21 ? -22 * PAD_SCALE : -40 * PAD_SCALE;
      const z = id === 19 || id === 22 ? 38 * PAD_SCALE : 44 * PAD_SCALE;
      const mat = new THREE.MeshBasicMaterial({ color: '#232830' });
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(3.2 * PAD_SCALE, 3.2 * PAD_SCALE, 0.008, 14),
        mat,
      );
      mesh.position.set(x, 0.0525 + 0.004, z);
      this.group.add(mesh);
      this.ledMats.push(mat);
    }
  }

  public setAccentColor(hex: string): void {
    this.accent.set(hex);
  }

  public setVisible(v: number): void {
    this.visibleTarget = v;
  }

  public setButton(id: number, level: number): void {
    const b = this.buttons.get(id);
    if (!b) return;
    b.press = clamp(level, 0, 1);
  }

  public setAxis(axis: number, value: number): void {
    // axis 0/1 = left stick, axis 2/3 = right stick.
    if (axis === 0) this.sticks[0].axisX = value;
    else if (axis === 1) this.sticks[0].axisY = value;
    else if (axis === 2) this.sticks[1].axisX = value;
    else if (axis === 3) this.sticks[1].axisY = value;
    // Some pads report the analog triggers as axes (gilrs LeftZ / RightZ)
    // instead of buttons, so the trigger blocks follow those as well.
    else if (axis === 4) this.setButton(4, Math.abs(value));
    else if (axis === 5) this.setButton(6, Math.abs(value));
  }

  public update(dt: number, elapsed: number): void {
    this.visible += (this.visibleTarget - this.visible) * approach(12, dt);
    this.group.visible = this.visible > 0.02;

    let intensity = 0;
    for (const b of this.buttons.values()) {
      intensity = Math.max(intensity, b.press);
    }
    for (const s of this.sticks) {
      intensity = Math.max(intensity, Math.abs(s.axisX), Math.abs(s.axisY));
    }
    this.rumble = intensity;

    // Rumble shake, mirroring the 2D engine's jitter.
    const shakeX = intensity > 0.35 ? Math.sin(elapsed * 46) * intensity * 0.012 : 0;
    const shakeZ = intensity > 0.35 ? Math.cos(elapsed * 39) * intensity * 0.008 : 0;
    this.group.position.set(this.basePos.x + shakeX, this.basePos.y, this.basePos.z + shakeZ);

    for (const b of this.buttons.values()) {
      const target = b.press;
      b.glow += (target - b.glow) * approach(target > 0.02 ? 40 : 8, dt);
      const isAccent = PAD_FACE_BUTTONS.includes(b.id);
      if (isAccent) {
        b.mat.color.copy(b.base).lerp(this.accent, b.glow * 0.92);
      } else {
        b.mat.color.copy(b.base).lerp(this.accent, b.glow * 0.62);
      }
      b.mesh.position.copy(b.rest).addScaledVector(b.dir, b.glow * b.travel);
    }

    for (const s of this.sticks) {
      const travel = 5 * PAD_SCALE;
      s.knob.position.x = s.x + s.axisX * travel;
      s.knob.position.z = s.z + s.axisY * travel;
      s.knobMat.color.set('#565e6c').lerp(this.accent, Math.min(1, Math.abs(s.axisX) + Math.abs(s.axisY)) * 0.32);
    }

    // Only the first player LED is lit, like a connected Xbox pad.
    for (let i = 0; i < this.ledMats.length; i++) {
      this.ledMats[i].color.set(i === 0 ? '#7ef0a0' : '#353b46');
    }
  }

  /** World position of a button, so the cat's paw can press it. */
  public buttonWorld(id: number, out = new THREE.Vector3()): THREE.Vector3 {
    const b = this.buttons.get(id);
    this.group.updateMatrixWorld(true);
    if (!b) return out.set(0, 0.05, 0).applyMatrix4(this.group.matrixWorld);
    return out.set(b.x, 0.0525 + 0.02, b.z).applyMatrix4(this.group.matrixWorld);
  }

  /** World position of an analog stick knob. */
  public stickWorld(index: number, out = new THREE.Vector3()): THREE.Vector3 {
    const s = this.sticks[index];
    this.group.updateMatrixWorld(true);
    if (!s) return out.set(0, 0.05, 0).applyMatrix4(this.group.matrixWorld);
    return out.copy(s.knob.position).applyMatrix4(this.group.matrixWorld);
  }

  /** Drops every held button and recentres both sticks. */
  public releaseAll(): void {
    for (const b of this.buttons.values()) b.press = 0;
    for (const s of this.sticks) {
      s.axisX = 0;
      s.axisY = 0;
    }
  }

  /** First button of the list that is currently held, or -1. */
  public firstPressed(ids: number[]): number {
    for (const id of ids) {
      const b = this.buttons.get(id);
      if (b && b.press > 0.1) return id;
    }
    return -1;
  }
}

interface PenState3D {
  nx: number;
  ny: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  tip: boolean;
  barrel: boolean;
  secondBarrel: boolean;
  eraser: boolean;
  inRange: boolean;
}

/** Soft white halo used for the pressure glow around the stylus nib. */
function makeGlowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
  grad.addColorStop(0.35, 'rgba(255, 255, 255, 0.34)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * A real 3D drawing tablet: extruded trapezoid body, active surface, the four
 * ExpressKeys on the left bezel, a pressure meter, a USB-C port, a braided
 * cable and a tilted stylus. The 3D tablet deliberately does not paint an ink
 * trail - the ink stays a 2D-engine feature.
 */
export class Tablet3D {
  public readonly group = new THREE.Group();

  readonly surfaceW = 1.16;
  readonly surfaceD = 0.66;
  readonly surfaceCx = 0.06;
  readonly surfaceCz = -0.02;

  private readonly penGroup = new THREE.Group();
  private readonly penBarrel: THREE.Mesh;
  private readonly penBarrelMat: THREE.MeshBasicMaterial;
  private readonly penRing: THREE.Mesh;
  private readonly penRingMat: THREE.MeshBasicMaterial;
  private readonly penNib: THREE.Mesh;
  private readonly penNibMat: THREE.MeshBasicMaterial;
  private readonly penCap: THREE.Mesh;
  private readonly penCapMat: THREE.MeshBasicMaterial;
  private readonly penGlow: THREE.Sprite;
  private readonly penButtonMats: THREE.MeshBasicMaterial[] = [];

  private readonly keyMats: THREE.MeshBasicMaterial[] = [];
  /** Local positions of the four ExpressKeys, so badges can float above them. */
  private readonly keyPositions: THREE.Vector3[] = [];
  private readonly meterMat: THREE.MeshBasicMaterial;
  private readonly meterFill: THREE.Mesh;
  private readonly cable: TaperTube3D;

  private accent = new THREE.Color('#d4f044');
  private visible = 0;
  private visibleTarget = 0;
  private readonly basePos = new THREE.Vector3(0.18, 0.0, 1.0);

  private pen: PenState3D = {
    nx: 0.5,
    ny: 0.5,
    pressure: 0,
    tiltX: 0,
    tiltY: 0,
    tip: false,
    barrel: false,
    secondBarrel: false,
    eraser: false,
    inRange: false,
  };
  private penSmoothX = 0.06;
  private penSmoothY = -0.02;
  private penActive = 0;

  constructor() {
    this.group.position.copy(this.basePos);

    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(2.0, 1.25),
      new THREE.MeshBasicMaterial({
        map: makeBlobShadowTexture(),
        transparent: true,
        depthWrite: false,
        opacity: 0.7,
      }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.002;
    this.group.add(shadow);

    const body = extrudeSlab(makeTabletBodyShape(0.86, 1.02), 0.05, '#313742');
    const under = extrudeSlab(makeTabletBodyShape(0.88, 1.04), 0.03, '#191d24', -0.03);
    this.group.add(under, body);

    // Active drawing surface, slightly recessed into the top face.
    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(this.surfaceW, this.surfaceD),
      new THREE.MeshBasicMaterial({ color: '#4a525f' }),
    );
    surface.rotation.x = -Math.PI / 2;
    surface.position.set(this.surfaceCx, 0.0505, this.surfaceCz);
    this.group.add(surface);

    // ExpressKeys on the left bezel.
    for (let i = 0; i < 4; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: '#59616f' });
      const key = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.012, 0.10), mat);
      key.position.set(-0.76, 0.0525, -0.30 + i * 0.19);
      this.group.add(key);
      this.keyMats.push(mat);
      this.keyPositions.push(key.position.clone());
    }

    // Pressure meter on the lower right bezel.
    const meterWell = new THREE.Mesh(
      new THREE.BoxGeometry(0.30, 0.008, 0.035),
      new THREE.MeshBasicMaterial({ color: '#22262e' }),
    );
    meterWell.position.set(0.52, 0.0515, 0.42);
    this.group.add(meterWell);
    this.meterMat = new THREE.MeshBasicMaterial({ color: '#d4f044' });
    // The fill has to be exactly as wide as the well: the growth code anchors
    // its left edge and scales it, so a wider bar would shoot past the bezel
    // and out of the tablet body.
    this.meterFill = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.01, 0.026), this.meterMat);
    this.meterFill.position.set(0.52, 0.0525, 0.42);
    this.meterFill.scale.set(0.001, 1, 1);
    this.group.add(this.meterFill);

    // USB-C port on the far edge.
    const usb = new THREE.Mesh(
      new THREE.BoxGeometry(0.075, 0.014, 0.02),
      new THREE.MeshBasicMaterial({ color: '#191d24' }),
    );
    usb.position.set(0, 0.05, -0.52);
    this.group.add(usb);

    // Braided cable leaving the far edge.
    const cableMat = new THREE.MeshBasicMaterial({ color: '#20252d' });
    this.cable = new TaperTube3D(18, 6, cableMat, 3);
    this.cable.update(
      (t, out) => {
        out.set(
          mix(0.18, -0.55, t) + Math.sin(t * 2.4) * 0.05,
          mix(0.05, 0.012, t),
          mix(-0.52, -0.86, t) - Math.sin(t * Math.PI) * 0.1,
        );
      },
      () => 0.014,
    );
    this.group.add(this.cable.mesh);

    // ---- Stylus ----
    this.penGroup.position.y = 0.05;
    this.group.add(this.penGroup);

    this.penBarrelMat = new THREE.MeshBasicMaterial({ color: '#767f8e' });
    this.penBarrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.026, 0.032, 0.46, 18),
      this.penBarrelMat,
    );
    this.penBarrel.rotation.z = Math.PI / 2;
    this.penBarrel.position.set(0.255, 0.03, 0);
    this.penGroup.add(this.penBarrel);

    this.penRingMat = new THREE.MeshBasicMaterial({ color: '#ff7b3b' });
    this.penRing = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.024, 18), this.penRingMat);
    this.penRing.rotation.z = Math.PI / 2;
    this.penRing.position.set(0.115, 0.03, 0);
    this.penGroup.add(this.penRing);

    this.penNibMat = new THREE.MeshBasicMaterial({ color: '#e7e9ee' });
    this.penNib = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.05, 16), this.penNibMat);
    this.penNib.rotation.z = Math.PI / 2;
    this.penNib.position.set(0.025, 0.03, 0);
    this.penGroup.add(this.penNib);

    this.penCapMat = new THREE.MeshBasicMaterial({ color: '#4a525f' });
    this.penCap = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), this.penCapMat);
    this.penCap.position.set(0.485, 0.03, 0);
    this.penGroup.add(this.penCap);

    // Barrel buttons sit just above the grip ring.
    for (let i = 0; i < 2; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: '#22262e' });
      const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.02, 12), mat);
      btn.rotation.z = Math.PI / 2;
      btn.position.set(0.185 + i * 0.08, 0.062, 0);
      this.penGroup.add(btn);
      this.penButtonMats.push(mat);
    }

    const glowMat = new THREE.SpriteMaterial({
      map: makeGlowTexture(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
    });
    this.penGlow = new THREE.Sprite(glowMat);
    this.penGlow.scale.set(0.16, 0.16, 1);
    this.penGlow.renderOrder = 20;
    this.penGroup.add(this.penGlow);
  }

  public setAccentColor(hex: string): void {
    this.accent.set(hex);
  }

  public setVisible(v: number): void {
    this.visibleTarget = v;
  }

  public setPen(state: Partial<PenState3D>): void {
    Object.assign(this.pen, state);
  }

  public setKeys(mask: number): void {
    for (let i = 0; i < 4; i++) {
      const on = (mask & (1 << i)) !== 0;
      this.keyMats[i].color.set(on ? '#d4f044' : '#59616f');
    }
  }

  public update(dt: number): void {
    this.visible += (this.visibleTarget - this.visible) * approach(12, dt);
    this.group.visible = this.visible > 0.02;

    const wantActive = this.pen.inRange || this.pen.tip ? 1 : 0;
    this.penActive += (wantActive - this.penActive) * approach(wantActive ? 14 : 3.2, dt);

    // Nib position on the active surface.
    const tx = this.surfaceCx + (clamp(this.pen.nx, 0, 1) - 0.5) * this.surfaceW * 0.92;
    const tz = this.surfaceCz + (clamp(this.pen.ny, 0, 1) - 0.5) * this.surfaceD * 0.82;
    this.penSmoothX += (tx - this.penSmoothX) * approach(26, dt);
    this.penSmoothY += (tz - this.penSmoothY) * approach(26, dt);

    // The stylus stands on its nib and leans back toward the cat, modulated by
    // the real tilt the tablet reports.
    const lean = 0.62 - this.pen.tiltY * 0.35;
    const yaw = this.pen.tiltX * 0.5;
    this.penGroup.position.set(this.penSmoothX, 0.05, this.penSmoothY);
    this.penGroup.rotation.set(0, yaw, 0);
    this.penGroup.rotateZ(Math.PI / 2 - lean * 0.55);
    this.penGroup.rotateX(-lean * 0.5);
    this.penGroup.visible = this.penActive > 0.03;

    const pressure = clamp(this.pen.pressure, 0, 1);
    this.penNibMat.color.set(this.pen.eraser ? '#ffd0e0' : '#e7e9ee');
    this.penCapMat.color.set(this.pen.eraser ? '#ff7bb0' : '#4a525f');
    this.penRingMat.color.set('#ff7b3b');
    this.penButtonMats[0].color.set(this.pen.barrel ? '#ff7b3b' : '#22262e');
    this.penButtonMats[1].color.set(this.pen.secondBarrel ? '#7ac7ff' : '#22262e');

    const glowMat = this.penGlow.material as THREE.SpriteMaterial;
    glowMat.opacity = this.penActive * (0.18 + pressure * 0.42);
    this.penGlow.scale.setScalar(0.13 + pressure * 0.13);

    // Pressure meter fills with the live pen pressure.
    this.meterMat.color.copy(this.accent);
    const fill = Math.max(0.001, pressure);
    this.meterFill.scale.x += (fill - this.meterFill.scale.x) * approach(16, dt);
    this.meterFill.position.x = 0.52 - (0.30 * (1 - this.meterFill.scale.x)) / 2;
  }

  /** World position of an ExpressKey, so a badge can float above it. */
  public keyWorld(index: number, out = new THREE.Vector3()): THREE.Vector3 {
    this.group.updateMatrixWorld(true);
    const local = this.keyPositions[index];
    if (!local) return out.set(0, 0.05, 0).applyMatrix4(this.group.matrixWorld);
    return out.copy(local).applyMatrix4(this.group.matrixWorld);
  }

  /** True while the stylus is hovering over or touching the surface. */
  public isPenActive(): boolean {
    return this.pen.inRange || this.pen.tip;
  }

  /** Where the nib touches the surface. */
  public penTipWorld(out = new THREE.Vector3()): THREE.Vector3 {
    this.group.updateMatrixWorld(true);
    return out.set(0, 0.03, 0).applyMatrix4(this.penGroup.matrixWorld);
  }

  /** Where the cat's paw grabs the stylus. */
  public penGripWorld(out = new THREE.Vector3()): THREE.Vector3 {
    this.group.updateMatrixWorld(true);
    return out.set(0.2, 0.03, 0).applyMatrix4(this.penGroup.matrixWorld);
  }
}

/**
 * Owns both 3D peripheral models and switches between them. The keyboard and
 * the mouse stay on the 2D/3D desk scene, so the desk hides them while a
 * peripheral owns the foreground.
 */
export class Peripherals3D {
  public readonly gamepad = new Gamepad3D();
  public readonly tablet = new Tablet3D();
  public readonly group = new THREE.Group();

  private mode: PeripheralMode = 'keyboard';

  constructor(scene: THREE.Scene) {
    this.group.add(this.gamepad.group, this.tablet.group);
    scene.add(this.group);
    this.setMode('keyboard');
  }

  public setMode(mode: PeripheralMode): void {
    this.mode = mode;
    this.gamepad.setVisible(mode === 'gamepad' ? 1 : 0);
    this.tablet.setVisible(mode === 'tablet' ? 1 : 0);
  }

  public getMode(): PeripheralMode {
    return this.mode;
  }

  public setAccentColors(primary: string, secondary: string): void {
    this.gamepad.setAccentColor(primary);
    this.tablet.setAccentColor(secondary);
  }

  public update(dt: number, elapsed: number): void {
    this.gamepad.update(dt, elapsed);
    this.tablet.update(dt);
  }
}
