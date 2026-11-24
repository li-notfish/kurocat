import {
  KEYBOARD_KEYS_65,
  KEYBOARD_KEYS_108,
  getKeyboardLayout,
  type KeySpec,
  type KeyboardLayoutId,
  formatBubbleForVk,
  resolveKeyByVk,
} from './keyboardLayout';
import { catAudio } from './audio';
import { resolveCustomSkin, type CatSkinConfig, type ResolvedSkin } from './catSkins';
import { DaFeiYuRenderer, type DaFeiYuLayout } from './dafeiyuRenderer';

export const LOGICAL_W = 420;
export const LOGICAL_H = 440;
export type CatBreed = 'black' | 'ragdoll' | 'dafeiyu';
export type KeyboardOrientation = 'cat' | 'viewer';
export type TailKeyMode = 'smart' | 'custom' | 'edge' | 'off';

export const DEFAULT_TAIL_KEY_IDS: readonly string[] = ['enter', 'space', 'bs', 'esc'];

export const TAIL_KEY_PRESETS = {
  office: {
    label: '回车空格',
    ids: ['enter', 'space', 'bs', 'esc'] as readonly string[],
  },
  rightFn: {
    label: '方向/小键盘',
    ids: [
      'up', 'down', 'left', 'right', 'enter', 'bs', 'rshift',
      'ins', 'home', 'pgup', 'del', 'end', 'pgdn',
      'numlk', 'np_div', 'np_mul', 'np_sub', 'np_add', 'np_ent', 'np_dot',
      'np_0', 'np_1', 'np_2', 'np_3', 'np_4', 'np_5', 'np_6', 'np_7', 'np_8', 'np_9',
    ] as readonly string[],
  },
  edgeMods: {
    label: '外侧功能键',
    ids: ['esc', 'tab', 'caps', 'lshift', 'lctrl', 'rshift', 'enter', 'bs'] as readonly string[],
  },
} as const;

const EDGE_PROTECTED_WASD_IDS = new Set(['q', 'w', 'e', 'a', 's', 'd', 'z', 'x', 'c', 'space']);
export type DevicePreviewMode = 'auto' | 'keyboard' | 'tablet' | 'gamepad';
type ForegroundDevice = Exclude<DevicePreviewMode, 'auto'>;

// A tablet keeps the foreground while the pen is really being used. A key
// press inside this window belongs to the tablet (an ExpressKey), not to the
// keyboard.
const TABLET_ACTIVITY_WINDOW_MS = 1400;
// The keyboard hand-over is deferred by this long so a late ExpressKey HID
// report can still claim the foreground before the keyboard model takes over.
const TABLET_KEY_SWITCH_GRACE_MS = 220;
// A dropped range report must not blank the nib either: the current state is
// held for this long before the pen is released.
const TABLET_RANGE_GRACE_MS = 400;

/**
 * Stable hash, so the same key always lands on the same peripheral control.
 * The 3D engine uses it too, so both renderers agree on the mapping.
 */
export function tailTargetHash(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** D-pad directions the tail may strike: they sit on the cat's side of the pad. */
export const TAIL_PAD_BUTTONS = [16, 13, 14, 15];

interface Vec2 {
  x: number;
  y: number;
}

interface SmearFrame {
  sx: number;
  sy: number;
  px: number;
  py: number;
  alpha: number;
}

export type CatHitZone = 'nose' | 'chin' | 'tail' | 'head' | 'body' | null;
export type PeekEdge = 'none' | 'left' | 'right';

type PawMode =
  | 'idle'
  | 'curled'
  | 'poke'
  | 'mouse'
  | 'groom'
  | 'stretch'
  | 'knead'
  | 'scruff'
  | 'peek'
  | 'pad'
  | 'pen';

interface PawState {
  side: 'left' | 'right';
  shoulderNormY: number; // vertical fraction along spine (0=ear tips, 1=base)
  shoulderHalfX: number;
  pos: Vec2;
  vel: Vec2;
  target: Vec2;
  mode: PawMode;
  idleWeight: number;
  curlWeight: number;
  pokeTime: number;
  impactSquash: number;
  lastActiveAt: number;
  smears: SmearFrame[];
}

interface KeyBubble {
  id: number;
  label: string;
  isSpace: boolean;
  x: number;
  targetX: number;
  y: number;
  targetY: number;
  rot: number;
  createdAt: number;
  lifetime: number;
}

interface PadBubble {
  id: number;
  label: string;
  accent: string;
  x: number;
  y: number;
  driftX: number;
  rot: number;
  createdAt: number;
  lifetime: number;
}

interface TabletBadge {
  id: number;
  label: string;
  accent: string;
  x: number;
  y: number;
  createdAt: number;
  lifetime: number;
}

interface KeyAnim {
  pressed: boolean;
  pressAmount: number;
  lastHitAt: number;
}

/**
 * 240Hz sub-stepped second-order damped harmonic spring.
 * Damping < 1 creates subtle organic weight & follow-through overshoot at any frame rate.
 */
class Spring {
  public x: number;
  public v = 0;
  public hz: number;
  public damping: number;

  constructor(initial = 0, hz = 2.4, damping = 0.72) {
    this.x = initial;
    this.hz = hz;
    this.damping = damping;
  }

  public step(target: number, dt: number): number {
    const w = 2 * Math.PI * this.hz;
    const n = Math.max(1, Math.ceil(dt * 240));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (w * w * (target - this.x) - 2 * this.damping * w * this.v) * h;
      this.x += this.v * h;
    }
    return this.x;
  }

  public kick(dv: number): void {
    this.v += dv;
  }

  public set(val: number): void {
    this.x = val;
    this.v = 0;
  }
}

function parseHexRgb(color: string): [number, number, number] | null {
  const c = color.trim();
  const hex = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }
  const rgb = c.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (rgb) {
    return [parseFloat(rgb[1]), parseFloat(rgb[2]), parseFloat(rgb[3])];
  }
  return null;
}

function blendHex(colorA: string, colorB: string, t: number): string {
  const a = parseHexRgb(colorA);
  const b = parseHexRgb(colorB);
  if (!a || !b) return colorA;
  const u = Math.max(0, Math.min(1, t));
  const r = Math.round(a[0] + (b[0] - a[0]) * u);
  const g = Math.round(a[1] + (b[1] - a[1]) * u);
  const bl = Math.round(a[2] + (b[2] - a[2]) * u);
  return `rgb(${r}, ${g}, ${bl})`;
}

function colorWithAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const c = color.trim();
  const hex = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
  }
  const rgb = c.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (rgb) {
    const baseA = rgb[4] !== undefined ? parseFloat(rgb[4]) : 1;
    return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${(baseA * a).toFixed(3)})`;
  }
  return c;
}

interface CatFxParticle {
  kind: 'bang' | 'dust' | 'z' | 'heart' | 'sparkle' | 'sneeze';
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  createdAt: number;
  lifetime: number;
}

interface IdleFidget {
  kind: 'tilt' | 'ear' | 'slowBlink' | 'look' | 'tail' | 'doze' | 'yawn' | 'stretch' | 'groom' | 'knead';
  t0: number;
  dur: number;
  side: -1 | 1;
}
interface GamepadVisualState {
  name: string;
  buttons: number[];
  triggers: number[];
  axes: number[];
  held: boolean[];
  visible: number;
  lastActiveAt: number;
}

const GAMEPAD_BUTTON_SPECS: Record<
  number,
  { label: string; accent: string; x: number; y: number }
> = {
  0: { label: 'A', accent: '#66d17a', x: -68, y: 16 },
  1: { label: 'B', accent: '#ff6b6b', x: -82, y: 2 },
  2: { label: 'Y', accent: '#ffd34d', x: -68, y: -12 },
  3: { label: 'X', accent: '#5aa9ff', x: -54, y: 2 },
  4: { label: 'LT', accent: '#c7ccd4', x: -83, y: -34 },
  5: { label: 'LB', accent: '#c7ccd4', x: -74, y: -27 },
  6: { label: 'RT', accent: '#c7ccd4', x: 83, y: -34 },
  7: { label: 'RB', accent: '#c7ccd4', x: 74, y: -27 },
  8: { label: 'View', accent: '#c7ccd4', x: 14, y: -25 },
  9: { label: 'Menu', accent: '#c7ccd4', x: 0, y: -25 },
  10: { label: 'Guide', accent: '#c7ccd4', x: 0, y: -3 },
  11: { label: 'L3', accent: '#c7ccd4', x: -26, y: 8 },
  12: { label: 'R3', accent: '#c7ccd4', x: 64, y: 8 },
  13: { label: 'D↑', accent: '#a8b0bb', x: 30, y: 21 },
  14: { label: 'D↓', accent: '#a8b0bb', x: 30, y: -5 },
  15: { label: 'D←', accent: '#a8b0bb', x: 12, y: 8 },
  16: { label: 'D→', accent: '#a8b0bb', x: 38, y: 8 },
  17: { label: 'Share', accent: '#c7ccd4', x: -14, y: -25 },
  19: { label: 'P1', accent: '#c7ccd4', x: 48, y: 38 },
  20: { label: 'P2', accent: '#c7ccd4', x: 30, y: 44 },
  21: { label: 'P3', accent: '#c7ccd4', x: -22, y: 44 },
  22: { label: 'P4', accent: '#c7ccd4', x: -40, y: 38 },
};

// Exact measured pixel silhouette half-width profile from original video 0.3s (compact chubby sitting cat!)
// t = 0.0 (ear tips) -> t = 1.0 (bottom base flush on keyboard)
const BODY_SLICES: Array<{ t: number; hw: number }> = [
  { t: 0.12, hw: 49 }, // forehead / ear base
  { t: 0.21, hw: 56 }, // eye line
  { t: 0.30, hw: 60 }, // chubby cheeks widest
  { t: 0.38, hw: 52 }, // gentle neck indent
  { t: 0.47, hw: 54 }, // upper chest
  { t: 0.57, hw: 62 }, // mid chest
  { t: 0.68, hw: 70 }, // plump belly
  { t: 0.79, hw: 73 }, // widest soft thighs!
  { t: 0.90, hw: 69 }, // lower thigh curve
  { t: 0.97, hw: 58 }, // tapers softly inward at base!
  { t: 1.00, hw: 46 }, // cozy bottom rest
];

type RenderPacingTier = 'action' | 'ambient' | 'idle' | 'sleep';

const ACTION_RENDER_AFTER_MS = 2200;
const AMBIENT_RENDER_AFTER_MS = 1800;
const AMBIENT_FRAME_MS = 44;      // ~22.7 FPS (matches 33-45ms global cursor/mouse cadence)
const IDLE_FRAME_MS = 66;         // ~15.2 FPS (calm awake breathing & gentle tail sway)
const DEEP_SLEEP_FRAME_MS = 100;  // ~10.0 FPS (deep sleep loaf & slow floating Zzz)
const KEYBOARD_HIT_HALF_WIDTH_RATIO = 0.54;
const KEYBOARD_HIT_HALF_HEIGHT_RATIO = 0.56;
// A tail pat is a one-shot gesture (lift 24px, then slap down). Replaying it for every keystroke of a typing
// burst makes the tip buzz at the keystroke rate (~18 reversals/s), so only the first key of a burst lifts off.
const TAIL_PAT_WINDUP_GAP_MS = 260;
// drawTail() blends between a near swan-neck arch and a far hip sweep over ~173px of tip travel; blending it
// per keystroke flips the whole tail silhouette, so the blend factor is smoothed instead.
const TAIL_CROSS_BLEND_RATE = 9;

/** A frame that needs more than this counts as a stutter. */
const FRAME_WORK_BUDGET_MS = 20;
/** Gaps larger than this are the idle pause, not a stall. */
const IDLE_GAP_LIMIT_MS = 1000;

export class KuroCatEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private rafId: number | null = null;
  private idleFrameTimer: number | null = null;
  private pacingTier: RenderPacingTier = 'action';
  private directRafPrevMs = 0;
  private lastRenderMs = 0;
  private lastRenderPerfMs = 0;
  private vsyncMs = 16.67;
  private vsyncSamples = 0;
  private highRefreshHits = 0;
  private gameActive = false;
  private kbCacheCanvas: HTMLCanvasElement | null = null;
  private kbCacheKey = '';
  private lastActionAt = 0;
  private lastAmbientAt = 0;
  private lastTime = 0;
  private elapsed = 0;

  public showKeyBubbles = true;
  public privacyMode = false;
  public onAfterRender: (() => void) | null = null;
  /** Frames rendered since the app started. */
  public frameCount = 0;
  /** Frames that exceeded the frame budget since the last reset. */
  public longFrameCount = 0;
  /** Slowest frame since the last reset, in milliseconds. */
  public maxFrameWorkMs = 0;
  /** Largest gap between two frames since the last reset, in milliseconds. */
  public maxFrameGapMs = 0;
  public catBreed: CatBreed = 'black';
  public customSkin: ResolvedSkin | null = null;
  public keyboardLayout: KeyboardLayoutId = '65';
  public keyboardOrientation: KeyboardOrientation = 'cat';
  public tailKeyMode: TailKeyMode = 'smart';
  private tailKeyIdSet = new Set<string>(DEFAULT_TAIL_KEY_IDS);
  private tailPickerActive = false;
  private tailPickerSelection: ReadonlySet<string> | null = null;
  private tailPickerHoverId: string | null = null;
  private renderScale = 1.0;
  private chromaKeyBg: string | null = null;
  private embedded = false;
  private dafeiyu = new DaFeiYuRenderer();
  private catTail = {
    heldVks: new Set<number>(),
    targetX: 320,
    targetY: 345,
    tipX: 320,
    tipY: 250,
    reach: 0,
    hover: 0,
    tapAt: -10000,
    patAt: -10000,
    releaseAt: -10000,
    impactSquash: 0,
    active: false,
  };
  private tailCrossLeft = 0;
  private privacyClose = 0;
  private privacyTypingAt = -10000;
  private lastMouseNX = 0.5;
  private lastDt = 1 / 60;

  public setPrivacyMode(active: boolean): void {
    this.wakeAction();
    this.privacyMode = active;
    this.dafeiyu.onPrivacyModeChanged(active);
    if (active) {
      this.heldKeys.clear();
      this.catTail.heldVks.clear();
      this.catTailHeldAt.clear();
      this.catTail.active = false;
      this.bubbles.length = 0;
      for (const anim of this.keyAnims.values()) {
        anim.pressed = false;
        anim.pressAmount = 0;
      }
    }
  }

  public onPrivacyTyping(): void {
    this.privacyTypingAt = performance.now();
    this.wakeAction(this.privacyTypingAt);
    if (this.catBreed === 'dafeiyu') {
      this.dafeiyu.onPrivacyTyping();
    }
  }

  public setRenderScale(scale: number): void {
    this.renderScale = Math.max(0.2, Math.min(1.5, scale));
    this.wakeAction();
  }

  public setChromaKeyBg(hex: string | null): void {
    const next = typeof hex === 'string' && hex.trim() ? hex.trim() : null;
    if (this.chromaKeyBg === next) return;
    this.chromaKeyBg = next;
    this.kbCacheKey = '';
    this.wakeAction();
  }

  public getLogicalSize(): { w: number; h: number } {
    return { w: this.logicalW, h: this.logicalH };
  }

  public setTailKeyConfig(mode: TailKeyMode, keyIds: readonly string[]): void {
    const valid: TailKeyMode =
      mode === 'custom' || mode === 'edge' || mode === 'off' ? mode : 'smart';
    this.tailKeyMode = valid;
    this.tailKeyIdSet = new Set(
      (Array.isArray(keyIds) ? keyIds : []).map((id) => String(id).trim().toLowerCase()).filter(Boolean),
    );
    if (this.tailKeyMode === 'off') {
      this.catTail.active = false;
      this.catTail.heldVks.clear();
      this.catTailHeldAt.clear();
    }
    this.wakeAction();
  }

  public setTailPickerActive(active: boolean, selection?: ReadonlySet<string>): void {
    this.tailPickerActive = Boolean(active);
    this.tailPickerSelection = this.tailPickerActive ? selection ?? null : null;
    if (!this.tailPickerActive) {
      this.tailPickerHoverId = null;
    }
    this.wakeAction();
  }

  public setTailPickerHover(specId: string | null): void {
    if (this.tailPickerHoverId !== specId) {
      this.tailPickerHoverId = specId;
      this.wakeAction();
    }
  }

  private getTailTargetPoint(spec: KeySpec): Vec2 {
    // A peripheral in front hides the keyboard, so the tail strikes the
    // peripheral's own control instead of a position that is not there.
    const peripheral = this.peripheralTailTarget(spec.id);
    if (peripheral) return peripheral;
    if (spec.id === 'space') {
      const isCatFacing = this.keyboardOrientation === 'cat';
      const spaceU = isCatFacing
        ? spec.uStart + spec.uWidth * 0.24
        : spec.uStart + spec.uWidth * 0.76;
      const rY = spec.rowY ?? spec.row;
      return this.clampToKeyboardSurface(this.projectKeyboardPoint(spaceU, rY + 0.50));
    }
    return this.clampToKeyboardSurface(this.getKeyWorldCenter(spec));
  }

  /**
   * The peripheral control the tail strikes while a tablet or a gamepad owns
   * the foreground. Returns null while the keyboard is the one in front.
   */
  private peripheralTailTarget(keyId: string): Vec2 | null {
    if (this.forcedDevice === 'tablet') {
      const layout = this.getTabletLayout();
      const index = tailTargetHash(keyId) % 4;
      this.tabletTailKeys[index] = true;
      return {
        x: layout.cx - layout.w * 0.425,
        y: layout.cy - layout.h * 0.24 + index * layout.h * 0.125,
      };
    }
    if (this.forcedDevice === 'gamepad') {
      const layout = this.getGamepadLayout();
      const button = TAIL_PAD_BUTTONS[tailTargetHash(keyId) % TAIL_PAD_BUTTONS.length];
      const buttonSpec = GAMEPAD_BUTTON_SPECS[button];
      if (!buttonSpec) return null;
      return {
        x: layout.cx + buttonSpec.x * layout.scale,
        y: layout.cy - buttonSpec.y * layout.scale,
      };
    }
    return null;
  }

  /** Lets go of the ExpressKeys the tail was holding down. */
  private clearTabletTailKeys(): void {
    for (let i = 0; i < 4; i++) this.tabletTailKeys[i] = false;
  }

  public previewTailTap(specId: string): void {
    const layout = getKeyboardLayout(this.keyboardLayout);
    const spec = layout.keys.find((k) => k.id === specId);
    if (!spec) return;
    const now = performance.now();
    this.wakeCat(now);
    const anim = this.keyAnims.get(spec.id);
    if (anim) {
      anim.pressAmount = 1;
      anim.lastHitAt = now;
    }
    const targetPt = this.getTailTargetPoint(spec);
    if (this.catBreed === 'dafeiyu') {
      this.dafeiyu.triggerTailPreview(targetPt, this.buildDaFeiYuLayout());
      return;
    }
    if (!this.catTail.active && this.catTail.reach < 0.08) {
      const hipRight = this.spinePoint(0.84, 0);
      this.catTail.tipX = hipRight.x + 126;
      this.catTail.tipY = hipRight.y - 37;
    }
    this.catTail.active = true;
    this.catTail.targetX = targetPt.x;
    this.catTail.targetY = targetPt.y;
    this.catTail.tapAt = now;
    this.catTail.patAt = now;
    this.catTail.releaseAt = now + 220;
    this.catTail.impactSquash = 1.0;
    this.kbBounce = Math.min(1, this.kbBounce + 0.35);
    this.squashSpring.kick(0.9);
  }

  private getViewportTransform(): { offsetX: number; offsetY: number; uniformScale: number } {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    if (this.embedded) {
      const baseFit = Math.min((cw * 0.86) / this.logicalW, (ch * 0.86) / this.logicalH);
      const effectiveMul =
        this.renderScale <= 1.0 ? this.renderScale : 1.0 + (this.renderScale - 1.0) * 0.30;
      const uniformScale = baseFit * effectiveMul;
      const drawW = this.logicalW * uniformScale;
      const drawH = this.logicalH * uniformScale;
      return {
        offsetX: (cw - drawW) * 0.5,
        offsetY: (ch - drawH) * 0.52,
        uniformScale,
      };
    }
    const cssW = Math.max(1, window.innerWidth);
    const dpr = cw / cssW;
    const fitScale = Math.min(cw / this.logicalW, ch / this.logicalH);
    const uniformScale = Math.min(fitScale, this.renderScale * dpr);
    const drawW = this.logicalW * uniformScale;
    const drawH = this.logicalH * uniformScale;
    return {
      offsetX: cw - drawW,
      offsetY: ch - drawH,
      uniformScale,
    };
  }

  public getKeyboardClientBounds(): DOMRect {
    const rect = this.canvas.getBoundingClientRect();
    const { offsetX, offsetY, uniformScale } = this.getViewportTransform();
    const scaleX = rect.width / this.canvas.width;
    const scaleY = rect.height / this.canvas.height;
    const sin = Math.abs(Math.sin(this.kbTiltRad));
    const cos = Math.abs(Math.cos(this.kbTiltRad));
    const halfWidth = this.kbWidth * KEYBOARD_HIT_HALF_WIDTH_RATIO;
    const halfHeight = this.kbHeight * KEYBOARD_HIT_HALF_HEIGHT_RATIO;
    const boundX = (halfWidth * cos + halfHeight * sin) * uniformScale;
    const boundY = (halfWidth * sin + halfHeight * cos) * uniformScale;
    const centerX = offsetX + this.kbCenterX * uniformScale;
    const centerY = offsetY + this.kbCenterY * uniformScale;
    return new DOMRect(
      rect.left + (centerX - boundX) * scaleX,
      rect.top + (centerY - boundY) * scaleY,
      2 * boundX * scaleX,
      2 * boundY * scaleY,
    );
  }

  public hitTestKeyAtClientPoint(clientX: number, clientY: number): KeySpec | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const canvasX = (clientX - rect.left) * scaleX;
    const canvasY = (clientY - rect.top) * scaleY;
    const { offsetX, offsetY, uniformScale } = this.getViewportTransform();
    if (uniformScale <= 0.001) return null;

    const lx = (canvasX - offsetX) / uniformScale;
    const ly = (canvasY - offsetY) / uniformScale;

    const dx = lx - this.kbCenterX;
    const dy = ly - (this.kbCenterY + this.kbBounce * 1.1 + this.deskHopY);
    const cos = Math.cos(-this.kbTiltRad);
    const sin = Math.sin(-this.kbTiltRad);
    const kx = dx * cos - dy * sin;
    const ky = dx * sin + dy * cos;

    const padX = 7;
    const padY = 6;
    const innerW = this.kbWidth - padX * 2;
    const innerH = this.kbHeight - padY * 2;
    if (
      Math.abs(kx) > this.kbWidth * KEYBOARD_HIT_HALF_WIDTH_RATIO ||
      Math.abs(ky) > this.kbHeight * KEYBOARD_HIT_HALF_HEIGHT_RATIO
    ) {
      return null;
    }

    const layout = getKeyboardLayout(this.keyboardLayout);
    const isCatFacing = this.keyboardOrientation === 'cat';
    const is108 = this.keyboardLayout === '108';
    const rowH = innerH / layout.totalRows;
    const unitW = innerW / layout.totalUnits;
    const gap = is108 ? 0.85 : 0.9;
    const hitPad = 0.75;

    for (const key of layout.keys) {
      const rY = key.rowY ?? key.row;
      const rSpan = key.rowSpan ?? 1;
      const screenRowTop = isCatFacing ? layout.totalRows - (rY + rSpan) : rY;
      const screenUStart = isCatFacing
        ? layout.totalUnits - (key.uStart + key.uWidth)
        : key.uStart;
      const rowCenterFrac = (screenRowTop + rSpan * 0.5) / layout.totalRows;
      const depthScale = 0.94 + rowCenterFrac * 0.09;

      const rawX = -innerW / 2 + screenUStart * unitW + gap * 0.5;
      const rawW = key.uWidth * unitW - gap;
      const x = rawX * depthScale;
      const w = rawW * depthScale;
      const y = -innerH / 2 + screenRowTop * rowH + gap * 0.5;
      const h = rSpan * rowH - gap - 0.8;

      if (
        kx >= x - hitPad &&
        kx <= x + w + hitPad &&
        ky >= y - hitPad &&
        ky <= y + h + hitPad
      ) {
        return key;
      }
    }
    return null;
  }

  public clientToLogical(clientX: number, clientY: number): Vec2 | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const canvasX = (clientX - rect.left) * scaleX;
    const canvasY = (clientY - rect.top) * scaleY;
    const { offsetX, offsetY, uniformScale } = this.getViewportTransform();
    if (uniformScale <= 0.001) return null;
    const rawX = (canvasX - offsetX) / uniformScale;
    const rawY = (canvasY - offsetY) / uniformScale;
    if (this.peekAmount > 0.01) {
      // Inverse of peek render transform: translate(pivot+tx, pivot+ty) * rotate(rot) * translate(-pivot)
      const { tx, ty, rot, pivotX, pivotY } = this.peekTransform;
      const dx = rawX - (pivotX + tx);
      const dy = rawY - (pivotY + ty);
      const cos = Math.cos(-rot);
      const sin = Math.sin(-rot);
      return {
        x: pivotX + dx * cos - dy * sin,
        y: pivotY + dx * sin + dy * cos,
      };
    }
    return { x: rawX, y: rawY };
  }

  public setPeekEdge(edge: PeekEdge): void {
    const next: PeekEdge = edge === 'left' || edge === 'right' ? edge : 'none';
    const hadPreview = this.peekPreviewEdge !== 'none';
    this.peekPreviewEdge = 'none';
    if (next !== this.peekEdge) {
      this.peekEdge = next;
      if (next !== 'none') {
        this.peekVisualEdge = next;
        this.isCross = false;
        this.annoy = 0;
        this.idleAct = null;
        this.asleep = false;
        this.peekSpring.kick(1.4);
      } else {
        this.squashSpring.kick(2.6);
        catAudio.playSoftLand();
      }
      this.wakeAction();
    } else if (hadPreview) {
      this.wakeAction();
    }
  }

  /** Live drag preview: cat preemptively tucks desk & peeks its head while still dragged at a screen edge (Option 2, no neon bar!). */
  public setPeekPreview(edge: PeekEdge): void {
    const next: PeekEdge = edge === 'left' || edge === 'right' ? edge : 'none';
    if (next !== this.peekPreviewEdge) {
      this.peekPreviewEdge = next;
      if (next !== 'none') {
        this.peekVisualEdge = next;
        this.earPerkSpring.kick(1.6);
      }
      this.wakeAction();
    }
  }

  public getPeekEdge(): PeekEdge {
    return this.peekEdge;
  }

  private computePeekTransform2D(): { tx: number; ty: number; rot: number; pivotX: number; pivotY: number } {
    const p = Math.max(0, Math.min(1, this.peekAmount));
    const isDafeiyu = this.catBreed === 'dafeiyu';
    const headY = this.catTopY + 0.24 * this.catHeight;
    const pivotX = isDafeiyu ? (this.keyboardLayout === '108' ? 268 : 192) : this.catCenterX;
    const pivotY = isDafeiyu ? 176 : headY;
    if (p <= 0.001) {
      return { tx: 0, ty: 0, rot: 0, pivotX, pivotY };
    }
    const { offsetX, offsetY, uniformScale } = this.getViewportTransform();
    const s = Math.max(0.001, uniformScale);
    const leftEdge = -offsetX / s;
    const rightEdge = (this.canvas.width - offsetX) / s;
    const topEdge = -offsetY / s;
    const bottomEdge = (this.canvas.height - offsetY) / s;
    const midY = (topEdge + bottomEdge) * 0.5;
    const extraPop = this.peekHover * 14;
    const edgeInset = isDafeiyu ? 64 : 44;
    const tiltRad = isDafeiyu ? 1.18 : 1.28;

    let goalTx = 0;
    let goalTy = 0;
    let goalRot = 0;
    if (this.peekVisualEdge === 'left') {
      // Sideways wall-peek from the left edge: torso tucks cleanly off-edge, ONLY head, BOTH ears/hood & gripping paws/hands show!
      goalTx = leftEdge + edgeInset + extraPop - pivotX;
      goalTy = midY - pivotY;
      goalRot = tiltRad;
    } else {
      // Mirrored sideways wall-peek from the right edge!
      goalTx = rightEdge - edgeInset - extraPop - pivotX;
      goalTy = midY - pivotY;
      goalRot = -tiltRad;
    }
    return {
      tx: goalTx * p,
      ty: goalTy * p,
      rot: goalRot * p,
      pivotX,
      pivotY,
    };
  }

  /** Transform a cat-local logical point into visible viewport CSS pixels (accounts for peek edge transform). */
  public logicalToCssPoint(lx: number, ly: number): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    let vx = lx;
    let vy = ly;
    if (this.peekAmount > 0.01) {
      const { tx, ty, rot, pivotX, pivotY } = this.peekTransform;
      const dx = lx - pivotX;
      const dy = ly - pivotY;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      vx = pivotX + tx + dx * cos - dy * sin;
      vy = pivotY + ty + dx * sin + dy * cos;
    }
    const { offsetX, offsetY, uniformScale } = this.getViewportTransform();
    const cx = offsetX + vx * uniformScale;
    const cy = offsetY + vy * uniformScale;
    return {
      x: (cx / Math.max(1, this.canvas.width)) * rect.width,
      y: (cy / Math.max(1, this.canvas.height)) * rect.height,
    };
  }

  public getCatHitZonesLogical(): {
    nose: { x: number; y: number; rx: number; ry: number };
    chin: { x: number; y: number; rx: number; ry: number };
    head: { x: number; y: number; rx: number; ry: number };
    body: { x: number; y: number; rx: number; ry: number };
    tailPts: Vec2[];
  } {
    if (this.catBreed === 'dafeiyu') {
      const pivotX = this.keyboardLayout === '108' ? 268 : 192;
      return {
        nose: { x: pivotX, y: 204, rx: 18, ry: 15 },
        chin: { x: pivotX, y: 232, rx: 32, ry: 18 },
        head: { x: pivotX, y: 176, rx: 94, ry: 104 },
        body: { x: pivotX, y: 288, rx: 74, ry: 60 },
        tailPts: [],
      };
    }
    const breath = Math.sin(this.breathPhase) * (1.0 + this.sleepAmount * 0.65);
    const headPt = this.spinePoint(0.24, breath);
    const wShift = this.faceTurnX * 0.72;
    const cos = Math.cos(this.headTilt);
    const sin = Math.sin(this.headTilt);
    const rotHead = (lx: number, ly: number): Vec2 => ({
      x: headPt.x + lx * cos - ly * sin,
      y: headPt.y + lx * sin + ly * cos,
    });
    const noseC = rotHead(wShift, 11);
    const chinC = rotHead(wShift * 0.75, 41);
    const headC = rotHead(0, -14);
    const torsoC = this.spinePoint(0.72, breath);
    return {
      nose: { x: noseC.x, y: noseC.y, rx: 20, ry: 17 },
      chin: { x: chinC.x, y: chinC.y, rx: 35, ry: 19 },
      head: { x: headC.x, y: headC.y, rx: 58, ry: 38 },
      body: { x: torsoC.x, y: torsoC.y, rx: 68, ry: 56 },
      tailPts: this.liveTailCurvePts,
    };
  }

  public hitTestCatZoneLogical(lx: number, ly: number): CatHitZone {
    if (this.catBreed === 'dafeiyu') {
      if (this.peekAmount > 0.35) {
        const pivotX = this.keyboardLayout === '108' ? 268 : 192;
        const pivotY = 176;
        const dx = (lx - pivotX) / 94;
        const dy = (ly - pivotY) / 104;
        if (dx * dx + dy * dy <= 1.0) {
          return 'head';
        }
      }
      return null;
    }
    const z = this.getCatHitZonesLogical();
    const inEllipse = (c: { x: number; y: number; rx: number; ry: number }) => {
      const dx = (lx - c.x) / c.rx;
      const dy = (ly - c.y) / c.ry;
      return dx * dx + dy * dy <= 1.0;
    };
    if (inEllipse(z.nose)) return 'nose';
    if (this.peekAmount < 0.55) {
      for (const pt of z.tailPts) {
        if (Math.hypot(lx - pt.x, ly - pt.y) <= 23) {
          return 'tail';
        }
      }
    }
    if (inEllipse(z.chin)) return 'chin';
    if (inEllipse(z.head)) return 'head';
    if (inEllipse(z.body)) return 'body';
    return null;
  }

  public hitTestCatZoneAtClientPoint(clientX: number, clientY: number): CatHitZone {
    const pt = this.clientToLogical(clientX, clientY);
    if (!pt) return null;
    return this.hitTestCatZoneLogical(pt.x, pt.y);
  }

  public onCatTapAtClientPoint(clientX: number, clientY: number): CatHitZone {
    const zone = this.hitTestCatZoneAtClientPoint(clientX, clientY);
    if (!zone || this.privacyMode) return zone;
    if (zone === 'nose') {
      this.triggerBoopDemo();
    } else if (zone === 'tail') {
      this.triggerTailPokeDemo();
    } else if (zone === 'chin') {
      this.triggerChinScratchDemo(1700);
    } else if (zone === 'head') {
      this.wakeCat(performance.now(), 'gentle');
      this.earTwitchLeft = 1;
      this.earTwitchRight = 0.8;
      this.petEnergy = Math.max(this.petEnergy, 0.55);
      this.squashSpring.kick(1.2);
    } else if (zone === 'body') {
      this.wakeCat(performance.now(), 'gentle');
      this.squashSpring.kick(1.8);
      if (Math.random() < 0.5) this.earTwitchLeft = 1;
      else this.earTwitchRight = 1;
    }
    return zone;
  }

  public setDragging(dragging: boolean, velX = 0): void {
    const now = performance.now();
    const wasActive = this.isDragging || now < this.scruffDemoUntil;
    this.isDragging = Boolean(dragging);
    if (dragging) {
      this.scruffDemoUntil = -10000;
      this.wakeCat(now, 'gentle');
      this.wakeAt = -10000;
      this.isCross = false;
      this.annoy = 0;
      this.idleAct = null;
      this.curiousUntil = -10000;
      this.scruffDragVelX = Math.max(-2.8, Math.min(2.8, velX));
      if (!wasActive) {
        this.scruffSpring.kick(2.6);
        this.scruffSwingSpring.kick((Math.random() < 0.5 ? -1 : 1) * 1.9);
      }
      this.wakeAction(now);
    } else {
      this.scruffDemoUntil = -10000;
      this.scruffDragVelX = 0;
      if (wasActive && this.scruffAmount > 0.22) {
        this.onScruffLand(now);
      }
      this.wakeAction(now);
    }
  }

  public updateDragVelocity(velX: number): void {
    if (!this.isDragging) return;
    const clamped = Math.max(-2.8, Math.min(2.8, velX));
    this.scruffDragVelX = this.scruffDragVelX * 0.40 + clamped * 0.60;
    this.scruffSwingSpring.kick(-clamped * 2.1);
    this.wakeAction();
  }

  private onScruffLand(now: number): void {
    this.wakeAction(now);
    this.squashSpring.kick(4.6);
    this.deskHopSpring.kick(-16);
    catAudio.playSoftLand();
    const basePt = this.spinePoint(1.0, 0);
    for (const s of [-1, 1] as const) {
      this.fxParticles.push({
        kind: 'dust',
        x: basePt.x + s * 44,
        y: basePt.y - 2,
        vx: s * 42,
        vy: -16 - Math.random() * 10,
        size: 6.2,
        createdAt: now,
        lifetime: 440,
      });
    }
  }

  public getStateSummary(): { mood: string; activeIdle: string | null; peekEdge: PeekEdge } {
    const now = performance.now();
    const previewActive = this.peekPreviewEdge !== 'none';
    const scruffActive = !previewActive && (this.isDragging || now < this.scruffDemoUntil || this.scruffAmount > 0.35);
    let mood = '平静待机 🐾';
    if (this.privacyMode) mood = '隐私防偷窥 🙈';
    else if (previewActive) {
      mood = this.peekVisualEdge === 'left' ? '松手贴左边偷看 👀' : '松手贴右边偷看 👀';
    } else if (scruffActive) mood = '被拎起后颈皮 🫳';
    else if (this.peekAmount > 0.45) {
      mood = this.peekVisualEdge === 'left' ? '左侧贴边偷看 👀' : '右侧贴边偷看 👀';
    } else if (this.boopAmount > 0.15) mood = '戳鼻头斗鸡眼 🤧';
    else if (this.isCross) mood = '生气飞机耳 💢';
    else if (this.tailGlanceAmount > 0.25) mood = '被戳尾巴警惕 ⚡';
    else if (this.chinAmount > 0.25) mood = '挠下巴超享受 💛';
    else if (this.sleepAmount > 0.5) mood = '打瞌睡 Zzz';
    else if (this.idleAct?.kind === 'doze') mood = '点头钓鱼犯困 😵‍💫';
    else if (this.idleAct?.kind === 'yawn') mood = '打哈欠 🥱';
    else if (this.idleAct?.kind === 'stretch') mood = '伸大懒腰 🐱';
    else if (this.idleAct?.kind === 'groom') mood = '舔爪洗脸 🐾';
    else if (this.idleAct?.kind === 'knead') mood = '键盘踩奶 🍞';
    else if (now < this.curiousUntil) mood = '好奇大圆瞳 ✨';
    else if (this.squintAmount > 0.35) mood = '摸头呼噜中 💛';
    return { mood, activeIdle: this.idleAct?.kind ?? null, peekEdge: this.peekEdge };
  }

  private shouldUseTailForKey(
    spec: KeySpec,
    targetPoint: Vec2,
    activelyMousing: boolean,
    prevAnyKeyAt: number,
    now: number,
  ): boolean {
    if (this.tailKeyMode === 'off') return false;
    if (this.tailKeyMode === 'custom') {
      return this.tailKeyIdSet.has(spec.id);
    }
    if (this.tailKeyMode === 'edge') {
      if (EDGE_PROTECTED_WASD_IDS.has(spec.id)) return false;
      const edgeThresholdX =
        this.keyboardLayout === '108'
          ? this.kbCenterX + this.kbWidth * 0.22
          : this.kbCenterX + this.kbWidth * 0.34;
      return targetPoint.x >= edgeThresholdX;
    }

    // 'smart' (第三只手 · 智能忙碌时出尾):
    // 1) Both hands occupied -> tail leaps in as a real third hand for any extra key!
    let leftHeld = 0;
    let rightHeld = 0;
    let rightBusy = false;
    if (this.catBreed === 'dafeiyu') {
      const busy = this.dafeiyu.getHandBusyState(now);
      leftHeld = busy.leftHeld;
      rightHeld = busy.rightHeld;
      rightBusy = busy.rightBusy;
    } else {
      for (const h of this.heldKeys.values()) {
        if (h.side === 'left') leftHeld += 1;
        else rightHeld += 1;
      }
      rightBusy =
        rightHeld > 0 || (this.rightPaw.mode === 'poke' && now - this.rightPaw.lastActiveAt < 135);
    }

    const thirdHandBusy =
      (activelyMousing && rightBusy) ||
      (leftHeld > 0 && rightHeld > 0) ||
      leftHeld + rightHeld >= 2;
    if (thirdHandBusy) return true;

    // 2) Satisfying punctuation flourish: tail slaps Enter / Numpad Enter right after typing a burst!
    if (
      (spec.id === 'enter' || spec.id === 'np_ent') &&
      (this.typingEnergy > 0.24 || (now - prevAnyKeyAt < 450 && this.recentKeyTimes.length >= 2))
    ) {
      return true;
    }
    return false;
  }

  private syncLayoutPositions(): void {
    const isBigFish = this.catBreed === 'dafeiyu';
    if (this.keyboardLayout === '108') {
      this.logicalW = 540;
      this.logicalH = 456;
      this.catCenterX = 278;
      this.catTopY = 66;
      this.catBaseY = 292;
      this.kbCenterX = 290;
      this.kbCenterY = 356;
      this.kbWidth = 398;
      this.kbHeight = 96;
      this.kbTiltRad = (2.4 * Math.PI) / 180;
      this.mouseBaseX = isBigFish ? 54 : 46;
      this.mouseBaseY = isBigFish ? 332 : 342;
    } else {
      this.logicalW = 420;
      this.logicalH = 440;
      this.catCenterX = 196;
      this.catTopY = 82;
      this.catBaseY = 308;
      this.kbCenterX = isBigFish ? 234 : 214;
      this.kbCenterY = 353;
      this.kbWidth = 266;
      this.kbHeight = 74;
      this.kbTiltRad = (3.4 * Math.PI) / 180;
      this.mouseBaseX = isBigFish ? 72 : 54;
      this.mouseBaseY = isBigFish ? 322 : 334;
    }
    this.peekTransform = this.computePeekTransform2D();
  }

  public setCatAppearance(breedId: string, skin?: CatSkinConfig | null): void {
    if (breedId !== 'dafeiyu' && this.catBreed === 'dafeiyu') {
      this.dafeiyu.releaseSprites();
    }
    if (breedId === 'dafeiyu') {
      this.catBreed = 'dafeiyu';
      this.customSkin = null;
      catAudio.setPurrIntensity(0);
    } else if ((breedId === 'black' || breedId === 'ragdoll') && (!skin || skin.builtin)) {
      this.catBreed = breedId;
      this.customSkin = null;
    } else if (skin) {
      this.catBreed = 'black';
      this.customSkin = resolveCustomSkin(skin);
    } else {
      this.catBreed = 'black';
      this.customSkin = null;
    }
    this.syncLayoutPositions();
    this.wakeAction();
  }

  public setHeadphones(active: boolean): void {
    const next = Boolean(active);
    if (next !== this.headphonesOn) {
      this.headphonesOn = next;
      if (next) {
        this.headsetSpring.v += 2.2;
      }
      this.wakeAction();
    }
  }

  public setKeyboardConfig(layout: KeyboardLayoutId, orientation: KeyboardOrientation): void {
    const nextLayout: KeyboardLayoutId = layout === '108' ? '108' : '65';
    const nextOrientation: KeyboardOrientation = orientation === 'viewer' ? 'viewer' : 'cat';
    const layoutChanged = this.keyboardLayout !== nextLayout;
    this.keyboardLayout = nextLayout;
    this.keyboardOrientation = nextOrientation;

    this.syncLayoutPositions();

    if (layoutChanged) {
      this.heldKeys.clear();
      this.catTail.heldVks.clear();
      this.catTailHeldAt.clear();
      this.leftPaw.pos = { x: this.catCenterX - 18, y: this.catBaseY };
      this.leftPaw.target = { x: this.catCenterX - 18, y: this.catBaseY };
      this.rightPaw.pos = { x: this.catCenterX + 18, y: this.catBaseY };
      this.rightPaw.target = { x: this.catCenterX + 18, y: this.catBaseY };
    }
    this.wakeAction();
  }

  private buildDaFeiYuLayout(): DaFeiYuLayout {
    const mx = this.mouseBaseX + this.mouseOffsetX;
    const my = this.mouseBaseY + this.mouseOffsetY;
    // Mouse always stays cat-facing (#92) even when keyboard faces the viewer
    const localBtnX = this.mouseLeftDown ? -6.5 : this.mouseRightDown ? 6.5 : 0;
    const localBtnY = -10.5;
    const ang = this.kbTiltRad + Math.PI;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    let cursorPt: { x: number; y: number } | null = null;
    if (this.hasPointerPosition) {
      const rawX = this.cursorRelX * this.logicalW;
      const rawY = this.cursorRelY * this.logicalH;
      if (!this.embedded && this.peekAmount > 0.01) {
        const { tx, ty, rot, pivotX, pivotY } = this.peekTransform;
        const dx = rawX - (pivotX + tx);
        const dy = rawY - (pivotY + ty);
        const cos = Math.cos(-rot);
        const sin = Math.sin(-rot);
        cursorPt = {
          x: pivotX + dx * cos - dy * sin,
          y: pivotY + dx * sin + dy * cos,
        };
      } else {
        cursorPt = { x: rawX, y: rawY };
      }
    }
    return {
      logicalW: this.logicalW,
      kbCenterX: this.kbCenterX,
      kbCenterY: this.kbCenterY,
      kbWidth: this.kbWidth,
      kbHeight: this.kbHeight,
      kbTiltRad: this.kbTiltRad,
      mouseBtnX: mx + localBtnX * c - localBtnY * s,
      mouseBtnY: my + localBtnX * s + localBtnY * c,
      cursor: cursorPt,
      mouseNX: this.lastMouseNX,
      mouseLeft: this.mouseLeftDown,
      mouseRight: this.mouseRightDown,
      mouseActiveAt: this.lastMouseMoveAt,
      mouseClickAt: this.lastMouseClickAt,
      petEnergy: this.petEnergy,
      privacyMode: this.privacyMode,
      privacyTypingAt: this.privacyTypingAt,
      is108: this.keyboardLayout === '108',
      peekAmount: Math.max(0, Math.min(1, this.peekAmount)),
    };
  }

  // ---- Foreground device geometry ----

  private getTabletLayout(): {
    cx: number;
    cy: number;
    w: number;
    h: number;
    surfaceCx: number;
    surfaceCy: number;
    surfaceW: number;
    surfaceH: number;
  } {
    const is108 = this.keyboardLayout === '108';
    const w = is108 ? 356 : 244;
    const h = is108 ? 94 : 74;
    const cx = this.kbCenterX;
    const cy = this.kbCenterY + 1;
    return {
      cx,
      cy,
      w,
      h,
      surfaceCx: cx + w * 0.035,
      surfaceCy: cy + 1,
      surfaceW: w * 0.70,
      surfaceH: h * 0.54,
    };
  }

  private getGamepadLayout(): { cx: number; cy: number; w: number; h: number; scale: number } {
    const is108 = this.keyboardLayout === '108';
    const w = is108 ? 390 : 310;
    const h = is108 ? 104 : 88;
    return {
      cx: this.kbCenterX,
      cy: this.kbCenterY + 15,
      w,
      h,
      scale: Math.min(w / 300, h / 100),
    };
  }

  private getActiveGamepad(): GamepadVisualState | null {
    if (this.lastPadId !== null) {
      const active = this.gamepads.get(this.lastPadId);
      if (active) return active;
    }
    const first = this.gamepads.values().next();
    if (!first.done) return first.value;
    // Bluetooth gamepads drop out of WinRT enumeration while idle. Keep the
    // last physical pad on screen until real keyboard/mouse input arrives.
    if (!this.forcedDevice && this.deviceMode === 'gamepad' && this.lastPhysicalPad) {
      return this.lastPhysicalPad;
    }
    if (this.forcedDevice === 'gamepad' || this.deviceMode === 'gamepad') return this.demoPad;
    return null;
  }

  private rememberPhysicalGamepad(pad: GamepadVisualState): void {
    this.lastPhysicalPad = {
      name: pad.name,
      buttons: new Array(24).fill(0),
      triggers: new Array(4).fill(0),
      axes: new Array(8).fill(0),
      held: new Array(24).fill(false),
      visible: 1,
      lastActiveAt: pad.lastActiveAt,
    };
  }

  private getPenGrip(nibX: number, nibY: number): Vec2 {
    const dx = this.catCenterX - 4 - nibX + this.penTiltX * 10;
    const dy = this.catBaseY - 54 - nibY - this.penTiltY * 8;
    const length = Math.hypot(dx, dy) || 1;
    const gripLength = this.penTiltX === 0 && this.penTiltY === 0 ? 58 : 56;
    return {
      x: nibX + (dx / length) * gripLength,
      y: nibY + (dy / length) * gripLength,
    };
  }

  private getTabletPenPoint(now: number): { x: number; y: number; pressure: number; demo: boolean } {
    const layout = this.getTabletLayout();
    const demoPoint = () => {
      const t = this.elapsed * 0.9;
      const u = 0.5 + 0.34 * Math.sin(t * 0.95 + 0.4);
      const v = 0.5 + 0.27 * Math.sin(t * 1.37 + 1.15);
      return {
        x: layout.surfaceCx + (u - 0.5) * layout.surfaceW * 0.9,
        y: layout.surfaceCy + (v - 0.5) * layout.surfaceH * 0.78,
        pressure: 0.38 + 0.42 * (0.5 + 0.5 * Math.sin(t * 2.2)),
        demo: true,
      };
    };

    // Entering tablet preview without hardware should start the animation immediately
    // instead of briefly borrowing a stale (or never initialized) real-pen point.
    if (this.forcedDevice === 'tablet' && !this.penActive && now - this.penLastAt > 3000) {
      return demoPoint();
    }

    if (this.penVisible > 0.02) {
      const fresh = this.tabletHardwareConnected
        ? this.penActive || now - this.penLastAt < 900
        : now - this.penPointerAt < 1600 || now - this.penLastAt < 900;
      if (fresh) {
        return { x: this.tabletPenX, y: this.tabletPenY, pressure: this.penPressure, demo: false };
      }
    }

    if (this.forcedDevice === 'tablet') {
      return demoPoint();
    }

    return {
      x: layout.surfaceCx + layout.surfaceW * 0.34,
      y: layout.surfaceCy - layout.surfaceH * 0.72,
      pressure: 0,
      demo: false,
    };
  }

  private updateDeviceVisuals(dt: number, now: number): void {
    if (
      this.tabletHardwareConnected &&
      this.penActive &&
      now - this.lastNativePenAt > 1200
    ) {
      this.penActive = false;
      this.penDown = false;
      this.penBarrel = false;
      this.penSecondBarrel = false;
      this.penEraser = false;
      this.penPressure = 0;
    }

    if (this.forcedDevice === 'tablet') {
      this.penVisible = 1;
    } else if (this.deviceMode === 'tablet' && this.tabletHardwareConnected) {
      // A connected tablet must never borrow the global mouse cursor as a pen.
      // Keep the nib visible only while the real pen is in range, then let it
      // settle back onto the bezel instead of freezing at its last hover point.
      const target = this.penActive ? 1 : 0;
      this.penVisible += (target - this.penVisible) * (1 - Math.exp(-14 * dt));
    } else {
      const pointerActive =
        this.penActive || now - this.penPointerAt < 1400;
      this.penVisible += ((pointerActive ? 1 : 0) - this.penVisible) * (1 - Math.exp(-9 * dt));
    }

    if (this.penTrail.length > 0) {
      for (const point of this.penTrail) point.a -= dt * 0.42;
      this.penTrail = this.penTrail.filter((point) => point.a > 0);
    }

    for (const pad of this.gamepads.values()) {
      const activePad = this.deviceMode === 'gamepad' ? this.getActiveGamepad() : null;
      const targetVisible =
        pad === activePad || now - pad.lastActiveAt < 3200 ? 1 : 0;
      pad.visible += (targetVisible - pad.visible) * (1 - Math.exp(-6 * dt));
      for (let i = 0; i < pad.buttons.length; i++) {
        if (!pad.held[i]) pad.buttons[i] = Math.max(0, pad.buttons[i] - dt * 6);
      }
      for (let i = 0; i < pad.triggers.length; i++) {
        if (!pad.held[i + 4]) pad.triggers[i] = Math.max(0, pad.triggers[i] - dt * 6);
      }
    }

    if (
      this.deviceMode === 'gamepad' &&
      this.gamepads.size === 0 &&
      (!this.lastPhysicalPad || this.forcedDevice === 'gamepad')
    ) {
      const t = this.elapsed;
      this.demoPad.axes[0] = Math.sin(t * 0.8) * 0.55;
      this.demoPad.axes[1] = Math.sin(t * 0.63 + 0.5) * 0.34;
      this.demoPad.axes[2] = Math.sin(t * 1.05 + 2.1) * 0.5;
      this.demoPad.axes[3] = Math.sin(t * 0.87 + 0.9) * 0.3;
      this.demoPad.buttons[0] = Math.sin(t * 2.1) > 0.86 ? 1 : 0;
      this.demoPad.buttons[1] = Math.sin(t * 1.47 + 1.4) > 0.9 ? 1 : 0;
      this.demoPad.buttons[3] = Math.sin(t * 1.72 + 2.6) > 0.9 ? 1 : 0;
      this.demoPad.buttons[13] = Math.sin(t * 1.9) > 0.93 ? 1 : 0;
      this.demoPad.buttons[14] = Math.sin(t * 2.3 + 2) > 0.94 ? 1 : 0;
      this.demoPad.triggers[0] = 0.5 + 0.5 * Math.sin(t * 1.1);
      this.demoPad.triggers[2] = 0.5 + 0.5 * Math.sin(t * 1.4 + 1.8);
      this.demoPad.visible = 1;
    }

    if (this.deviceMode === 'gamepad') {
      const pad = this.getActiveGamepad();
      if (pad) {
        this.cursorRelX = Math.max(0.08, Math.min(0.92, 0.5 + (pad.axes[0] ?? 0) * 0.3));
        this.cursorRelY = Math.max(0.1, Math.min(0.92, 0.62 + (pad.axes[1] ?? 0) * 0.24));
      }
    } else if (this.deviceMode === 'tablet') {
      const pen = this.getTabletPenPoint(now);
      this.cursorRelX = pen.x / this.logicalW;
      this.cursorRelY = pen.y / this.logicalH;
    }

    this.updateDevicePaws(now);
  }

  private updateDevicePaws(now: number): void {
    if (this.deviceMode === 'gamepad') {
      const pad = this.getActiveGamepad();
      if (!pad) return;
      const layout = this.getGamepadLayout();
      const scale = layout.scale;
      const world = (x: number, y: number): Vec2 => ({
        x: layout.cx + x * scale,
        y: layout.cy + y * scale,
      });

      // Viewer-left paw rests on the left stick / face cluster, viewer-right
      // paw rests on the right stick / D-pad. The controller body is mirrored
      // vertically by the renderer, so local +Y becomes screen-up.
      let leftTarget = world(-26 + (pad.axes[0] ?? 0) * 4.5, -(8 + (pad.axes[1] ?? 0) * 4.5));
      let rightTarget = world(64 + (pad.axes[2] ?? 0) * 4.5, -(8 + (pad.axes[3] ?? 0) * 4.5));

      if ((pad.buttons[13] ?? 0) > 0.1) rightTarget = world(30, -21);
      else if ((pad.buttons[14] ?? 0) > 0.1) rightTarget = world(30, 5);
      else if ((pad.buttons[15] ?? 0) > 0.1) rightTarget = world(12, -8);
      else if ((pad.buttons[16] ?? 0) > 0.1) rightTarget = world(38, -8);

      const face = [
        { id: 0, x: -68, y: -16 },
        { id: 1, x: -82, y: -2 },
        { id: 2, x: -68, y: 12 },
        { id: 3, x: -54, y: -2 },
      ];
      const pressedFace = face.find((button) => (pad.buttons[button.id] ?? 0) > 0.1);
      if (pressedFace) leftTarget = world(pressedFace.x, pressedFace.y);

      this.padPressLeft = Math.max(
        pad.buttons[0] ?? 0,
        pad.buttons[1] ?? 0,
        pad.buttons[2] ?? 0,
        pad.buttons[3] ?? 0,
        pad.buttons[11] ?? 0,
        pad.buttons[4] ?? 0,
        pad.buttons[5] ?? 0,
        pad.triggers[0] ?? 0,
      );
      this.padPressRight = Math.max(
        pad.buttons[12] ?? 0,
        pad.buttons[13] ?? 0,
        pad.buttons[14] ?? 0,
        pad.buttons[15] ?? 0,
        pad.buttons[16] ?? 0,
        pad.buttons[6] ?? 0,
        pad.buttons[7] ?? 0,
        pad.triggers[2] ?? 0,
      );

      this.leftPaw.mode = 'pad';
      this.rightPaw.mode = 'pad';
      this.leftPaw.target = leftTarget;
      this.rightPaw.target = rightTarget;
      this.leftPaw.lastActiveAt = now;
      this.rightPaw.lastActiveAt = now;
      return;
    }

    this.padPressLeft = 0;
    this.padPressRight = 0;

    if (this.deviceMode === 'tablet') {
      const pen = this.getTabletPenPoint(now);
      const active =
        this.forcedDevice === 'tablet' || this.penVisible > 0.05 || now - this.penLastAt < 1600;
      if (active) {
        this.leftPaw.mode = 'pen';
        this.leftPaw.target = this.getPenGrip(pen.x, pen.y);
        this.leftPaw.lastActiveAt = now;
        if (this.rightPaw.mode !== 'curled' && this.rightPaw.mode !== 'idle') {
          this.rightPaw.mode = 'curled';
        }
      } else if (this.leftPaw.mode === 'pen') {
        this.leftPaw.mode = 'idle';
      }
    }
  }

  // Dynamic logical proportions (65% compact = 420x440; 108-key full-size = 540x456)
  private logicalW = 420;
  private logicalH = 440;
  private catCenterX = 196;
  private catTopY = 82;
  private catBaseY = 308;
  private readonly catHeight = 226;

  // Mechanical keyboard deck below the sitting cat
  private kbCenterX = 214;
  private kbCenterY = 353;
  private kbWidth = 266;
  private kbHeight = 74;
  private kbTiltRad = (3.4 * Math.PI) / 180;

  // True-scale white oval mouse to the left of keyboard
  private mouseBaseX = 54;
  private mouseBaseY = 334;
  private mouseOffsetX = 0;
  private mouseOffsetY = 0;
  private mouseTargetOffsetX = 0;
  private mouseTargetOffsetY = 0;
  private mouseLeftDown = false;
  private mouseRightDown = false;
  private mouseMiddleDown = false;
  private mouseDownAt: Record<'left' | 'right' | 'middle', number> = {
    left: 0,
    right: 0,
    middle: 0,
  };
  private mouseLeftPress = 0;
  private mouseRightPress = 0;
  private mouseMiddlePress = 0;
  private lastMouseClickAt = -10000;
  private mouseScrollFlash = 0;
  private lastMouseMoveAt = -10000;
  private lastMouseNY = 0.5;
  private lastCursorEyeAt = -10000;
  private mouseBadges: Array<{
    id: number;
    label: string;
    color: string;
    x: number;
    y: number;
    createdAt: number;
    lifetime: number;
  }> = [];

  // Foreground device: one desk accessory is shown at a time.
  private deviceMode: ForegroundDevice = 'keyboard';
  private forcedDevice: ForegroundDevice | null = null;

  // Gamepad state, one pad per connection id. `demoPad` animates when the
  // user previews a gamepad without hardware connected.
  private gamepads = new Map<number, GamepadVisualState>();
  private lastPadId: number | null = null;
  private lastPhysicalPad: GamepadVisualState | null = null;
  private demoPad: GamepadVisualState = {
    name: 'Kuro Pad · DEMO',
    buttons: new Array(24).fill(0),
    triggers: new Array(4).fill(0),
    axes: new Array(8).fill(0),
    held: new Array(24).fill(false),
    visible: 1,
    lastActiveAt: 0,
  };
  private padPressLeft = 0;
  private padPressRight = 0;
  private lastPadActivityAt = -10000;
  private lastPadConnectedAt = -10000;
  private mouseIntentAt = -10000;
  private mouseIntentX = 0;
  private mouseIntentY = 0;
  private mouseIntentDistance = 0;
  private padBubbles: PadBubble[] = [];

  // Stylus / pen (Pointer Events) drives a held-pen nib + ink trail on the tablet.
  private penActive = false;
  private penDown = false;
  private penBarrel = false;
  private penSecondBarrel = false;
  private penEraser = false;
  private penPressure = 0;
  private penTiltX = 0;
  private penTiltY = 0;
  private penVisible = 0;
  private penLastAt = -10000;
  private penPointerAt = -10000;
  private tabletPenX = 0;
  private tabletPenY = 0;
  private penTrail: Array<{ x: number; y: number; p: number; a: number }> = [];
  // Scratch buckets for the ink trail, reused so the render loop does not
  // allocate every frame.
  private inkBuckets: number[][] = [];
  private inkBucketAlpha: number[] = [];
  private penBadges: TabletBadge[] = [];
  private tabletKeyBadges: TabletBadge[] = [];
  private nativeTabletAt = -10000;
  private lastNativePenAt = -10000;
  private nativePenSeen = false;
  private tabletInRange = false;
  private tabletHardwareConnected = false;
  private tabletFallbackTimer: number | null = null;
  private tabletPhysicalKeys = [false, false, false, false];
  /** ExpressKeys the cat's tail is holding down. */
  private tabletTailKeys = [false, false, false, false];

  // Tablet input arbitration. A Wacom ExpressKey produces two independent
  // signals - a keyboard shortcut from the OS and a vendor HID report - and
  // they can arrive in any order. Reacting to whichever lands first makes the
  // keyboard and the tablet model alternate, so the tablet keeps the
  // foreground until it is really idle and the keyboard hand-over waits for the
  // HID report to arrive.
  private lastTabletSignalAt = -10000;
  private lastTabletActivityAt = -10000;
  private lastTabletKeyAt = -10000;
  private lastTabletNx = -1;
  private lastTabletNy = -1;
  private pendingTabletKeySwitch: number | null = null;

  // Cursor & 100% live eye tracking + 2.5D head turn
  private cursorRelX = 0.5;
  private cursorRelY = 0.5;
  private hasPointerPosition = false;
  private cursorOverCat = false;
  private eyeLookX = 0;
  private eyeLookY = 0;
  private faceTurnX = 0;

  // Staggered 240Hz spring hierarchy: eyes fastest (9.5Hz near-critically damped -> liquid silky!) -> ears (5.2Hz) -> head (2.6Hz) -> spine (1.9Hz)
  private eyeXSpring = new Spring(0, 9.5, 0.96);
  private eyeYSpring = new Spring(0, 9.5, 0.96);
  private earPerkSpring = new Spring(0, 5.2, 0.36);
  private headTiltSpring = new Spring(0, 2.6, 0.62);
  private faceTurnSpring = new Spring(0, 2.9, 0.74);
  private spineLeanSpring = new Spring(0, 1.9, 0.72);
  private hunchSpring = new Spring(0, 2.0, 0.68);
  private squashSpring = new Spring(0, 2.6, 0.54);
  private curiousSpring = new Spring(0, 3.8, 0.72);
  private crossSpring = new Spring(0, 1.9, 0.86);
  private deskHopSpring = new Spring(0, 9.2, 0.34);
  private headsetSpring = new Spring(0, 5.4, 0.70);
  private scruffSpring = new Spring(0, 5.0, 0.72);
  private scruffSwingSpring = new Spring(0, 2.9, 0.24);
  private tailRecoilSpring = new Spring(0, 7.6, 0.42);
  private peekSpring = new Spring(0, 4.4, 0.72);
  private peekHoverSpring = new Spring(0, 5.8, 0.74);
  private headphonesOn = false;

  // Alive cat emotional state machine: curious (laser-pointer eyes), sleepy loaf (Zzz), idle fidgets, cross (airplane ears + tail desk-thump!)
  private lastInputAt = performance.now();
  private asleep = false;
  private sleepAmount = 0;
  private breathPhase = 0;
  private tailDriftPhase = 0;
  private wakeAt = -10000;
  private nextZAt = 0;
  private pointerSamples: Array<{ t: number; dist: number }> = [];
  private lastPointerSampleX: number | null = null;
  private lastPointerSampleY: number | null = null;
  private lastPointerSampleAt = -10000;
  private curiousUntil = -10000;
  private curiousAmount = 0;
  private annoy = 0;
  private lastPokeAt = -10000;
  private isCross = false;
  private crossSince = -10000;
  private crossAmount = 0;
  private crossHuffDir: -1 | 1 = -1;
  private thumpPhase = 0;
  private thumpLift = 0;
  private thumpLash = 0;
  private lastSlamAt = -10000;
  private deskHopY = 0;
  private idleAct: IdleFidget | null = null;
  private nextIdleActAt = performance.now() + 4500;
  private fxParticles: CatFxParticle[] = [];

  // New rich idle vignettes (doze nod-off, yawn, stretch, groom face-wash, biscuit knead)
  private dozeLidClose = 0;
  private dozeNod = 0;
  private dozeJoltFired = false;
  private yawnAmount = 0;
  private stretchAmount = 0;
  private groomAmount = 0;
  private groomLickAmount = 0;
  private groomEarPressLeft = 0;
  private groomEarPressRight = 0;
  private groomSparkleSpawned = false;
  private kneadAmount = 0;
  private kneadPhase = 0;
  private hadHeartyPet = false;
  private petEndedAt = -10000;
  private yawnDoneThisIdle = false;
  private dozeDoneThisIdle = false;

  // New interactive states: scruffed drag + body-zone boop / chin scratch / tail poke
  private isDragging = false;
  private scruffDemoUntil = -10000;
  private scruffAmount = 0;
  private scruffSwing = 0;
  private scruffDragVelX = 0;
  private boopStartAt = -10000;
  private boopUntil = -10000;
  private boopAmount = 0;
  private boopCrossEye = 0;
  private boopSneezeFired = false;
  private boopShake = 0;
  private chinScratchEnergy = 0;
  private chinAmount = 0;
  private nextHeartAt = 0;
  private tailRecoil = 0;
  private tailGlanceUntil = -10000;
  private tailGlanceAmount = 0;
  private tailPokeTimes: number[] = [];
  private liveTailCurvePts: Vec2[] = [];

  // Screen-edge peek mode (cat hides keyboard & torso off-edge, peeking ONLY its head & gripping paws!)
  private peekEdge: PeekEdge = 'none';
  private peekPreviewEdge: PeekEdge = 'none';
  private peekVisualEdge: 'left' | 'right' = 'left';
  private peekAmount = 0;
  private peekHover = 0;
  private peekTransform = { tx: 0, ty: 0, rot: 0, pivotX: 196, pivotY: 136 };

  // Spine-shear deformation state (exact measured flexible cat spine + playful typing body/head sway!)
  private spineLean = 0;    // -1 (mouse lean: head shifts -46px left while hips stay anchored!) .. +1
  private headTilt = 0;
  private typingHunch = 0;  // 0..1 lowers head & rounds posture slightly when typing
  private typingSway = 0;   // -1..+1 lively left-right torso & head sway while typing!
  private typingSwayVel = 0;
  private typingGroovePhase = 0;
  private lastKeyBias = 0;
  private strikeRock = 0;
  private strikeRockVel = 0;
  private bodyBob = 0;
  private kbBounce = 0;

  // Blinking, petting, ear micro-twitch, typing rhythm
  private nextBlinkAt = 2.8;
  private blinkProgress = 0;
  private isBlinking = false;

  private lastPetCursorX: number | null = null;
  private lastPetCursorY: number | null = null;
  private petAnchorX: number | null = null;
  private petAnchorY: number | null = null;
  private petStrokeDirX = 0;
  private petStrokeDirY = 0;
  private petStrokeTravel = 0;
  private petReverseTravel = 0;
  private petStrokeCount = 0;
  private lastPetMoveAt = -10000;
  private petEnergy = 0;
  private squintAmount = 0;
  private earTwitchLeft = 0;
  private earTwitchRight = 0;
  private recentKeyTimes: number[] = [];
  private typingEnergy = 0;
  private lastAnyKeyAt = -10000;

  // Paws & continuous held-key tracking (Fixes #3)
  private leftPaw: PawState;
  private rightPaw: PawState;
  private lastSpacePaw: 'left' | 'right' = 'left';
  private heldKeys = new Map<
    number,
    { side: 'left' | 'right'; specId: string; x: number; y: number; at: number }
  >();
  private catTailHeldAt = new Map<number, number>();

  // Keys & bubbles
  private keyAnims = new Map<string, KeyAnim>();
  private bubbles: KeyBubble[] = [];
  private nextBubbleId = 1;
  private fpsCap = 0;
  private sleepTrimSent = false;
  public onDeepSleep: (() => void) | null = null;

  public setFpsCap(cap: number): void {
    this.fpsCap = cap === 30 ? 30 : cap === 60 ? 60 : 0;
  }

  constructor(canvas: HTMLCanvasElement, options?: { embedded?: boolean }) {
    this.canvas = canvas;
    this.embedded = Boolean(options?.embedded);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not initialize 2D canvas context');
    this.ctx = ctx;

    for (const k of KEYBOARD_KEYS_65) {
      this.keyAnims.set(k.id, { pressed: false, pressAmount: 0, lastHitAt: -10000 });
    }
    for (const k of KEYBOARD_KEYS_108) {
      if (!this.keyAnims.has(k.id)) {
        this.keyAnims.set(k.id, { pressed: false, pressAmount: 0, lastHitAt: -10000 });
      }
    }

    this.leftPaw = {
      side: 'left',
      shoulderNormY: 0.65,
      shoulderHalfX: -43,
      pos: { x: this.catCenterX - 18, y: this.catBaseY },
      vel: { x: 0, y: 0 },
      target: { x: this.catCenterX - 18, y: this.catBaseY },
      mode: 'idle',
      idleWeight: 1,
      curlWeight: 0,
      pokeTime: 1,
      impactSquash: 0,
      lastActiveAt: -10000,
      smears: [],
    };

    this.rightPaw = {
      side: 'right',
      shoulderNormY: 0.65,
      shoulderHalfX: 43,
      pos: { x: this.catCenterX + 18, y: this.catBaseY },
      vel: { x: 0, y: 0 },
      target: { x: this.catCenterX + 18, y: this.catBaseY },
      mode: 'idle',
      idleWeight: 1,
      curlWeight: 0,
      pokeTime: 1,
      impactSquash: 0,
      lastActiveAt: -10000,
      smears: [],
    };

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  public resize(): void {
    const dpr = Math.min(2, Math.max(window.devicePixelRatio || 1, 1));
    const cssW = Math.max(1, this.embedded ? (this.canvas.clientWidth || 420) : window.innerWidth);
    const cssH = Math.max(1, this.embedded ? (this.canvas.clientHeight || 440) : window.innerHeight);
    const nextW = Math.round(cssW * dpr);
    const nextH = Math.round(cssH * dpr);
    if (this.canvas.width !== nextW || this.canvas.height !== nextH) {
      this.canvas.width = nextW;
      this.canvas.height = nextH;
    }
    this.wakeAction();
  }

  public start(): void {
    if (this.rafId !== null || this.idleFrameTimer !== null) return;
    const now = performance.now();
    this.lastTime = now;
    this.lastActionAt = now;
    this.lastAmbientAt = now;
    this.lastRenderMs = 0;
    this.lastRenderPerfMs = 0;
    this.directRafPrevMs = 0;
    this.pacingTier = 'action';
    this.rafId = requestAnimationFrame(this.renderFrame);
  }

  public stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.idleFrameTimer !== null) window.clearTimeout(this.idleFrameTimer);
    this.rafId = null;
    this.idleFrameTimer = null;
    this.pacingTier = 'action';
    this.directRafPrevMs = 0;
    this.lastRenderMs = 0;
    this.lastRenderPerfMs = 0;
    if (this.tabletFallbackTimer !== null) {
      window.clearTimeout(this.tabletFallbackTimer);
      this.tabletFallbackTimer = null;
    }
    this.cancelTabletKeyboardSwitch();
  }

  public releaseCachedResources(): void {
    this.dafeiyu.releaseSprites();
    if (this.kbCacheCanvas) {
      this.kbCacheCanvas.width = 0;
      this.kbCacheCanvas.height = 0;
      this.kbCacheCanvas = null;
      this.kbCacheKey = '';
    }
    this.canvas.width = 0;
    this.canvas.height = 0;
  }

  public setGameActive(active: boolean): void {
    this.gameActive = Boolean(active);
  }

  private computePacingTier(now: number): RenderPacingTier {
    const wakeElapsed = now - this.wakeAt;
    const peekTransitioning =
      this.peekPreviewEdge !== 'none'
        ? Math.abs(this.peekAmount - 0.90) > 0.02 || Math.abs(this.peekSpring.v) > 0.02
        : (this.peekAmount > 0.01 && this.peekAmount < 0.99) || Math.abs(this.peekSpring.v) > 0.02;
    const hasActiveAction =
      now - this.lastActionAt < ACTION_RENDER_AFTER_MS ||
      this.heldKeys.size > 0 ||
      this.catTail.heldVks.size > 0 ||
      this.catTail.reach > 0.02 ||
      this.mouseLeftDown ||
      this.mouseRightDown ||
      this.mouseMiddleDown ||
      this.bubbles.length > 0 ||
      this.mouseBadges.length > 0 ||
      this.petEnergy > 0.12 ||
      this.isCross ||
      this.crossAmount > 0.03 ||
      now < this.curiousUntil ||
      this.curiousAmount > 0.02 ||
      this.isDragging ||
      now < this.scruffDemoUntil ||
      this.scruffAmount > 0.02 ||
      this.boopAmount > 0.02 ||
      this.chinAmount > 0.02 ||
      this.tailRecoil > 0.02 ||
      this.tailGlanceAmount > 0.02 ||
      peekTransitioning ||
      (this.sleepAmount > 0.02 && this.sleepAmount < 0.98) ||
      (wakeElapsed >= 0 && wakeElapsed < 650) ||
      Math.abs(this.deskHopY) > 0.15 ||
      Math.abs(this.headsetSpring.v) > 0.02 ||
      Math.abs(this.headsetSpring.x - (this.headphonesOn ? 1 : 0)) > 0.01 ||
      this.fxParticles.some((fx) => fx.kind !== 'z');
    if (hasActiveAction) return 'action';

    if (this.sleepAmount > 0.95) return 'sleep';

    const hasAmbientMotion =
      now - this.lastAmbientAt < AMBIENT_RENDER_AFTER_MS ||
      this.idleAct !== null ||
      this.yawnAmount > 0.02 ||
      this.stretchAmount > 0.02 ||
      this.groomAmount > 0.02 ||
      this.kneadAmount > 0.02 ||
      Math.abs(this.dozeNod) > 0.02 ||
      (this.peekHover > 0.01 && this.peekHover < 0.99) ||
      Math.abs(this.peekHoverSpring.v) > 0.02 ||
      (this.catBreed === 'dafeiyu' && this.peekAmount > 0.01 && this.peekAmount < 0.99) ||
      this.isBlinking ||
      Math.abs(this.eyeXSpring.v) > 0.02 ||
      Math.abs(this.eyeYSpring.v) > 0.02 ||
      Math.abs(this.faceTurnSpring.v) > 0.05;
    if (hasAmbientMotion) return 'ambient';

    return 'idle';
  }

  private getTargetIntervalMs(tier: RenderPacingTier, eco30: boolean): number {
    switch (tier) {
      case 'action':
        return eco30 ? 33.33 : 16.67;
      case 'ambient':
        return AMBIENT_FRAME_MS;
      case 'idle':
        return IDLE_FRAME_MS;
      case 'sleep':
        return DEEP_SLEEP_FRAME_MS;
    }
  }

  private scheduleNextFrame(tier: RenderPacingTier, sleepMs: number): void {
    this.rafId = null;
    this.pacingTier = tier;
    if (this.idleFrameTimer !== null) {
      window.clearTimeout(this.idleFrameTimer);
    }
    this.idleFrameTimer = window.setTimeout(() => {
      this.idleFrameTimer = null;
      this.rafId = requestAnimationFrame(this.renderFrame);
    }, sleepMs);
  }

  private readonly renderFrame = (now: number): void => {
    const frameId = this.rafId;
    const workStart = performance.now();

    // Continuously adapt to VRR / ProMotion (24-120Hz) and display switches:
    // if direct rAF ever observes >=2 short intervals (<13.5ms), lock vsyncMs down immediately
    // so 120-240Hz displays never run uncapped even if startup happened at 60Hz (#59).
    if (this.directRafPrevMs > 0) {
      const gap = now - this.directRafPrevMs;
      if (gap >= 3.2 && gap <= 25) {
        if (gap < 13.5) {
          this.highRefreshHits = Math.min(4, this.highRefreshHits + 1);
          if (this.highRefreshHits >= 2) {
            this.vsyncMs = Math.min(this.vsyncMs, gap);
          }
        } else {
          this.highRefreshHits = Math.max(0, this.highRefreshHits - 1);
          if (this.highRefreshHits === 0) {
            this.vsyncMs = this.vsyncSamples === 0 ? gap : this.vsyncMs * 0.75 + gap * 0.25;
          }
        }
        if (this.vsyncSamples < 8) {
          this.vsyncSamples += 1;
        }
      }
    }

    const eco30 = this.gameActive || this.fpsCap === 30;
    const preTier = this.computePacingTier(now);
    const minIntervalMs =
      preTier === 'action'
        ? eco30
          ? 28
          : 12.5
        : preTier === 'ambient'
          ? 36
          : preTier === 'idle'
            ? 56
            : 85;

    if (this.lastRenderMs > 0) {
      const sinceLast = now - this.lastRenderMs;
      if (sinceLast >= 0 && sinceLast < minIntervalMs) {
        const preTargetMs = this.getTargetIntervalMs(preTier, eco30);
        const remainingMs = preTargetMs - sinceLast;
        if (
          preTier === 'action' &&
          !eco30 &&
          (this.vsyncMs >= 13.5 || remainingMs <= this.vsyncMs + 2)
        ) {
          this.pacingTier = preTier;
          this.directRafPrevMs = now;
          this.rafId = requestAnimationFrame(this.renderFrame);
        } else {
          this.directRafPrevMs = 0;
          this.scheduleNextFrame(
            preTier,
            Math.max(4, Math.round(remainingMs - this.vsyncMs * 0.35)),
          );
        }
        return;
      }
    }

    const rawInterval = now - this.lastTime;
    const dt = Math.min(0.05, Math.max(0.001, rawInterval / 1000));
    this.lastTime = now;
    this.lastRenderMs = now;
    this.lastRenderPerfMs = workStart;
    this.update(dt, now);
    this.render();
    this.onAfterRender?.();
    this.frameCount += 1;
    const work = performance.now() - workStart;
    if (work > this.maxFrameWorkMs) this.maxFrameWorkMs = work;
    if (work > FRAME_WORK_BUDGET_MS) this.longFrameCount += 1;
    // The renderer stops itself while the cat is idle, so only gaps that
    // happen while it is awake count as a stall.
    if (rawInterval < IDLE_GAP_LIMIT_MS && rawInterval > this.maxFrameGapMs) {
      this.maxFrameGapMs = rawInterval;
    }

    if (this.rafId !== frameId) return;

    if (this.sleepAmount > 0.96) {
      if (!this.sleepTrimSent) {
        this.sleepTrimSent = true;
        this.onDeepSleep?.();
      }
    } else if (this.sleepAmount < 0.2) {
      this.sleepTrimSent = false;
    }

    // 4-tier adaptive frame pacing:
    // - Full action (typing, clicking, scrolling, petting, scruff/boop/chin/tail/peek slides, agent/mood bursts): 60 FPS (30 FPS eco)
    //   * 60Hz normal: native direct rAF (0 timer jitter)
    //   * 120-240Hz / ProMotion VRR normal: 60 FPS paced cap
    // - Ambient cursor-gaze / mouse follow / idle vignettes / peek hover pop-out: ~23 FPS (44ms, matches 33-45ms IPC cadence)
    // - Idle awake (including calmly settled edge-peek): ~15 FPS (66ms); Deep sleep: ~10 FPS (100ms)
    const tier = this.computePacingTier(now);
    if (tier === 'action' && !eco30 && this.vsyncMs >= 13.5) {
      this.pacingTier = 'action';
      this.directRafPrevMs = now;
      this.rafId = requestAnimationFrame(this.renderFrame);
      return;
    }

    this.directRafPrevMs = 0;
    const workMs = performance.now() - workStart;
    const targetMs = this.getTargetIntervalMs(tier, eco30);
    const sleepMs = Math.max(4, Math.round(targetMs - workMs - this.vsyncMs * 0.35));

    // Pause after drawing so even a slow frame leaves CPU headroom on older hardware (Fixes #9).
    this.scheduleNextFrame(tier, sleepMs);
  };

  private wakeAction(now = performance.now()): void {
    this.lastActionAt = Math.max(this.lastActionAt, now);
    this.lastAmbientAt = Math.max(this.lastAmbientAt, now);
    // Interrupt slower ambient/idle/sleep timers immediately on real action,
    // without defeating active 60/30 FPS action pacing timers.
    if (this.idleFrameTimer === null || this.pacingTier === 'action') return;
    window.clearTimeout(this.idleFrameTimer);
    this.idleFrameTimer = null;
    this.pacingTier = 'action';
    this.rafId = requestAnimationFrame(this.renderFrame);
  }

  private wakeAmbient(now = performance.now()): void {
    this.lastAmbientAt = Math.max(this.lastAmbientAt, now);
    // Never defeat active action or ambient pacing timers on high-Hz cursor storms;
    // only promote out of slow idle/sleep timers once an ambient frame interval has elapsed.
    if (
      this.idleFrameTimer === null ||
      this.pacingTier === 'action' ||
      this.pacingTier === 'ambient'
    ) {
      return;
    }
    if (now - this.lastRenderPerfMs < AMBIENT_FRAME_MS - 6) return;
    window.clearTimeout(this.idleFrameTimer);
    this.idleFrameTimer = null;
    this.pacingTier = 'ambient';
    this.rafId = requestAnimationFrame(this.renderFrame);
  }

  private pokeAnnoy(amount: number, now: number): void {
    if (this.catBreed === 'dafeiyu' || this.privacyMode) return;
    this.annoy = Math.max(0, Math.min(1, this.annoy + amount));
    this.lastPokeAt = now;
  }

  private wakeCat(
    now = performance.now(),
    mode: 'gentle' | 'abrupt' = 'gentle',
    highActivity = true,
  ): void {
    const wasAsleep = this.asleep;
    const recentlyWoken = wasAsleep || this.sleepAmount >= 0.45 || now - this.wakeAt < 1200;
    if (highActivity || recentlyWoken) {
      this.wakeAction(now);
    } else {
      this.wakeAmbient(now);
    }
    if (wasAsleep) {
      this.wakeAt = now;
    }
    this.asleep = false;
    this.lastInputAt = now;
    this.idleAct = null;
    this.scruffDemoUntil = -10000;
    this.yawnDoneThisIdle = false;
    this.dozeDoneThisIdle = false;
    this.nextIdleActAt = now + 4200 + Math.random() * 4200;

    if (
      mode === 'abrupt' &&
      recentlyWoken &&
      this.catBreed !== 'dafeiyu' &&
      !this.privacyMode &&
      this.petEnergy < 0.15 &&
      !this.isCross
    ) {
      // Grumpy wake-up ("起床气"): ~3.2s airplane ears + 3-beat tail desk-thump when rudely jolted from sleep!
      this.isCross = true;
      this.crossSince = now;
      this.crossHuffDir = this.cursorRelX >= 0.5 ? -1 : 1;
      this.thumpPhase = 0;
      this.curiousUntil = -10000;
      this.annoy = Math.max(this.annoy, 0.44);
      this.lastPokeAt = now - 1200;
      this.wakeAt = -10000;
    }
  }

  private recordPointerSpeed(nx: number, ny: number, now: number): void {
    if (this.catBreed === 'dafeiyu' || this.privacyMode) return;
    const gapMs = now - this.lastPointerSampleAt;
    if (
      this.lastPointerSampleX !== null &&
      this.lastPointerSampleY !== null &&
      gapMs > 0 &&
      gapMs <= 140
    ) {
      const dist = Math.hypot(nx - this.lastPointerSampleX, ny - this.lastPointerSampleY);
      if (dist > 0.0015 && dist < 0.45) {
        this.pointerSamples.push({ t: now, dist });
      }
    }
    this.lastPointerSampleX = nx;
    this.lastPointerSampleY = ny;
    this.lastPointerSampleAt = now;
  }

  /** Dedicated pointer-speed feed (e.g., full-window CSS-pixel/1440 space on web preview) for laser-pointer Curious mode. */
  public onPointerSpeedSample(sx: number, sy: number): void {
    const now = performance.now();
    this.recordPointerSpeed(sx, sy, now);
  }

  /** Interactive demo trigger: immediately shows laser-pointer curious big round pupils & perked ears! */
  public triggerCuriousDemo(durationMs = 3500): void {
    const now = performance.now();
    this.wakeCat(now, 'gentle');
    this.wakeAt = -10000;
    this.isCross = false;
    this.annoy = 0;
    this.curiousUntil = now + durationMs;
    this.curiousSpring.kick(2.4);
    this.earPerkSpring.kick(2.2);
  }

  /** Interactive demo trigger: immediately shows airplane ears + 3-beat grumpy tail desk-thump! */
  public triggerCrossDemo(): void {
    const now = performance.now();
    this.wakeCat(now, 'gentle');
    this.wakeAt = -10000;
    this.curiousUntil = -10000;
    this.annoy = 0.95;
    this.lastPokeAt = now;
    this.isCross = true;
    this.crossSince = now;
    this.crossHuffDir = this.cursorRelX >= 0.5 ? -1 : 1;
    this.thumpPhase = 0;
  }

  /** Interactive demo trigger: immediately curls into sleepy loaf with floating Zzz! */
  public triggerSleepDemo(): void {
    const now = performance.now();
    this.wakeAction(now);
    this.isCross = false;
    this.annoy = 0;
    this.curiousUntil = -10000;
    this.idleAct = null;
    this.asleep = true;
    this.lastInputAt = now - 90_000;
    this.nextZAt = now + 400;
  }

  /** AI Companion trigger: cozy happy squint + soft blush celebration (without requiring cursor hover). */
  public triggerHappyDemo(durationMs = 2600): void {
    const now = performance.now();
    this.wakeCat(now, 'gentle');
    this.wakeAt = -10000;
    this.isCross = false;
    this.annoy = 0;
    this.curiousUntil = -10000;
    this.petEnergy = Math.max(this.petEnergy, Math.min(3.5, 0.8 + durationMs / 1000));
  }

  /** AI Companion trigger: gently wakes up the cat from sleep. */
  public triggerWakeDemo(): void {
    const now = performance.now();
    this.wakeCat(now, 'gentle');
    this.wakeAt = -10000;
    this.isCross = false;
    this.annoy = 0;
  }

  /** AI Companion trigger: playful single tail pat on Enter/Space. */
  public triggerTailPatDemo(): void {
    const vk = 0x0d;
    this.onKeyDown(vk, false);
    window.setTimeout(() => this.onKeyUp(vk), 170);
  }

  private startIdleVignette(kind: IdleFidget['kind'], dur: number, side: -1 | 1 = Math.random() < 0.5 ? -1 : 1): void {
    const now = performance.now();
    this.wakeCat(now, 'gentle');
    this.wakeAt = -10000;
    this.isCross = false;
    this.annoy = 0;
    this.curiousUntil = -10000;
    this.boopUntil = -10000;
    this.chinScratchEnergy = 0;
    this.dozeJoltFired = false;
    this.groomSparkleSpawned = false;
    this.kneadPhase = 0;
    this.idleAct = { kind, t0: now, dur, side };
    this.nextIdleActAt = now + dur + 3600 + Math.random() * 4000;
    this.wakeAction(now);
  }

  /** Interactive demo trigger: pre-sleep nodding off ("点头钓鱼") with sudden wake-up jolt! */
  public triggerDozeDemo(): void {
    this.startIdleVignette('doze', 3500);
  }

  /** Interactive demo trigger: big cozy feline yawn ("打哈欠") with round pink mouth & tongue! */
  public triggerYawnDemo(): void {
    this.startIdleVignette('yawn', 2500);
  }

  /** Interactive demo trigger: big satisfying keyboard stretch ("伸懒腰")! */
  public triggerStretchDemo(): void {
    this.startIdleVignette('stretch', 2700);
  }

  /** Interactive demo trigger: lick paw + wipe face & press ear ("舔爪洗脸")! */
  public triggerGroomDemo(): void {
    this.startIdleVignette('groom', 3400);
  }

  /** Interactive demo trigger: rhythmic alternating paw kneading ("键盘踩奶")! */
  public triggerKneadDemo(): void {
    this.startIdleVignette('knead', 4000);
  }

  /** Interactive demo trigger: lifted by the scruff with dangling swinging paws + bouncy landing! */
  public triggerScruffDemo(durationMs = 2600): void {
    const now = performance.now();
    this.wakeCat(now, 'gentle');
    this.wakeAt = -10000;
    this.isCross = false;
    this.annoy = 0;
    this.idleAct = null;
    this.curiousUntil = -10000;
    this.scruffDemoUntil = now + durationMs;
    this.scruffSpring.kick(2.8);
    this.scruffSwingSpring.kick(4.2);
    this.wakeAction(now);
  }

  /** Interactive demo trigger: nose boop -> adorable cross-eyed stare + tiny kitten sneeze! */
  public triggerBoopDemo(): void {
    if (this.catBreed === 'dafeiyu' || this.privacyMode) return;
    const now = performance.now();
    this.wakeCat(now, 'gentle');
    this.wakeAt = -10000;
    this.isCross = false;
    this.annoy = 0;
    this.idleAct = null;
    this.curiousUntil = -10000;
    this.boopStartAt = now;
    this.boopUntil = now + 1150;
    this.boopSneezeFired = false;
    this.squashSpring.kick(-1.5);
    this.headTiltSpring.kick((Math.random() < 0.5 ? -1 : 1) * 1.15);
    this.earTwitchLeft = 1;
    this.earTwitchRight = 1;
    catAudio.playBoopSneeze();
    this.wakeAction(now);
  }

  /** Interactive demo trigger: blissful chin scratch with lifted chin, hearts & warm deeper purr! */
  public triggerChinScratchDemo(durationMs = 2800): void {
    if (this.catBreed === 'dafeiyu' || this.privacyMode) return;
    const now = performance.now();
    this.wakeCat(now, 'gentle');
    this.wakeAt = -10000;
    this.isCross = false;
    this.annoy = 0;
    this.idleAct = null;
    this.curiousUntil = -10000;
    this.chinScratchEnergy = Math.max(this.chinScratchEnergy, Math.min(3.5, 0.9 + durationMs / 1100));
    this.nextHeartAt = Math.min(this.nextHeartAt, now + 80);
    this.wakeAction(now);
  }

  /** Interactive demo trigger: poke tail -> instant recoil tuck + suspicious side-eye (3x within 6s = grumpy!) */
  public triggerTailPokeDemo(): void {
    if (this.catBreed === 'dafeiyu' || this.privacyMode) return;
    const now = performance.now();
    this.wakeCat(now, 'gentle');
    this.wakeAt = -10000;
    this.idleAct = null;
    this.curiousUntil = -10000;
    this.tailPokeTimes = this.tailPokeTimes.filter((t) => now - t < 6000);
    this.tailPokeTimes.push(now);
    this.tailRecoilSpring.kick(5.2);
    this.tailGlanceUntil = now + 1550;
    this.earTwitchRight = 1;
    this.squashSpring.kick(-0.9);
    const tip = this.liveTailCurvePts[this.liveTailCurvePts.length - 1] ?? {
      x: this.catCenterX + 110,
      y: this.catBaseY - 40,
    };
    this.fxParticles.push({
      kind: 'sparkle',
      x: tip.x,
      y: tip.y - 8,
      vx: 14,
      vy: -26,
      size: 10,
      createdAt: now,
      lifetime: 420,
    });
    if (this.tailPokeTimes.length >= 3) {
      this.tailPokeTimes = [];
      catAudio.playTailFlick(true);
      this.triggerCrossDemo();
    } else {
      catAudio.playTailFlick(false);
    }
    this.wakeAction(now);
  }

  // ---- Flexible spine coordinate system (exact match to measured 0.3s -> 2.2s shear!) ----

  private spinePoint(t: number, breath: number): Vec2 {
    // t in [0..1]: 0 = ear tips, 1 = seated base on desk
    const u = Math.max(0, Math.min(1, 1 - t)); // 0 at hips, 1 at head
    const shearCurve = u * u * (3 - 2 * u); // smoothstep from hips up to head!
    // Measured mouse-lean shift (-46px at head) + lively typing left-right body/head sway (+-25px)!
    const leanAmp = this.keyboardLayout === '108' ? 76 : 46;
    const scruffSwingX = this.scruffAmount * this.scruffSwing * 30 * Math.pow(Math.max(0, t - 0.14), 1.3);
    const peekCalm = 1 - Math.max(0, Math.min(1, this.peekAmount));
    const leanX =
      (this.spineLean * leanAmp + this.typingSway * 25 + this.strikeRock * 10) * shearCurve * peekCalm +
      scruffSwingX;
    const swayDipY = Math.abs(this.typingSway) * 4.0 * shearCurve;
    const sleepSinkY = this.sleepAmount * 16.5 * shearCurve;
    const squashDipY = this.squashSpring.x * 6.5 * shearCurve;
    const dozeDropY = this.dozeNod * 15.5 * shearCurve;
    const yawnLiftY = -this.yawnAmount * 6.5 * shearCurve;
    const chinLiftY = -this.chinAmount * 7.5 * shearCurve;
    // Stretch: head lifts slightly while lower chest bows gently forward; Scruff: lifts gently inside top headroom & stretches lower body!
    const stretchCurveY =
      this.stretchAmount * (-9.5 * shearCurve + 8.5 * Math.sin(t * Math.PI));
    const scruffLiftY = Math.min(1, this.scruffAmount) * (-14 + (t - 0.18) * 16);
    const hunchY =
      (this.typingHunch * 13 + this.bodyBob * 3.2 + breath) * shearCurve +
      swayDipY +
      sleepSinkY +
      squashDipY +
      dozeDropY +
      yawnLiftY +
      chinLiftY +
      stretchCurveY +
      scruffLiftY;
    // Slight forward drop when leaning deeply to the mouse
    const leanDropY = Math.abs(this.spineLean) * 6 * shearCurve;
    return {
      x: this.catCenterX + leanX,
      y: this.catTopY + t * this.catHeight + hunchY + leanDropY,
    };
  }

  private getLiveShoulder(paw: PawState, breath: number): Vec2 {
    const sp = this.spinePoint(paw.shoulderNormY, breath);
    return {
      x: sp.x + paw.shoulderHalfX,
      y: sp.y,
    };
  }

  private getLiveCurledPawPos(paw: PawState, breath: number): Vec2 {
    // Bent forearm elbow -> cute curled paw sitting near lower belly (matches 8.3s / 10.6s!)
    const sp = this.spinePoint(0.84, breath);
    const bob = Math.sin(this.elapsed * 12 + (paw.side === 'left' ? 0 : Math.PI)) * (1.5 + this.typingEnergy * 2.0);
    const xOff = paw.side === 'left' ? -24 : 24;
    return {
      x: sp.x + xOff,
      y: sp.y + bob,
    };
  }

  // ---- Input event handlers ----

  public onKeyDown(vk: number, repeat: boolean): void {
    const now = performance.now();
    const spec = resolveKeyByVk(vk, this.keyboardLayout);
    if (this.privacyMode) {
      this.setDeviceFromInput('keyboard');
      if (!repeat) this.onPrivacyTyping();
      return;
    }

    if (this.shouldHoldGamepadThroughHandshake(now)) return;

    // Tablets with ExpressKeys usually deliver them as keyboard shortcuts. Keep
    // the tablet on screen and echo the real shortcut instead of falling back to
    // the keyboard model the moment the user touches a tablet button.
    if (this.shouldTreatKeyboardAsTabletExpressKey(now)) {
      if (!repeat) {
        if (spec) {
          const label = formatBubbleForVk(vk, spec);
          if (label) this.spawnTabletKeyBadge(label, now);
        }
        this.bodyBob = Math.min(0.8, this.bodyBob + 0.35);
      }
      return;
    }

    // The shortcut may still be an ExpressKey whose HID report has not been
    // delivered yet. Hold the model back for a moment so the tablet can claim
    // it - otherwise keyboard and tablet alternate on every single press.
    if (this.shouldDeferKeyboardSwitchForTablet()) {
      this.scheduleTabletKeyboardSwitch();
      if (!repeat) {
        if (spec) {
          const label = formatBubbleForVk(vk, spec);
          if (label) this.spawnTabletKeyBadge(label, now);
        }
        this.bodyBob = Math.min(0.8, this.bodyBob + 0.35);
      }
      return;
    }

    this.setDeviceFromInput('keyboard');
    if (!spec) return;
    this.wakeCat(now, repeat ? 'gentle' : 'abrupt');

    const anim = this.keyAnims.get(spec.id);
    if (anim) {
      anim.pressed = true;
      anim.pressAmount = 1;
      anim.lastHitAt = now;
    }

    if (repeat) {
      this.lastAnyKeyAt = now;
      const held = this.heldKeys.get(vk);
      if (held) held.at = now;
      if (this.catTail.heldVks.has(vk)) {
        this.catTailHeldAt.set(vk, now);
      }
      return;
    }

    const prevAnyKeyAt = this.lastAnyKeyAt;
    this.lastAnyKeyAt = now;
    this.recentKeyTimes.push(now);
    if (this.recentKeyTimes.length > 26) this.recentKeyTimes.shift();

    // Key mashing (4+ keys within 180ms) irritates the cat slightly!
    let burstCount = 0;
    for (let i = this.recentKeyTimes.length - 1; i >= 0; i--) {
      if (now - this.recentKeyTimes[i] <= 180) burstCount++;
      else break;
    }
    if (burstCount >= 4) {
      this.pokeAnnoy(0.32, now);
    }

    this.bodyBob = Math.min(1.15, this.bodyBob + 0.65);
    this.kbBounce = Math.min(1, this.kbBounce + 0.45);
    this.squashSpring.kick(1.85);

    const activelyMousing =
      this.mouseLeftDown || this.mouseRightDown || now - this.lastMouseMoveAt < 320;
    const rawKeyPt = this.getKeyWorldCenter(spec);
    const useTail = this.shouldUseTailForKey(spec, rawKeyPt, activelyMousing, prevAnyKeyAt, now);

    if (this.deviceMode !== 'keyboard') return;

    if (this.catBreed === 'dafeiyu') {
      const dafeiyuLayout = this.buildDaFeiYuLayout();
      const dafeiyuMouseBusy =
        dafeiyuLayout.mouseLeft ||
        dafeiyuLayout.mouseRight ||
        now - dafeiyuLayout.mouseActiveAt < 900;
      const dafeiyuUseTail =
        useTail ||
        this.shouldUseTailForKey(spec, rawKeyPt, dafeiyuMouseBusy, prevAnyKeyAt, now);
      const pt = dafeiyuUseTail ? this.getTailTargetPoint(spec) : rawKeyPt;
      this.dafeiyu.onKeyDown(vk, pt, dafeiyuLayout, repeat, dafeiyuUseTail);
      if (this.showKeyBubbles) {
        const label = formatBubbleForVk(vk, spec);
        if (label) {
          this.spawnBubble(label, spec.id === 'space', pt.x, now);
        }
      }
      return;
    }

    if (Math.random() < 0.16) {
      if (Math.random() < 0.5) this.earTwitchLeft = 1;
      else this.earTwitchRight = 1;
    }

    const layout = getKeyboardLayout(this.keyboardLayout);
    const isCatFacing = this.keyboardOrientation === 'cat';
    const keyColCenter = spec.uStart + spec.uWidth * 0.5;
    const screenKeyCol = isCatFacing ? layout.totalUnits - keyColCenter : keyColCenter;
    const midCol = layout.totalUnits * 0.5;
    const keyBias = Math.max(-1, Math.min(1, (screenKeyCol - midCol) / (layout.totalUnits * 0.34)));
    this.lastKeyBias = keyBias;
    this.typingGroovePhase += 1.22;

    let targetPoint = rawKeyPt;
    let chosen: PawState;

    if (useTail) {
      const clampedTailPt = this.getTailTargetPoint(spec);
      if (!this.catTail.active && this.catTail.reach < 0.08) {
        const hipRight = this.spinePoint(0.84, 0);
        this.catTail.tipX = hipRight.x + 126;
        this.catTail.tipY = hipRight.y - 37;
      }
      this.catTail.active = true;
      this.catTail.heldVks.add(vk);
      this.catTailHeldAt.set(vk, now);
      this.catTail.targetX = clampedTailPt.x;
      this.catTail.targetY = clampedTailPt.y;
      // Continuous typing keeps the tip planted on the keycaps: only a key that arrives after a real pause
      // gets the lift-and-slap windup, otherwise the tip would buzz at the keystroke rate.
      const sinceLastPat = now - this.catTail.patAt;
      this.catTail.patAt = now;
      if (sinceLastPat >= TAIL_PAT_WINDUP_GAP_MS) this.catTail.tapAt = now;
      this.catTail.impactSquash = 1.0;

      // Subtle playful hip shift & rock as the tail pats the chosen key!
      const tailSideSign = clampedTailPt.x >= this.catCenterX ? 1 : -1;
      this.strikeRockVel += tailSideSign * (0.95 + this.typingEnergy * 0.65);
      this.squashSpring.kick(0.95);
      this.headTiltSpring.kick(tailSideSign * 0.32);
      if (!activelyMousing) {
        this.typingSwayVel +=
          (keyBias * 1.15 + Math.cos(this.typingGroovePhase) * 0.75) *
          (0.85 + this.typingEnergy * 0.35);
      }

      if (this.showKeyBubbles) {
        const label = formatBubbleForVk(vk, spec);
        if (label) {
          this.spawnBubble(label, spec.id === 'space', clampedTailPt.x, now);
        }
      }
      return;
    }

    const splitCol =
      this.keyboardLayout === '108'
        ? isCatFacing
          ? 12.2
          : 8.4
        : 7.5;

    if (spec.id === 'space') {
      if (activelyMousing) {
        chosen = this.rightPaw;
      } else {
        this.lastSpacePaw = this.lastSpacePaw === 'left' ? 'right' : 'left';
        chosen = this.lastSpacePaw === 'left' ? this.leftPaw : this.rightPaw;
      }
      const spaceU = isCatFacing
        ? chosen.side === 'left'
          ? spec.uStart + spec.uWidth * 0.68
          : spec.uStart + spec.uWidth * 0.32
        : chosen.side === 'left'
          ? spec.uStart + spec.uWidth * 0.32
          : spec.uStart + spec.uWidth * 0.68;
      const rY = spec.rowY ?? spec.row;
      targetPoint = this.projectKeyboardPoint(spaceU, rY + 0.50);
    } else if (activelyMousing) {
      chosen = this.rightPaw;
    } else if (screenKeyCol < splitCol) {
      chosen = this.leftPaw;
    } else {
      chosen = this.rightPaw;
    }

    const sideSign = chosen.side === 'left' ? -1 : 1;
    this.strikeRockVel += sideSign * (1.75 + this.typingEnergy * 1.25);
    this.headTiltSpring.kick(sideSign * 0.42);
    if (!activelyMousing) {
      // Lively groove impulse: rocks head & upper body back and forth as the cat types!
      this.typingSwayVel += (keyBias * 2.1 + Math.cos(this.typingGroovePhase) * 1.65) * (0.9 + this.typingEnergy * 0.45);
    }

    const prevShoulder = this.getLiveShoulder(chosen, 0);
    if (chosen.mode === 'poke' && Math.hypot(targetPoint.x - chosen.pos.x, targetPoint.y - chosen.pos.y) > 22) {
      chosen.smears.push({
        sx: prevShoulder.x,
        sy: prevShoulder.y,
        px: chosen.pos.x,
        py: chosen.pos.y,
        alpha: 0.28,
      });
      if (chosen.smears.length > 3) chosen.smears.shift();
    }

    if (chosen.mode === 'curled' || chosen.mode === 'idle') {
      const startPt = this.getLiveCurledPawPos(chosen, 0);
      chosen.pos = { x: startPt.x, y: startPt.y };
      chosen.vel = { x: 0, y: 0 };
    }
    const clampedTarget = this.clampToKeyboardSurface(targetPoint);
    chosen.mode = 'poke';
    chosen.target = clampedTarget;
    chosen.pokeTime = 0;
    chosen.impactSquash = 0.85;
    chosen.lastActiveAt = now;
    this.heldKeys.set(vk, {
      side: chosen.side,
      specId: spec.id,
      x: clampedTarget.x,
      y: clampedTarget.y,
      at: now,
    });

    const other = chosen.side === 'left' ? this.rightPaw : this.leftPaw;
    if (other.mode === 'idle' && !activelyMousing) {
      other.mode = 'curled';
      other.lastActiveAt = now;
    }

    if (this.showKeyBubbles) {
      const label = formatBubbleForVk(vk, spec);
      if (label) {
        this.spawnBubble(label, spec.id === 'space', targetPoint.x, now);
      }
    }
  }

  public onKeyUp(vk: number): void {
    this.dafeiyu.onKeyUp(vk);
    this.heldKeys.delete(vk);
    if (this.catTail.heldVks.has(vk)) {
      this.catTail.heldVks.delete(vk);
      this.catTailHeldAt.delete(vk);
      if (this.catTail.heldVks.size === 0) {
        this.catTail.releaseAt = performance.now();
      }
    }
    if (this.privacyMode) return;
    const spec = resolveKeyByVk(vk, this.keyboardLayout);
    if (!spec) return;
    this.wakeAction();
    let stillHeldSameSpec = false;
    for (const h of this.heldKeys.values()) {
      if (h.specId === spec.id) {
        stillHeldSameSpec = true;
        break;
      }
    }
    if (!stillHeldSameSpec) {
      const anim = this.keyAnims.get(spec.id);
      if (anim) anim.pressed = false;
    }
  }

  public onGlobalMouseMove(nx: number, ny: number): void {
    const now = performance.now();
    // Wacom/Windows Ink mirrors the pen as a synthetic mouse. Never let the
    // global cursor drive the tablet nib: only raw HID or Pointer Events may
    // move the pen, otherwise the pen visibly fights the tablet.
    if (now - this.nativeTabletAt < 900) return;
    if (this.deviceMode === 'tablet') {
      if (this.tabletHardwareConnected || this.forcedDevice === 'tablet') return;
      if (now - this.penPointerAt < 1400) return;
      this.setDeviceFromInput('keyboard');
      return;
    }
    if (now - this.penPointerAt < 600) return;
    if (this.shouldKeepGamepadOverMouse()) return;
    this.setDeviceFromInput('keyboard');
    if (this.deviceMode !== 'keyboard') return;
    const moveDelta = Math.hypot(nx - this.lastMouseNX, ny - this.lastMouseNY);

    // Ignore 0px synthetic repeats & tiny optical-sensor micro-jitter (~3-4px; ~7-8px when napping)
    // so the sleep countdown is never silently reset and a desk bump never wakes a sleeping cat!
    const jitterThreshold = this.asleep || this.sleepAmount > 0.35 ? 0.006 : 0.0028;
    if (moveDelta < jitterThreshold) {
      return;
    }

    this.lastMouseNX = nx;
    this.lastMouseNY = ny;

    // Ignore micro-jitter while actively typing so a tiny desk bump never hijacks the typing paw
    const typingNow = now - this.lastAnyKeyAt < 500 || this.heldKeys.size > 0;
    if (typingNow && moveDelta < 0.015) {
      return;
    }

    // Casual mouse travel uses ambient (~23 FPS) pacing unless it wakes a sleeping cat
    // or triggers laser-pointer Curious mode in update().
    this.wakeCat(now, 'abrupt', false);
    // On desktop, onGlobalMouseMove carries true full-screen 0..1 coords; on embedded web, window pointermove feeds onPointerSpeedSample directly
    if (!this.embedded) {
      this.recordPointerSpeed(nx, ny, now);
    }
    this.mouseTargetOffsetX = (nx - 0.5) * (this.catBreed === 'dafeiyu' ? 14 : 20);
    this.mouseTargetOffsetY = (ny - 0.5) * (this.catBreed === 'dafeiyu' ? 11 : 18);
    this.lastMouseMoveAt = now;

    this.leftPaw.mode = 'mouse';
    this.leftPaw.lastActiveAt = now;
  }

  private shouldTreatKeyboardAsTabletExpressKey(now: number): boolean {
    if (this.deviceMode !== 'tablet') return false;
    if (this.forcedDevice === 'tablet') return false;
    if (this.tabletHardwareConnected) {
      // The pen is being used right now, or an ExpressKey report landed a
      // moment ago: the key press belongs to the tablet, not to the keyboard.
      return (
        now - this.lastTabletActivityAt < TABLET_ACTIVITY_WINDOW_MS ||
        now - this.lastTabletKeyAt < TABLET_ACTIVITY_WINDOW_MS
      );
    }
    return now - this.penPointerAt < 1400;
  }

  private shouldDeferKeyboardSwitchForTablet(): boolean {
    if (this.forcedDevice) return false;
    if (!this.tabletHardwareConnected) return false;
    return this.deviceMode === 'tablet';
  }

  private scheduleTabletKeyboardSwitch(): void {
    if (this.pendingTabletKeySwitch !== null) return;
    this.pendingTabletKeySwitch = window.setTimeout(() => {
      this.pendingTabletKeySwitch = null;
      if (this.forcedDevice) return;
      if (this.deviceMode !== 'tablet') return;
      this.setDeviceFromInput('keyboard');
    }, TABLET_KEY_SWITCH_GRACE_MS);
  }

  private cancelTabletKeyboardSwitch(): void {
    if (this.pendingTabletKeySwitch === null) return;
    window.clearTimeout(this.pendingTabletKeySwitch);
    this.pendingTabletKeySwitch = null;
  }

  private tabletPenOwnsInput(now: number): boolean {
    // A connected tablet owns the mouse buttons while its pen is alive. The
    // raw report and the synthetic ink event race each other, so both clocks
    // have to be considered before a mouse button may be taken seriously.
    if (!this.tabletHardwareConnected) return false;
    return (
      now - this.lastTabletSignalAt < 1500 || now - this.lastNativePenAt < 1500
    );
  }

  private shouldKeepGamepadOverMouse(): boolean {
    // A connected controller stays in the foreground until the user actually
    // types or clicks a mouse button. Passive cursor jitter (common while a
    // Bluetooth pad wakes up) must never push the model back to the keyboard.
    return (
      this.deviceMode === 'gamepad' &&
      (this.gamepads.size > 0 || this.lastPhysicalPad !== null)
    );
  }

  private shouldHoldGamepadThroughHandshake(now: number): boolean {
    return (
      !this.forcedDevice &&
      this.deviceMode === 'gamepad' &&
      this.gamepads.size > 0 &&
      now - this.lastPadConnectedAt < 1400
    );
  }

  private getMouseButtonColors(): { left: string; right: string; middle: string } {
    const primary = this.customSkin
      ? this.customSkin.accentColor
      : this.catBreed === 'dafeiyu'
        ? '#5cc8ff'
        : this.catBreed === 'ragdoll'
          ? '#7ac7ff'
          : '#d4f044';
    const scroll = this.customSkin
      ? this.customSkin.accentSideColor
      : this.catBreed === 'dafeiyu'
        ? '#2563eb'
        : this.catBreed === 'ragdoll'
          ? '#4690d8'
          : '#92ba12';

    // Pick a high-contrast complementary color for RMB so Left vs Right click are unmistakable on every skin
    const isWarmAccent = /^#(f[a-f0-9][89a-c]|ff[789a-c]|e[89a-f][789a])/i.test(primary);
    const rightColor = isWarmAccent ? '#58c7ff' : '#ff7b3b';
    return { left: primary, right: rightColor, middle: scroll };
  }

  private spawnMouseBadge(button: 'left' | 'right' | 'middle', now: number): void {
    if (!this.showKeyBubbles) return;
    const colors = this.getMouseButtonColors();
    const label = button === 'left' ? 'LMB' : button === 'right' ? 'RMB' : 'MMB';
    const color = button === 'left' ? colors.left : button === 'right' ? colors.right : colors.middle;
    const mx = this.mouseBaseX + this.mouseOffsetX;
    const my = this.mouseBaseY + this.mouseOffsetY;
    // Mouse stays cat-facing in both keyboard orientations (#92): LMB = inner/+X, RMB = outer/-X
    const sideShift = button === 'left' ? 10 : button === 'right' ? -10 : 0;

    if (this.mouseBadges.length >= 2) {
      this.mouseBadges.shift();
    }
    this.mouseBadges.push({
      id: this.nextBubbleId++,
      label,
      color,
      x: Math.max(24, mx + sideShift),
      y: my - 30,
      createdAt: now,
      lifetime: 560,
    });
  }

  public onMouseDown(button: string): void {
    const now = performance.now();
    if (this.shouldHoldGamepadThroughHandshake(now)) return;
    if (this.deviceMode === 'tablet') {
      if (this.forcedDevice === 'tablet') return;
      if (this.tabletHardwareConnected) {
        // The raw HID pen owns the tablet surface. Windows Ink mirrors the pen
        // as a synthetic mouse, so a mouse button here is the pen's own tip
        // press: turning it into a second pen press is exactly what makes the
        // nib fight with the tablet.
        if (this.tabletPenOwnsInput(now)) return;
      } else if (now - this.penPointerAt < 1400) {
        this.handleTabletPointerButton(button, true, now);
        return;
      }
    }
    this.setDeviceFromInput('keyboard');
    this.wakeCat(now, 'abrupt');
    this.squashSpring.kick(1.2);
    if (button === 'left') {
      this.mouseLeftDown = true;
      this.mouseDownAt.left = now;
      this.mouseLeftPress = 1;
      this.spawnMouseBadge('left', now);
    } else if (button === 'right') {
      this.mouseRightDown = true;
      this.mouseDownAt.right = now;
      this.mouseRightPress = 1;
      this.spawnMouseBadge('right', now);
    } else if (button === 'middle') {
      this.mouseMiddleDown = true;
      this.mouseDownAt.middle = now;
      this.mouseMiddlePress = 1;
      this.spawnMouseBadge('middle', now);
    }

    if (this.deviceMode !== 'keyboard') return;
    this.lastMouseMoveAt = now;
    this.lastMouseClickAt = now;
    this.dafeiyu.resetLeftHandForMouse();
    this.dafeiyu.onMouseAction(now);
    this.leftPaw.mode = 'mouse';
    this.leftPaw.impactSquash = 0.72;
    this.leftPaw.lastActiveAt = now;
  }

  public onMouseUp(button: string): void {
    const now = performance.now();
    if (this.deviceMode === 'tablet') {
      if (this.forcedDevice === 'tablet') return;
      if (this.tabletHardwareConnected) {
        // Synthetic ink events must never release the real HID tip either.
        if (this.tabletPenOwnsInput(now)) return;
      } else if (
        this.penDown ||
        this.penBarrel ||
        this.penSecondBarrel ||
        now - this.penPointerAt < 1400
      ) {
        this.handleTabletPointerButton(button, false, now);
        return;
      }
    }
    this.wakeAction();
    if (button === 'left') {
      this.mouseLeftDown = false;
      this.mouseDownAt.left = 0;
    } else if (button === 'right') {
      this.mouseRightDown = false;
      this.mouseDownAt.right = 0;
    } else if (button === 'middle') {
      this.mouseMiddleDown = false;
      this.mouseDownAt.middle = 0;
    }
  }

  private handleTabletPointerButton(button: string, pressed: boolean, now: number): void {
    const colors = this.getMouseButtonColors();
    if (button === 'left') {
      if (pressed && !this.penDown) {
        this.penDown = true;
        this.penPressure = Math.max(this.penPressure, 0.45);
        this.spawnPenBadge('PEN', colors.left, now);
        this.penTrail.push({ x: this.tabletPenX, y: this.tabletPenY, p: this.penPressure, a: 1 });
        if (this.penTrail.length > 140) this.penTrail.shift();
      } else if (!pressed) {
        this.penDown = false;
      }
    } else if (button === 'right') {
      if (pressed && !this.penBarrel) this.spawnPenBadge('B1', colors.right, now);
      this.penBarrel = pressed;
    } else if (button === 'middle') {
      if (pressed && !this.penSecondBarrel) this.spawnPenBadge('B2', '#7ac7ff', now);
      this.penSecondBarrel = pressed;
    }
    this.penLastAt = now;
    this.penVisible = 1;
    this.leftPaw.mode = 'pen';
    if (pressed) {
      this.leftPaw.lastActiveAt = now;
      if (button === 'left') this.leftPaw.impactSquash = 0.65;
    }
  }

  public onMouseWheel(): void {
    const now = performance.now();
    if (this.shouldHoldGamepadThroughHandshake(now)) return;
    if (this.deviceMode === 'tablet') {
      if (this.forcedDevice === 'tablet') return;
      if (now - this.nativeTabletAt < 350 || this.penActive) return;
    }
    this.setDeviceFromInput('keyboard');
    if (this.deviceMode !== 'keyboard') return;
    this.wakeCat(now, 'abrupt');
    this.mouseScrollFlash = 1;
    this.lastMouseMoveAt = now;
    this.lastMouseClickAt = now;
    this.dafeiyu.resetLeftHandForMouse();
    this.dafeiyu.onMouseAction(now);
    this.leftPaw.mode = 'mouse';
    this.leftPaw.lastActiveAt = now;
  }

  public setDevicePreview(mode: DevicePreviewMode): void {
    this.forcedDevice = mode === 'auto' ? null : mode;
    this.penActive = false;
    this.penDown = false;
    this.penBarrel = false;
    this.penSecondBarrel = false;
    this.penEraser = false;
    this.penTrail = [];
    this.tabletPhysicalKeys = [false, false, false, false];
    this.tabletInRange = false;
    this.cancelTabletKeyboardSwitch();
    this.lastTabletSignalAt = -10000;
    this.lastTabletActivityAt = -10000;
    this.lastTabletKeyAt = -10000;
    this.lastTabletNx = -1;
    this.lastTabletNy = -1;
    if (mode === 'auto') {
      // With no real input yet, resume the device a fresh connection would
      // select. This also stops the no-hardware gamepad demo immediately.
      this.deviceMode = this.gamepads.size > 0 ? 'gamepad' : 'keyboard';
      this.penVisible = 0;
      return;
    }
    this.deviceMode = mode;
    this.penLastAt = Math.min(this.penLastAt, performance.now() - 1200);
    this.leftPaw.mode = 'idle';
    this.rightPaw.mode = 'idle';
  }

  /**
   * True while a tablet or a gamepad owns the foreground. The 3D engine has
   * no peripheral models, so the desktop has to fall back to the 2D engine
   * while one of them is in use.
   */
  public hasPeripheralForeground(): boolean {
    if (this.forcedDevice === 'tablet' || this.forcedDevice === 'gamepad') return true;
    if (this.deviceMode !== 'keyboard') return true;
    return this.gamepads.size > 0;
  }

  private setDeviceFromInput(device: ForegroundDevice): void {
    if (this.forcedDevice || this.deviceMode === device) return;
    this.deviceMode = device;
    if (device !== 'tablet') {
      this.penTrail = [];
    }
    if (device === 'gamepad') {
      this.cursorRelX = 0.5;
      this.cursorRelY = 0.6;
    }
  }

  // ---- Native tablet (Windows Raw Input HID) ----

  public onTabletConnected(_name: string): void {
    this.tabletHardwareConnected = true;
    this.nativePenSeen = false;
    this.lastNativePenAt = -10000;
    this.nativeTabletAt = -10000;
    this.lastTabletSignalAt = -10000;
    this.lastTabletActivityAt = -10000;
    this.lastTabletKeyAt = -10000;
    this.lastTabletNx = -1;
    this.lastTabletNy = -1;
    this.cancelTabletKeyboardSwitch();
    this.penActive = false;
    this.penVisible = 0;
    if (this.tabletFallbackTimer !== null) {
      window.clearTimeout(this.tabletFallbackTimer);
      this.tabletFallbackTimer = null;
    }
  }

  public onTabletDisconnected(): void {
    this.tabletHardwareConnected = false;
    this.nativePenSeen = false;
    this.lastNativePenAt = -10000;
    this.tabletInRange = false;
    this.tabletPhysicalKeys = [false, false, false, false];
    this.cancelTabletKeyboardSwitch();
    this.lastTabletSignalAt = -10000;
    this.lastTabletActivityAt = -10000;
    this.lastTabletKeyAt = -10000;
    this.lastTabletNx = -1;
    this.lastTabletNy = -1;
    this.penActive = false;
    this.penDown = false;
    this.penBarrel = false;
    this.penSecondBarrel = false;
    this.penEraser = false;
    this.penPressure = 0;
    this.penVisible = 0;
    this.penLastAt = performance.now();
    if (this.tabletFallbackTimer !== null) {
      window.clearTimeout(this.tabletFallbackTimer);
      this.tabletFallbackTimer = null;
    }
    if (!this.forcedDevice && this.deviceMode === 'tablet') {
      this.tabletFallbackTimer = window.setTimeout(() => {
        this.tabletFallbackTimer = null;
        if (!this.forcedDevice && this.deviceMode === 'tablet') {
          this.deviceMode = 'keyboard';
        }
      }, 1000);
    }
  }

  public onTabletPen(
    nx: number,
    ny: number,
    pressure: number,
    tiltX: number,
    tiltY: number,
    tip: boolean,
    barrel: boolean,
    secondBarrel: boolean,
    eraser: boolean,
    inRange: boolean,
  ): void {
    const now = performance.now();
    this.tabletInRange = inRange;
    this.penLastAt = now;
    // Any tablet traffic keeps the tablet authoritative, even when the nib is
    // lifted: the raw report still proves the tablet is the live device.
    this.nativeTabletAt = now;
    this.lastTabletSignalAt = now;
    if (this.tabletFallbackTimer !== null) {
      window.clearTimeout(this.tabletFallbackTimer);
      this.tabletFallbackTimer = null;
    }

    // A hovering pen reports the same spot over and over. Only real movement or
    // a button edge counts as the pen being used.
    const moved =
      Math.abs(nx - this.lastTabletNx) > 0.0015 || Math.abs(ny - this.lastTabletNy) > 0.0015;
    const contactChanged =
      tip !== this.penDown ||
      barrel !== this.penBarrel ||
      secondBarrel !== this.penSecondBarrel ||
      eraser !== this.penEraser;
    this.lastTabletNx = nx;
    this.lastTabletNy = ny;
    if (moved || contactChanged) {
      this.lastTabletActivityAt = now;
      // The pen is really in use, so a keyboard shortcut arriving now is an
      // ExpressKey and must not take the model away.
      this.cancelTabletKeyboardSwitch();
    }

    if (!inRange) {
      // The backend latches the range for 1.5 s, but a single dropped report
      // must not blank the nib either. Hold the current state for a short
      // grace; the stale-pen timeout releases the pen afterwards.
      if (now - this.lastNativePenAt >= TABLET_RANGE_GRACE_MS) {
        this.updatePenButtons(false, false, false, false, now);
        this.penPressure = 0;
      }
      // The last position is kept so the model does not jump.
      return;
    }

    this.nativePenSeen = true;
    this.lastNativePenAt = now;
    this.setDeviceFromInput('tablet');
    this.penActive = true;
    this.penVisible = 1;
    this.penPressure = Math.max(0, Math.min(1, pressure));
    this.penTiltX = Math.max(-1, Math.min(1, tiltX));
    this.penTiltY = Math.max(-1, Math.min(1, tiltY));

    const layout = this.getTabletLayout();
    const clampedNx = Math.max(0, Math.min(1, nx));
    const clampedNy = Math.max(0, Math.min(1, ny));
    this.tabletPenX = layout.surfaceCx + (clampedNx - 0.5) * layout.surfaceW * 0.92;
    this.tabletPenY = layout.surfaceCy + (clampedNy - 0.5) * layout.surfaceH * 0.82;
    this.cursorRelX = this.tabletPenX / this.logicalW;
    this.cursorRelY = this.tabletPenY / this.logicalH;
    this.leftPaw.lastActiveAt = now;

    this.updatePenButtons(tip, barrel, secondBarrel, eraser, now);
    if (tip) {
      const last = this.penTrail[this.penTrail.length - 1];
      if (!last || Math.hypot(this.tabletPenX - last.x, this.tabletPenY - last.y) > 0.5) {
        this.penTrail.push({ x: this.tabletPenX, y: this.tabletPenY, p: this.penPressure, a: 1 });
        if (this.penTrail.length > 140) this.penTrail.shift();
      }
    }
  }

  public onTabletKeys(buttons: number): void {
    const now = performance.now();
    const mask = buttons & 0x0f;
    const previous = this.tabletPhysicalKeys;
    const next = [0, 1, 2, 3].map((index) => (mask & (1 << index)) !== 0);
    this.tabletPhysicalKeys = next;
    this.nativeTabletAt = now;
    this.lastTabletSignalAt = now;
    this.lastTabletKeyAt = now;
    this.lastTabletActivityAt = now;
    // The ExpressKey report is the authoritative "the tablet did that" signal.
    // It wins over the keyboard shortcut the OS delivered for the same press.
    this.cancelTabletKeyboardSwitch();
    if (this.tabletFallbackTimer !== null) {
      window.clearTimeout(this.tabletFallbackTimer);
      this.tabletFallbackTimer = null;
    }
    this.setDeviceFromInput('tablet');
    for (let index = 0; index < 4; index++) {
      if (next[index] && !previous[index]) {
        this.spawnTabletKeyBadge(`K${index + 1}`, now, index);
      }
    }
  }

  // ---- Stylus / pen (Pointer Events from the webview) ----

  public onStylusMove(
    nx: number,
    ny: number,
    pressure: number,
    tiltX: number,
    tiltY: number,
    buttons = 0,
  ): void {
    const now = performance.now();
    if (this.tabletHardwareConnected && now - this.lastNativePenAt < 1500) return;
    this.setDeviceFromInput('tablet');
    this.penActive = true;
    this.penPressure = Math.max(0, Math.min(1, pressure));
    this.penTiltX = Math.max(-1, Math.min(1, tiltX / 90));
    this.penTiltY = Math.max(-1, Math.min(1, tiltY / 90));
    this.penLastAt = now;
    this.penPointerAt = now;
    this.penVisible = 1;
    this.updatePenButtons(
      (buttons & 1) !== 0,
      (buttons & 2) !== 0,
      (buttons & 4) !== 0 || (buttons & 8) !== 0 || (buttons & 16) !== 0,
      (buttons & 32) !== 0,
      now,
    );

    const layout = this.getTabletLayout();
    const clampedNx = Math.max(0, Math.min(1, nx));
    const clampedNy = Math.max(0, Math.min(1, ny));
    this.tabletPenX = layout.surfaceCx + (clampedNx - 0.5) * layout.surfaceW * 0.92;
    this.tabletPenY = layout.surfaceCy + (clampedNy - 0.5) * layout.surfaceH * 0.82;
    this.cursorRelX = this.tabletPenX / this.logicalW;
    this.cursorRelY = this.tabletPenY / this.logicalH;
    this.leftPaw.lastActiveAt = now;

    if (this.penDown) {
      const last = this.penTrail[this.penTrail.length - 1];
      if (!last || Math.hypot(this.tabletPenX - last.x, this.tabletPenY - last.y) > 0.5) {
        this.penTrail.push({ x: this.tabletPenX, y: this.tabletPenY, p: this.penPressure, a: 1 });
        if (this.penTrail.length > 140) this.penTrail.shift();
      }
    }
  }

  public onStylusDown(pressure: number, button = 0): void {
    const now = performance.now();
    if (this.tabletHardwareConnected && now - this.lastNativePenAt < 1500) return;
    this.setDeviceFromInput('tablet');
    const eraser = button === 5;
    const barrel = button === 2;
    const secondBarrel = button === 1;
    this.updatePenButtons(!barrel && !secondBarrel && !eraser, barrel, secondBarrel, eraser, now);
    this.penDown = !barrel && !secondBarrel;
    this.penPressure = Math.max(0, Math.min(1, pressure));
    this.penVisible = 1;
    this.penLastAt = now;
    this.penPointerAt = now;
    this.leftPaw.mode = 'pen';
    this.leftPaw.impactSquash = 0.7;
    if (this.penDown) {
      this.penTrail.push({ x: this.tabletPenX, y: this.tabletPenY, p: this.penPressure, a: 1 });
      if (this.penTrail.length > 140) this.penTrail.shift();
    }
  }

  public onStylusUp(): void {
    if (this.tabletHardwareConnected && performance.now() - this.lastNativePenAt < 1500) {
      return;
    }
    this.penDown = false;
    this.penBarrel = false;
    this.penSecondBarrel = false;
    this.penEraser = false;
    this.penActive = false;
    this.penPressure = 0;
    this.penLastAt = performance.now();
  }

  private updatePenButtons(
    tip: boolean,
    barrel: boolean,
    secondBarrel: boolean,
    eraser: boolean,
    now: number,
  ): void {
    const colors = this.getMouseButtonColors();
    if (tip && !this.penDown) this.spawnPenBadge('PEN', colors.left, now);
    if (barrel && !this.penBarrel) this.spawnPenBadge('B1', colors.right, now);
    if (secondBarrel && !this.penSecondBarrel) this.spawnPenBadge('B2', '#7ac7ff', now);
    if (eraser && !this.penEraser) this.spawnPenBadge('ER', '#ff7bb0', now);
    this.penDown = tip;
    this.penBarrel = barrel;
    this.penSecondBarrel = secondBarrel;
    this.penEraser = eraser;
  }

  private spawnPenBadge(label: string, accent: string, now: number): void {
    if (!this.showKeyBubbles || this.privacyMode) return;
    if (this.penBadges.length >= 3) this.penBadges.shift();
    this.penBadges.push({
      id: this.nextBubbleId++,
      label,
      accent,
      x: Math.max(20, Math.min(this.logicalW - 20, this.tabletPenX)),
      y: Math.max(18, this.tabletPenY - 12),
      createdAt: now,
      lifetime: 760,
    });
  }

  private spawnTabletKeyBadge(label: string, now: number, keyIndex?: number): void {
    if (!this.showKeyBubbles || this.privacyMode) return;
    const layout = this.getTabletLayout();
    if (this.tabletKeyBadges.length >= 3) this.tabletKeyBadges.shift();
    const keyX = layout.cx - layout.w * 0.385;
    const keyY = layout.cy - layout.h * 0.35 + (keyIndex ?? 0) * layout.h * 0.125;
    this.tabletKeyBadges.push({
      id: this.nextBubbleId++,
      label,
      accent: this.getMouseButtonColors().left,
      x: keyIndex === undefined ? layout.cx - layout.w * 0.38 : keyX,
      y: keyIndex === undefined ? layout.cy - layout.h * 0.52 : keyY,
      createdAt: now,
      lifetime: 860,
    });
  }

  // ---- Gamepad (WinRT RawGameController on Windows, gilrs on macOS) ----

  public onGamepadConnected(id: number, name: string): void {
    const existing = this.gamepads.get(id);
    if (!existing) {
      this.gamepads.set(id, {
        name,
        buttons: new Array(24).fill(0),
        triggers: new Array(4).fill(0),
        axes: new Array(8).fill(0),
        held: new Array(24).fill(false),
        visible: 1,
        lastActiveAt: performance.now(),
      });
    } else {
      existing.name = name;
    }
    this.lastPadId = id;
    this.lastPhysicalPad = this.gamepads.get(id)!;
    const now = performance.now();
    this.lastPadActivityAt = now;
    this.lastPadConnectedAt = now;
    this.mouseIntentAt = -10000;
    this.mouseIntentDistance = 0;
    this.setDeviceFromInput('gamepad');
  }

  public onGamepadDisconnected(id: number): void {
    const removed = this.gamepads.get(id);
    if (removed) this.rememberPhysicalGamepad(removed);
    this.gamepads.delete(id);
    if (this.lastPadId === id) {
      const next = this.gamepads.keys().next();
      this.lastPadId = next.done ? null : next.value;
    }
  }

  public onGamepadButton(id: number, button: number, pressed: boolean, value: number): void {
    let pad = this.gamepads.get(id);
    if (!pad) {
      this.onGamepadConnected(id, 'Gamepad');
      pad = this.gamepads.get(id)!;
    }
    const now = performance.now();
    const level = Math.max(0, Math.min(1, value));
    const down = pressed || level > 0.06;
    const wasHeld = button >= 0 && button < pad.held.length ? pad.held[button] : false;
    if (button >= 4 && button <= 7) pad.triggers[button - 4] = level;
    if (button >= 0 && button < pad.buttons.length) pad.buttons[button] = level;
    if (button >= 0 && button < pad.held.length) {
      pad.held[button] = pressed || (button >= 4 && button <= 7 && level > 0.02);
    }
    pad.visible = 1;
    pad.lastActiveAt = now;
    if (pressed || level > 0.05) this.lastPadActivityAt = now;
    this.lastPadId = id;
    this.setDeviceFromInput('gamepad');

    if (down && !wasHeld) this.spawnPadBubble(button, now);

    if (!down) return;
    this.bodyBob = Math.min(1.15, this.bodyBob + 0.5);
    if (Math.random() < 0.4) {
      if (Math.random() < 0.5) this.earTwitchLeft = 1;
      else this.earTwitchRight = 1;
    }
  }

  public onGamepadAxis(id: number, axis: number, value: number): void {
    let pad = this.gamepads.get(id);
    if (!pad) {
      this.onGamepadConnected(id, 'Gamepad');
      pad = this.gamepads.get(id)!;
    }
    if (axis >= 0 && axis < pad.axes.length) pad.axes[axis] = value;
    const now = performance.now();
    const wasTriggerHeld =
      axis === 4 ? (pad.held[4] ?? false) : axis === 5 ? (pad.held[6] ?? false) : false;
    let triggerButton: number | null = null;
    if (axis === 4) {
      pad.triggers[0] = Math.max(0, Math.min(1, value));
      pad.held[4] = value > 0.02;
      triggerButton = 4;
    } else if (axis === 5) {
      pad.triggers[2] = Math.max(0, Math.min(1, value));
      pad.held[6] = value > 0.02;
      triggerButton = 6;
    }
    // gilrs/WGI reports the analog triggers as axes rather than button edges.
    // Spawn the LT/RT bubble on the rising edge so they behave like the face
    // and shoulder buttons.
    if (triggerButton !== null && pad.held[triggerButton] && !wasTriggerHeld) {
      this.spawnPadBubble(triggerButton, now);
    }
    // Any axis event proves the controller is alive again. Switching on the
    // event itself (instead of requiring a large deflection) lets a sleeping
    // Bluetooth pad reclaim the foreground after the user typed or clicked.
    this.lastPadId = id;
    this.setDeviceFromInput('gamepad');
    if (Math.abs(value) > 0.02) {
      pad.visible = 1;
      pad.lastActiveAt = now;
      const meaningful = axis <= 3 ? Math.abs(value) > 0.12 : Math.abs(value) > 0.05;
      if (meaningful) this.lastPadActivityAt = now;
    }

    if (axis === 0 || axis === 1) {
      this.cursorRelX = Math.max(0.08, Math.min(0.92, 0.5 + pad.axes[0] * 0.3));
      this.cursorRelY = Math.max(0.1, Math.min(0.92, 0.62 + pad.axes[1] * 0.24));
    }
  }

  private resetPetStrokes(): void {
    this.lastPetCursorX = null;
    this.lastPetCursorY = null;
    this.petAnchorX = null;
    this.petAnchorY = null;
    this.petStrokeDirX = 0;
    this.petStrokeDirY = 0;
    this.petStrokeTravel = 0;
    this.petReverseTravel = 0;
    this.petStrokeCount = 0;
  }

  private isCursorNearDafeiyuPeekHead(relX: number, relY: number): boolean {
    if (this.catBreed !== 'dafeiyu' || this.peekAmount <= 0.35) return false;
    const { tx, ty, rot, pivotX, pivotY } = this.peekTransform;
    if (this.embedded) {
      // Embedded callers pass inverse-peekTransform logical coords via clientToLogical()
      const lx = relX * this.logicalW;
      const ly = relY * this.logicalH;
      if (this.hitTestCatZoneLogical(lx, ly) !== 'head') return false;
      const { offsetX, offsetY, uniformScale } = this.getViewportTransform();
      const s = Math.max(0.001, uniformScale);
      const leftEdge = -offsetX / s;
      const rightEdge = (this.canvas.width - offsetX) / s;
      const topEdge = -offsetY / s;
      const bottomEdge = (this.canvas.height - offsetY) / s;
      const dx = lx - pivotX;
      const dy = ly - pivotY;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const vx = pivotX + tx + dx * cos - dy * sin;
      const vy = pivotY + ty + dx * sin + dy * cos;
      return vx >= leftEdge && vx <= rightEdge && vy >= topEdge && vy <= bottomEdge;
    }
    if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return false;
    const rawX = relX * this.logicalW;
    const rawY = relY * this.logicalH;
    const dx = rawX - (pivotX + tx);
    const dy = rawY - (pivotY + ty);
    const cos = Math.cos(-rot);
    const sin = Math.sin(-rot);
    const lx = pivotX + dx * cos - dy * sin;
    const ly = pivotY + dx * sin + dy * cos;
    return this.hitTestCatZoneLogical(lx, ly) === 'head';
  }

  public onWindowCursor(relX: number, relY: number, overCat: boolean, input: 'pointer' | 'touch' = 'pointer'): void {
    const now = performance.now();
    const cursorDelta = Math.hypot(relX - this.cursorRelX, relY - this.cursorRelY);
    const hasPointerPosition = input === 'pointer';
    const effectiveOverCat =
      overCat || (hasPointerPosition && this.isCursorNearDafeiyuPeekHead(relX, relY));
    if (
      relX !== this.cursorRelX ||
      relY !== this.cursorRelY ||
      effectiveOverCat !== this.cursorOverCat ||
      hasPointerPosition !== this.hasPointerPosition
    ) {
      // Ambient cursor gaze runs at ~23 FPS instead of forcing 60-120 FPS redraws;
      // while deeply asleep with eyes closed and cursor outside the cat, skip waking entirely.
      if (!(this.asleep && this.sleepAmount > 0.92 && !effectiveOverCat)) {
        this.wakeAmbient(now);
      }
      if (cursorDelta > 0.0015) {
        this.lastCursorEyeAt = now;
      }
    }
    this.hasPointerPosition = hasPointerPosition;
    this.cursorRelX = relX;
    this.cursorRelY = relY;
    this.cursorOverCat = effectiveOverCat;

    if (effectiveOverCat && !this.mouseLeftDown && !this.mouseRightDown) {
      const now = performance.now();
      const px = relX * this.logicalW;
      const py = relY * this.logicalH;
      if (this.lastPetCursorX !== null && this.lastPetCursorY !== null) {
        const dx = px - this.lastPetCursorX;
        const dy = py - this.lastPetCursorY;
        const dist = Math.hypot(dx, dy);
        if (dist > 1.5 && dist < 80) {
          this.lastPetMoveAt = now;
          const MIN_STROKE_PX = 14;
          const REQUIRED_STROKES = 2;

          if (this.petAnchorX === null || this.petAnchorY === null) {
            this.petAnchorX = this.lastPetCursorX;
            this.petAnchorY = this.lastPetCursorY;
          }

          if (this.petStrokeDirX === 0 && this.petStrokeDirY === 0) {
            const vx = px - this.petAnchorX;
            const vy = py - this.petAnchorY;
            const segLen = Math.hypot(vx, vy);
            if (segLen >= MIN_STROKE_PX) {
              this.petStrokeDirX = vx / segLen;
              this.petStrokeDirY = vy / segLen;
              this.petStrokeTravel = segLen;
              this.petReverseTravel = 0;
            }
          } else {
            const ux = dx / dist;
            const uy = dy / dist;
            const dot = ux * this.petStrokeDirX + uy * this.petStrokeDirY;
            if (dot >= 0.35) {
              // Continuing along the same straight pass across the cat
              this.petStrokeTravel += dist;
              this.petReverseTravel = Math.max(0, this.petReverseTravel - dist * 0.5);
            } else {
              // Reversing or curving (back-and-forth petting / circular rub)
              this.petReverseTravel += dist;
              if (this.petStrokeTravel >= MIN_STROKE_PX && this.petReverseTravel >= MIN_STROKE_PX) {
                this.petStrokeCount += 1;
                this.petStrokeDirX = ux;
                this.petStrokeDirY = uy;
                this.petStrokeTravel = this.petReverseTravel;
                this.petReverseTravel = 0;
                this.petAnchorX = this.lastPetCursorX;
                this.petAnchorY = this.lastPetCursorY;
              }
            }
          }

          // Only unlock petting energy & purring after intentional back-and-forth / circular strokes (Fixes #13)
          if (this.petStrokeCount >= REQUIRED_STROKES) {
            const zone = this.hitTestCatZoneLogical(px, py);
            if (zone === 'chin') {
              this.chinScratchEnergy = Math.min(1.4, this.chinScratchEnergy + dist * 0.018);
              this.nextHeartAt = Math.min(this.nextHeartAt, now + 180);
            } else {
              this.petEnergy = Math.min(1, this.petEnergy + dist * 0.015);
              if (this.petEnergy > 0.55) {
                this.hadHeartyPet = true;
              }
            }
            this.wakeCat(now, 'gentle');
            this.wakeAt = -10000;
            this.isCross = false;
            this.annoy = 0;
          }
        }
      } else {
        this.petAnchorX = px;
        this.petAnchorY = py;
      }
      this.lastPetCursorX = px;
      this.lastPetCursorY = py;
    } else {
      this.resetPetStrokes();
    }
  }

  // ---- Keyboard projection ----

  private projectKeyboardPoint(uCol: number, rowPos: number): Vec2 {
    const layout = getKeyboardLayout(this.keyboardLayout);
    const isCatFacing = this.keyboardOrientation === 'cat';
    const screenU = isCatFacing ? layout.totalUnits - uCol : uCol;
    const screenRow = isCatFacing ? layout.totalRows - rowPos : rowPos;

    const padX = 7;
    const padY = 6;
    const innerW = this.kbWidth - padX * 2;
    const innerH = this.kbHeight - padY * 2;
    const localX = -innerW / 2 + (screenU / layout.totalUnits) * innerW;
    const localY = -innerH / 2 + (screenRow / layout.totalRows) * innerH;

    const depthFactor = 0.94 + (screenRow / layout.totalRows) * 0.09;
    const px = localX * depthFactor;
    const py = localY;

    const cos = Math.cos(this.kbTiltRad);
    const sin = Math.sin(this.kbTiltRad);
    return {
      x: this.kbCenterX + px * cos - py * sin,
      y: this.kbCenterY + px * sin + py * cos,
    };
  }

  private getKeyWorldCenter(spec: KeySpec): Vec2 {
    const layout = getKeyboardLayout(this.keyboardLayout);
    const isCatFacing = this.keyboardOrientation === 'cat';
    const uClamped = Math.max(0.65, Math.min(layout.totalUnits - 0.65, spec.uStart + spec.uWidth * 0.5));
    const rY = spec.rowY ?? spec.row;
    const rSpan = spec.rowSpan ?? 1;
    let rowPos = rY + rSpan * 0.5;
    if (isCatFacing && rY <= 0.1) {
      rowPos = rY + 0.68;
    } else if (!isCatFacing && rY + rSpan >= layout.totalRows - 0.1) {
      rowPos = rY + rSpan - 0.68;
    }
    return this.projectKeyboardPoint(uClamped, rowPos);
  }

  private clampToKeyboardSurface(pt: Vec2): Vec2 {
    // Transform into keyboard-local space and clamp so the plump paw pad NEVER extends past the keyboard bezel!
    const dx = pt.x - this.kbCenterX;
    const dy = pt.y - this.kbCenterY;
    const cos = Math.cos(-this.kbTiltRad);
    const sin = Math.sin(-this.kbTiltRad);
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;

    const maxX = this.kbWidth * 0.5 - 15;
    const minY = -this.kbHeight * 0.5 + 8;
    const maxY = this.kbHeight * 0.5 - 14;
    const cx = Math.max(-maxX, Math.min(maxX, lx));
    const cy = Math.max(minY, Math.min(maxY, ly));

    const rcos = Math.cos(this.kbTiltRad);
    const rsin = Math.sin(this.kbTiltRad);
    return {
      x: this.kbCenterX + cx * rcos - cy * rsin,
      y: this.kbCenterY + cx * rsin + cy * rcos,
    };
  }

  private spawnBubble(label: string, isSpace: boolean, keyX: number, now: number): void {
    if (this.bubbles.length >= 6) {
      this.bubbles.shift();
    }
    const minX = this.keyboardLayout === '108' ? 145 : 125;
    const maxX = this.logicalW - 105;
    const baseX = Math.max(minX, Math.min(maxX, keyX * 0.45 + this.kbCenterX * 0.55));
    const staggerY = 258 + ((this.nextBubbleId % 3) - 1) * 10 + (Math.random() - 0.5) * 6;
    this.bubbles.push({
      id: this.nextBubbleId++,
      label,
      isSpace,
      x: baseX,
      targetX: baseX,
      y: 292,
      targetY: staggerY,
      rot: ((Math.random() - 0.5) * 4.5 * Math.PI) / 180,
      createdAt: now,
      lifetime: 940,
    });
    this.layoutBubbles();
  }

  private layoutBubbles(): void {
    const count = this.bubbles.length;
    if (count === 0) return;

    const widths = this.bubbles.map((b) => (b.isSpace ? 40 : Math.max(25, b.label.length * 7.5 + 14)));
    const gap = 3.5;
    const totalW = widths.reduce((a, b) => a + b, 0) + gap * (count - 1);
    const anchor = this.kbCenterX + 12;
    const leftBound = this.keyboardLayout === '108' ? 140 : 126;
    const rightBound = this.logicalW - 82;
    let cursor = Math.max(leftBound, Math.min(rightBound - totalW, anchor - totalW * 0.5));

    for (let i = 0; i < count; i++) {
      const w = widths[i];
      this.bubbles[i].targetX = cursor + w * 0.5;
      cursor += w + gap;
    }
  }

  private spawnPadBubble(button: number, now: number): void {
    if (!this.showKeyBubbles || this.privacyMode) return;
    const spec = GAMEPAD_BUTTON_SPECS[button];
    if (!spec) return;
    const layout = this.getGamepadLayout();
    if (this.padBubbles.length >= 6) this.padBubbles.shift();
    this.padBubbles.push({
      id: this.nextBubbleId++,
      label: spec.label,
      accent: spec.accent,
      x: layout.cx + spec.x * layout.scale,
      y: layout.cy - spec.y * layout.scale - 13,
      driftX: (Math.random() - 0.5) * 6,
      rot: ((Math.random() - 0.5) * 4 * Math.PI) / 180,
      createdAt: now,
      lifetime: 820,
    });
  }

  // ---- Simulation update ----

  private update(dt: number, now: number): void {
    this.elapsed += dt;

    // Cross-platform lost-MouseUp safety fallback (Fixes #4 on macOS/Linux/web; Windows also reconciles via GetAsyncKeyState)
    const MOUSE_STUCK_FALLBACK_MS = 10_000;
    const lastMouseActivity = Math.max(this.lastMouseMoveAt, this.lastMouseClickAt);
    if (
      this.mouseLeftDown &&
      now - Math.max(lastMouseActivity, this.mouseDownAt.left) > MOUSE_STUCK_FALLBACK_MS
    ) {
      this.mouseLeftDown = false;
      this.mouseDownAt.left = 0;
    }
    if (
      this.mouseRightDown &&
      now - Math.max(lastMouseActivity, this.mouseDownAt.right) > MOUSE_STUCK_FALLBACK_MS
    ) {
      this.mouseRightDown = false;
      this.mouseDownAt.right = 0;
    }
    if (
      this.mouseMiddleDown &&
      now - Math.max(lastMouseActivity, this.mouseDownAt.middle) > MOUSE_STUCK_FALLBACK_MS
    ) {
      this.mouseMiddleDown = false;
      this.mouseDownAt.middle = 0;
    }

    // Cross-platform lost-KeyUp safety fallback (Fixes #3)
    const KEY_HOLD_STALE_MS = 15_000;
    for (const [vk, held] of this.heldKeys) {
      if (now - held.at > KEY_HOLD_STALE_MS) {
        this.heldKeys.delete(vk);
        const anim = this.keyAnims.get(held.specId);
        if (anim) anim.pressed = false;
      }
    }
    for (const [vk, heldAt] of this.catTailHeldAt) {
      if (now - heldAt > KEY_HOLD_STALE_MS) {
        this.catTailHeldAt.delete(vk);
        this.catTail.heldVks.delete(vk);
        if (this.catTail.heldVks.size === 0) {
          this.catTail.releaseAt = now;
        }
      }
    }

    if (this.petStrokeCount > 0 && now - this.lastPetMoveAt > 2200) {
      this.resetPetStrokes();
    }

    const mLerp = 1 - Math.exp(-28 * dt);
    this.mouseOffsetX += (this.mouseTargetOffsetX - this.mouseOffsetX) * mLerp;
    this.mouseOffsetY += (this.mouseTargetOffsetY - this.mouseOffsetY) * mLerp;
    if (!this.mouseLeftDown && this.mouseLeftPress > 0) {
      this.mouseLeftPress = Math.max(0, this.mouseLeftPress - dt * 5.8);
    }
    if (!this.mouseRightDown && this.mouseRightPress > 0) {
      this.mouseRightPress = Math.max(0, this.mouseRightPress - dt * 5.8);
    }
    if (!this.mouseMiddleDown && this.mouseMiddlePress > 0) {
      this.mouseMiddlePress = Math.max(0, this.mouseMiddlePress - dt * 5.8);
    }
    this.mouseScrollFlash = Math.max(0, this.mouseScrollFlash - dt * 4.5);
    this.mouseBadges = this.mouseBadges.filter((b) => now - b.createdAt < b.lifetime);
    this.padBubbles = this.padBubbles.filter((b) => now - b.createdAt < b.lifetime);
    this.penBadges = this.penBadges.filter((b) => now - b.createdAt < b.lifetime);
    this.tabletKeyBadges = this.tabletKeyBadges.filter((b) => now - b.createdAt < b.lifetime);

    this.updateDeviceVisuals(dt, now);

    while (this.recentKeyTimes.length > 0 && now - this.recentKeyTimes[0] > 950) {
      this.recentKeyTimes.shift();
    }
    const targetTypingEnergy = Math.min(1, this.recentKeyTimes.length / 7);
    this.typingEnergy += (targetTypingEnergy - this.typingEnergy) * (1 - Math.exp(-9 * dt));

    const isTypingRecently =
      now - this.lastAnyKeyAt < 650 ||
      this.heldKeys.size > 0 ||
      this.catTail.heldVks.size > 0;
    const isCatMode = this.catBreed !== 'dafeiyu';

    // 1) Alive cat emotional states: sleep (loaf + Zzz), curious (laser-pointer eyes), annoy -> cross (airplane ears + tail desk-thump),
    //    rich idle vignettes (doze, yawn, stretch, groom, knead), scruffed drag, boop, chin scratch & tail poke!
    const previewWanted = !this.privacyMode && this.peekPreviewEdge !== 'none';
    const scruffWanted = isCatMode && !this.privacyMode && !previewWanted && (this.isDragging || now < this.scruffDemoUntil);
    const peekWanted = !this.privacyMode && (previewWanted || (this.peekEdge !== 'none' && !scruffWanted));
    const peekGoal = previewWanted ? 0.90 : peekWanted ? 1.0 : 0.0;
    this.peekAmount = Math.max(0, Math.min(1.06, this.peekSpring.step(peekGoal, dt)));
    const peekClamped = Math.min(1, this.peekAmount);
    const peekHoverWanted = (peekWanted && this.cursorOverCat) || previewWanted ? 1 : 0;
    this.peekHover = Math.max(0, Math.min(1, this.peekHoverSpring.step(peekHoverWanted, dt)));
    this.peekTransform = this.computePeekTransform2D();
    const wasScruffDemo = !this.isDragging && this.scruffDemoUntil > 0 && now >= this.scruffDemoUntil;
    if (wasScruffDemo) {
      this.scruffDemoUntil = -10000;
      if (this.scruffAmount > 0.25) {
        this.onScruffLand(now);
      }
    }
    this.scruffAmount = Math.max(0, Math.min(1.12, this.scruffSpring.step(scruffWanted ? 1 : 0, dt)));
    const scruffClamped = Math.min(1, this.scruffAmount);
    const scruffTargetSwing = scruffWanted
      ? Math.max(-2.0, Math.min(2.0, -this.scruffDragVelX * 1.05 + Math.sin(this.elapsed * 3.9) * (now < this.scruffDemoUntil ? 1.05 : 0.44)))
      : 0;
    this.scruffSwing = Math.max(-2.2, Math.min(2.2, this.scruffSwingSpring.step(scruffTargetSwing, dt)));
    this.scruffDragVelX *= Math.exp(-5.5 * dt);

    // Nose Boop cross-eyed recoil + tiny kitten sneeze puff
    const boopActive = isCatMode && !this.privacyMode && !scruffWanted && now < this.boopUntil;
    const boopElapsed = boopActive ? (now - this.boopStartAt) / 1000 : -1;
    const targetBoop = boopActive ? 1 : 0;
    this.boopAmount += (targetBoop - this.boopAmount) * (1 - Math.exp(-(boopActive ? 18 : 8) * dt));
    if (this.boopAmount < 0.004 && !boopActive) this.boopAmount = 0;
    this.boopCrossEye =
      boopActive && boopElapsed >= 0 && boopElapsed < 0.78
        ? Math.sin(Math.min(1, boopElapsed / 0.12) * (Math.PI * 0.5)) * (1 - Math.max(0, (boopElapsed - 0.52) / 0.26))
        : 0;
    if (boopActive && boopElapsed >= 0.30 && !this.boopSneezeFired) {
      this.boopSneezeFired = true;
      this.squashSpring.kick(2.6);
      const headPt = this.spinePoint(0.24, 0);
      for (const s of [-1, 0, 1] as const) {
        this.fxParticles.push({
          kind: 'sneeze',
          x: headPt.x + this.faceTurnX * 0.7 + s * 7,
          y: headPt.y + 14,
          vx: s * 46 + (Math.random() - 0.5) * 14,
          vy: 12 + Math.random() * 14,
          size: 7.5 - Math.abs(s) * 1.4,
          createdAt: now,
          lifetime: 380,
        });
      }
    }
    this.boopShake =
      boopActive && boopElapsed >= 0.30 && boopElapsed < 0.72
        ? Math.sin((boopElapsed - 0.30) * 44) * 0.22 * (1 - (boopElapsed - 0.30) / 0.42)
        : 0;

    // Chin scratch energy + warm floating hearts
    this.chinScratchEnergy = Math.max(
      0,
      this.chinScratchEnergy - dt * (this.cursorOverCat ? 0.20 : 0.95),
    );
    const chinActive = isCatMode && !this.privacyMode && !this.isCross && !scruffWanted && this.chinScratchEnergy > 0.22;
    this.chinAmount += ((chinActive ? 1 : 0) - this.chinAmount) * (1 - Math.exp(-10 * dt));
    if (this.chinAmount < 0.004 && !chinActive) this.chinAmount = 0;
    if (chinActive && this.chinAmount > 0.42 && now >= this.nextHeartAt) {
      this.nextHeartAt = now + 440 + Math.random() * 240;
      const headPt = this.spinePoint(0.24, 0);
      const side = Math.random() < 0.5 ? -1 : 1;
      this.fxParticles.push({
        kind: 'heart',
        x: headPt.x + side * (36 + Math.random() * 14),
        y: headPt.y + 4 + Math.random() * 10,
        vx: side * 8,
        vy: -32 - Math.random() * 12,
        size: 12 + Math.random() * 3,
        createdAt: now,
        lifetime: 1450,
      });
    }

    // Tail poke recoil + suspicious side glance
    this.tailRecoil = Math.max(0, Math.min(1.2, this.tailRecoilSpring.step(0, dt)));
    const tailGlanceNow = isCatMode && !this.privacyMode && !this.isCross && !scruffWanted && now < this.tailGlanceUntil;
    this.tailGlanceAmount += ((tailGlanceNow ? 1 : 0) - this.tailGlanceAmount) * (1 - Math.exp(-12 * dt));
    if (this.tailGlanceAmount < 0.004 && !tailGlanceNow) this.tailGlanceAmount = 0;

    const sleepAfterMs = this.embedded ? 20_000 : 28_000;
    const idleMs = now - this.lastInputAt;
    const blockingSleep =
      scruffWanted ||
      peekWanted ||
      boopActive ||
      chinActive ||
      this.petEnergy >= 0.15 ||
      (this.idleAct !== null && ['doze', 'yawn', 'stretch', 'groom', 'knead'].includes(this.idleAct.kind));
    if (isCatMode && !this.privacyMode && !this.asleep && !blockingSleep && idleMs > sleepAfterMs) {
      this.asleep = true;
      this.isCross = false;
      this.idleAct = null;
      this.nextZAt = now + 900;
    }
    const wantSleep = isCatMode && this.asleep && !this.privacyMode && !scruffWanted ? 1 : 0;
    this.sleepAmount += (wantSleep - this.sleepAmount) * (1 - Math.exp(-(wantSleep ? 1.5 : 6.5) * dt));
    if (this.sleepAmount < 0.002 && !wantSleep) this.sleepAmount = 0;

    // Phase-integrated breath & tail drift oscillators: varying frequency smoothly NEVER chirps or jitters after long uptime!
    const breathFreq = 2.1 - this.sleepAmount * 0.95;
    this.breathPhase = (this.breathPhase + dt * breathFreq) % (Math.PI * 2);
    const tailDriftFreq = 0.9 + this.typingEnergy * 1.4;
    this.tailDriftPhase = (this.tailDriftPhase + dt * tailDriftFreq) % (Math.PI * 2);

    // Fast pointer speed over last 220ms triggers Curious (laser-pointer big round eyes!)
    // Never false-trigger Curious while grumpy (isCross), scruffed, booped or actively typing!
    while (this.pointerSamples.length > 0 && now - this.pointerSamples[0].t > 220) {
      this.pointerSamples.shift();
    }
    const pointerSpeed =
      this.pointerSamples.reduce((acc, s) => acc + s.dist, 0) / 0.22;
    const canTriggerCurious =
      isCatMode &&
      !this.asleep &&
      !this.privacyMode &&
      !this.isCross &&
      !scruffWanted &&
      !boopActive &&
      !chinActive &&
      now - this.lastAnyKeyAt > 900;
    if (canTriggerCurious && this.pointerSamples.length >= 4 && pointerSpeed > 0.92) {
      this.curiousUntil = Math.max(this.curiousUntil, now + 2200);
    }
    const curiousNow =
      isCatMode && !this.asleep && !this.privacyMode && !this.isCross && !scruffWanted && !boopActive && now < this.curiousUntil;
    this.curiousAmount = Math.max(0, Math.min(1.2, this.curiousSpring.step(curiousNow ? 1 : 0, dt)));
    const curiousClamped = Math.min(1, this.curiousAmount);

    // Annoyance accumulates from sustained furious typing (>8.5 CPS) or key mashing (in onKeyDown), cools down after 2.2s quiet
    if (isCatMode && !this.privacyMode && !this.asleep && !scruffWanted) {
      const cps = this.recentKeyTimes.length / 0.95;
      if (cps > 8.5) {
        this.pokeAnnoy((cps - 8.5) * 0.055 * dt, now);
      } else if (this.isCross && now - this.lastAnyKeyAt < 900 && this.recentKeyTimes.length >= 4) {
        // Keep grumpy mood alive while user continues typing continuously
        this.lastPokeAt = now;
      }
      if (now - this.lastPokeAt > 2200) {
        this.annoy = Math.max(0, this.annoy - 0.15 * dt);
      }
      if (!this.isCross && this.annoy >= 0.62) {
        this.isCross = true;
        this.crossSince = now;
        this.crossHuffDir = this.cursorRelX >= 0.5 ? -1 : 1;
        this.thumpPhase = 0;
        this.curiousUntil = -10000;
        this.idleAct = null;
      } else if (this.isCross && this.annoy < 0.26 && now - this.crossSince > 3200) {
        this.isCross = false;
      }
    } else {
      this.isCross = false;
      this.annoy = Math.max(0, this.annoy - 0.35 * dt);
    }
    // Moving the mouse never cancels grumpy mode; only cooling down naturally (or demo button) clears it
    const crossTarget = this.isCross ? 1 : 0;
    this.crossAmount = Math.max(0, Math.min(1, this.crossSpring.step(crossTarget, dt)));

    // Track hearty petting end -> naturally rewards user with cozy biscuit kneading!
    if (this.hadHeartyPet && this.petEnergy < 0.14 && this.petEndedAt < now - 8000) {
      this.petEndedAt = now;
    }

    // Idle fidgets & feline life vignettes (tilt, ear, slowBlink, look, tail + doze, yawn, stretch, groom, knead!)
    if (this.idleAct && now > this.idleAct.t0 + this.idleAct.dur) {
      this.idleAct = null;
    }
    if (
      isCatMode &&
      !this.idleAct &&
      !this.asleep &&
      !this.privacyMode &&
      !scruffWanted &&
      !peekWanted &&
      !boopActive &&
      !chinActive &&
      this.petEnergy < 0.15 &&
      !this.isCross &&
      !curiousNow
    ) {
      const hour = new Date().getHours();
      const isLateNight = hour >= 23 || hour < 5;
      const dozeStartMs = this.embedded ? 13_500 : isLateNight ? 16_000 : 20_500;
      const yawnStartMs = this.embedded ? 10_000 : isLateNight ? 11_500 : 14_500;

      if (this.hadHeartyPet && now - this.petEndedAt > 1200 && now - this.petEndedAt < 6000) {
        this.hadHeartyPet = false;
        this.idleAct = { kind: 'knead', t0: now, dur: 3800, side: 1 };
        this.kneadPhase = 0;
        this.nextIdleActAt = now + 5600;
        this.wakeAmbient(now);
      } else if (!this.dozeDoneThisIdle && idleMs > dozeStartMs && idleMs < sleepAfterMs - 1500) {
        this.dozeDoneThisIdle = true;
        this.dozeJoltFired = false;
        this.idleAct = { kind: 'doze', t0: now, dur: 3500, side: Math.random() < 0.5 ? -1 : 1 };
        this.nextIdleActAt = now + 4800;
        this.wakeAmbient(now);
      } else if (!this.yawnDoneThisIdle && idleMs > yawnStartMs && idleMs < dozeStartMs) {
        this.yawnDoneThisIdle = true;
        this.idleAct = { kind: 'yawn', t0: now, dur: 2500, side: Math.random() < 0.5 ? -1 : 1 };
        this.nextIdleActAt = now + 4200;
        this.wakeAmbient(now);
      } else if (now >= this.nextIdleActAt && idleMs > 2600) {
        const pool: IdleFidget['kind'][] =
          idleMs > 7500
            ? ['tilt', 'ear', 'slowBlink', 'look', 'tail', 'groom', 'groom', 'stretch', 'knead', 'yawn']
            : ['tilt', 'tilt', 'ear', 'slowBlink', 'look', 'tail'];
        const kind = pool[Math.floor(Math.random() * pool.length)];
        const durMap: Record<IdleFidget['kind'], number> = {
          tilt: 1900,
          ear: 460,
          slowBlink: 1450,
          look: 2100,
          tail: 1100,
          doze: 3500,
          yawn: 2500,
          stretch: 2700,
          groom: 3400,
          knead: 3800,
        };
        this.dozeJoltFired = false;
        this.groomSparkleSpawned = false;
        this.kneadPhase = 0;
        this.idleAct = {
          kind,
          t0: now,
          dur: durMap[kind],
          side: Math.random() < 0.5 ? -1 : 1,
        };
        this.nextIdleActAt = now + durMap[kind] + 3200 + Math.random() * 4400;
        this.wakeAmbient(now);
      }
    }
    const act = this.idleAct;
    const actU = act ? Math.max(0, Math.min(1, (now - act.t0) / act.dur)) : 0;
    const smoothstep = (a: number, b: number, x: number) => {
      const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    const actEnv = act ? smoothstep(0, 0.25, actU) * (1 - smoothstep(0.7, 1, actU)) : 0;

    // Drive rich idle vignette continuous envelopes
    let targetDozeLid = 0;
    let targetDozeNod = 0;
    let targetYawn = 0;
    let targetStretch = 0;
    let targetGroom = 0;
    let targetGroomLick = 0;
    let targetEarPressL = 0;
    let targetEarPressR = 0;
    let targetKnead = 0;
    let groomHeadBob = 0;
    let groomHeadTilt = 0;
    let dozeTilt = 0;

    if (act && act.kind === 'doze') {
      if (actU < 0.54) {
        const p = actU / 0.54;
        // Two sleepy head-dips getting heavier before snapping awake!
        const dipWave = p < 0.42 ? Math.sin((p / 0.42) * Math.PI) * 0.45 : smoothstep(0.38, 1.0, p);
        targetDozeLid = Math.min(0.86, 0.25 + dipWave * 0.65);
        targetDozeNod = dipWave;
        dozeTilt = act.side * 0.14 * dipWave;
      } else {
        if (!this.dozeJoltFired) {
          this.dozeJoltFired = true;
          this.squashSpring.kick(-2.2);
          this.headTiltSpring.kick(-act.side * 1.6);
          this.earPerkSpring.kick(2.6);
          this.earTwitchLeft = 1;
          this.earTwitchRight = 1;
        }
        const post = (actU - 0.54) / 0.46;
        // Wide awake startled glance left/right, then soft sleepy blink at end
        targetDozeLid = post > 0.72 ? Math.sin(((post - 0.72) / 0.28) * Math.PI) * 0.75 : 0;
        targetDozeNod = -0.18 * (1 - smoothstep(0, 0.35, post));
        dozeTilt = -act.side * 0.12 * Math.sin(Math.min(1, post / 0.55) * Math.PI);
      }
    } else if (act && act.kind === 'yawn') {
      targetYawn = smoothstep(0.06, 0.34, actU) * (1 - smoothstep(0.68, 0.94, actU));
      if (actU > 0.82 && actU < 0.96) {
        // Cute tiny post-yawn satisfaction shiver
        dozeTilt = Math.sin((actU - 0.82) * 58) * 0.08 * (1 - (actU - 0.82) / 0.14);
      }
    } else if (act && act.kind === 'stretch') {
      targetStretch = smoothstep(0.06, 0.28, actU) * (1 - smoothstep(0.74, 0.96, actU));
    } else if (act && act.kind === 'groom') {
      targetGroom = smoothstep(0.0, 0.14, actU) * (1 - smoothstep(0.86, 1.0, actU));
      if (actU >= 0.12 && actU < 0.44) {
        // 2 rhythmic paw licks
        const lp = ((actU - 0.12) / 0.32) * 2;
        const beat = Math.sin((lp % 1) * Math.PI);
        targetGroomLick = beat;
        groomHeadBob = beat * 0.45;
        groomHeadTilt = act.side * 0.13;
      } else if (actU >= 0.44 && actU < 0.84) {
        // 2 sweeping face-wash wipes pressing the same-side ear softly down!
        const wp = ((actU - 0.44) / 0.40) * 2;
        const frac = wp % 1;
        const earContact = Math.sin(smoothstep(0.18, 0.78, frac) * Math.PI);
        if (act.side < 0) targetEarPressL = earContact;
        else targetEarPressR = earContact;
        groomHeadTilt = act.side * (-0.10 + Math.sin(frac * Math.PI) * 0.18);
      } else if (actU >= 0.84 && !this.groomSparkleSpawned) {
        this.groomSparkleSpawned = true;
        const headPt = this.spinePoint(0.24, 0);
        for (const k of [0, 1]) {
          this.fxParticles.push({
            kind: 'sparkle',
            x: headPt.x + act.side * (34 + k * 14),
            y: headPt.y - 10 + k * 16,
            vx: act.side * (10 + k * 6),
            vy: -18 - k * 8,
            size: 10 - k * 2,
            createdAt: now,
            lifetime: 640,
          });
        }
      }
    } else if (act && act.kind === 'knead') {
      targetKnead = smoothstep(0.0, 0.14, actU) * (1 - smoothstep(0.84, 1.0, actU));
      this.kneadPhase += dt * 4.4;
    }

    const vigLerp = 1 - Math.exp(-12 * dt);
    this.dozeLidClose += (targetDozeLid - this.dozeLidClose) * vigLerp;
    this.dozeNod += (targetDozeNod - this.dozeNod) * (1 - Math.exp(-9 * dt));
    this.yawnAmount += (targetYawn - this.yawnAmount) * vigLerp;
    this.stretchAmount += (targetStretch - this.stretchAmount) * (1 - Math.exp(-8 * dt));
    this.groomAmount += (targetGroom - this.groomAmount) * vigLerp;
    this.groomLickAmount += (targetGroomLick - this.groomLickAmount) * (1 - Math.exp(-18 * dt));
    this.groomEarPressLeft += (targetEarPressL - this.groomEarPressLeft) * (1 - Math.exp(-16 * dt));
    this.groomEarPressRight += (targetEarPressR - this.groomEarPressRight) * (1 - Math.exp(-16 * dt));
    this.kneadAmount += (targetKnead - this.kneadAmount) * (1 - Math.exp(-9 * dt));

    // 2) Staggered 240Hz spring posture (body & hunch follow a beat behind head & eyes!)
    const peekCalm = 1 - peekClamped;
    const targetHunch = scruffClamped > 0.1 || peekWanted
      ? 0
      : isTypingRecently
        ? 0.45 + this.typingEnergy * 0.55
        : curiousClamped * 0.28 + groomHeadBob * 0.52 + this.kneadAmount * 0.24;
    this.typingHunch = Math.max(0, Math.min(1.2, this.hunchSpring.step(targetHunch * peekCalm, dt)));
    this.squashSpring.step(
      (this.sleepAmount * 0.35 -
        curiousClamped * 0.25 -
        this.yawnAmount * 0.30 -
        this.stretchAmount * 0.38 -
        scruffClamped * 0.28) *
        peekCalm,
      dt,
    );

    const rockAcc = -this.strikeRock * 140 - this.strikeRockVel * 14;
    this.strikeRockVel += rockAcc * dt;
    this.strikeRock = Math.max(-1, Math.min(1, this.strikeRock + this.strikeRockVel * dt));

    this.bodyBob = Math.max(0, this.bodyBob - dt * 11.5);
    this.kbBounce = Math.max(0, this.kbBounce - dt * 15);

    // Playful left-right body & head groove sway during pure typing (damped while peeking).
    const pureTypingActive =
      !peekWanted &&
      this.deviceMode === 'keyboard' &&
      isTypingRecently &&
      this.leftPaw.mode !== 'mouse';
    if (pureTypingActive) {
      this.typingGroovePhase += dt * (4.8 + this.typingEnergy * 5.2);
    }
    const grooveWave = Math.sin(this.typingGroovePhase) * (0.58 + this.typingEnergy * 0.44);
    const kneadSway = this.kneadAmount > 0.05 ? Math.sin(this.kneadPhase) * 0.22 * this.kneadAmount : 0;
    const targetTypingSway = peekWanted
      ? 0
      : this.deviceMode !== 'keyboard'
        ? 0
        : pureTypingActive
          ? Math.max(-1.1, Math.min(1.1, grooveWave * 0.72 + this.lastKeyBias * 0.55))
          : this.leftPaw.mode === 'mouse' && isTypingRecently
            ? Math.sin(this.typingGroovePhase) * 0.16
            : kneadSway;
    const swayAcc = (targetTypingSway * peekCalm - this.typingSway) * 118 - this.typingSwayVel * 12.5;
    this.typingSwayVel += swayAcc * dt;
    this.typingSway = Math.max(-1.2, Math.min(1.2, this.typingSway + this.typingSwayVel * dt));

    // Measured spine-shear lean via 240Hz spring (1.9 Hz -> organic weighty follow-through!)
    let targetLean = 0;
    if (!peekWanted && this.leftPaw.mode === 'mouse') {
      const mouseSweepBias = (this.mouseOffsetX / 18) * 0.22;
      targetLean = this.rightPaw.mode === 'poke'
        ? -0.52 + mouseSweepBias
        : -0.96 + mouseSweepBias;
    } else if (!peekWanted && this.deviceMode === 'gamepad') {
      const pad = this.getActiveGamepad();
      const stickX = pad ? (pad.axes[0] ?? 0) : 0;
      targetLean = Math.max(-0.36, Math.min(0.36, stickX * 0.24));
    } else if (!peekWanted && this.deviceMode === 'tablet') {
      targetLean = Math.max(
        -0.2,
        Math.min(0.2, (this.getTabletPenPoint(now).x - this.logicalW * 0.5) / 300),
      );
    } else if (!peekWanted && this.catTail.reach > 0.05) {
      const tailDir = Math.max(-1, Math.min(1, (this.catTail.tipX - this.catCenterX) / (this.kbWidth * 0.5)));
      targetLean = tailDir * 0.14 * this.catTail.reach;
    }
    this.spineLean = this.spineLeanSpring.step(targetLean * peekCalm, dt);

    // Stable neutral eye reference (no feedback wobble when spine leans toward the mouse!)
    const eyeRefRelX = this.catCenterX / this.logicalW;
    const eyeRefRelY = (this.catTopY + 0.24 * this.catHeight) / this.logicalH;
    const rawDx = this.cursorRelX - eyeRefRelX;
    const rawDy = this.cursorRelY - eyeRefRelY;
    // Smooth asymptotic curve (-1..+1): responsive near the face, buttery easing across the whole screen (zero hard kink!)
    const gx = Math.tanh(rawDx * 2.15);
    const gy = Math.tanh(rawDy * 2.05);

    const wakeElapsed = (now - this.wakeAt) / 1000;
    const wakeShake =
      wakeElapsed >= 0 && wakeElapsed < 0.55
        ? Math.sin(wakeElapsed * 36) * 0.18 * (1 - wakeElapsed / 0.55)
        : 0;
    const fidgetTilt = act && act.kind === 'tilt' ? act.side * 0.19 * actEnv : 0;
    // Continuous smooth head cock when curious (never snaps left/right across dx=0!)
    const curiousCock = curiousClamped * 0.16 * gx;
    const sleepTilt = this.sleepAmount * 0.08;
    const chinSway = this.chinAmount > 0.05 ? Math.sin(this.elapsed * 3.4) * 0.10 * this.chinAmount : 0;
    const scruffTilt = -scruffClamped * this.scruffSwing * 0.16;
    const desiredHeadTilt =
      this.typingSway * 0.18 +
      this.typingHunch * (this.strikeRock * 0.065 - 0.02) +
      this.spineLean * 0.085 +
      fidgetTilt +
      curiousCock +
      sleepTilt +
      dozeTilt +
      groomHeadTilt +
      chinSway +
      scruffTilt;
    this.headTilt = this.headTiltSpring.step(desiredHeadTilt, dt) + wakeShake + this.boopShake;

    this.petEnergy = Math.max(0, this.petEnergy - dt * (this.cursorOverCat ? 0.22 : 1.15));
    this.lastDt = dt;
    const wantSquint = (this.petEnergy > 0.3 || this.chinAmount > 0.25 || this.kneadAmount > 0.3) && !this.isCross && !scruffWanted ? 1 : 0;
    this.squintAmount += (wantSquint - this.squintAmount) * (1 - Math.exp(-12 * dt));
    const wantPrivacy = this.privacyMode ? 1 : 0;
    this.privacyClose += (wantPrivacy - this.privacyClose) * (1 - Math.exp(-14 * dt));
    if (this.catBreed !== 'dafeiyu' && !this.privacyMode && !scruffWanted) {
      if (this.chinAmount > 0.25) {
        catAudio.setPurrIntensity(this.chinAmount, 'chin');
      } else if (this.petEnergy > 0.3 && this.squintAmount > 0.25) {
        catAudio.setPurrIntensity(this.squintAmount, 'normal');
      } else if (this.kneadAmount > 0.25) {
        catAudio.setPurrIntensity(this.kneadAmount * 0.72, 'knead');
      } else {
        catAudio.setPurrIntensity(0);
      }
    } else {
      catAudio.setPurrIntensity(0);
    }

    // Dynamic ear spring (5.2Hz, damping 0.36): perks up when curious/excited, flattens into airplane ears when cross, droops gently when scruffed or yawning!
    const earTarget = isCatMode
      ? 0.12 * this.typingEnergy * (1 - this.crossAmount) +
        0.16 * curiousClamped +
        0.14 * peekClamped * (0.4 + 0.6 * this.peekHover) -
        0.18 * this.squintAmount -
        0.58 * this.crossAmount -
        0.22 * scruffClamped -
        0.26 * this.yawnAmount -
        0.22 * this.stretchAmount -
        0.12 * this.sleepAmount
      : 0;
    this.earPerkSpring.step(earTarget, dt);

    if (this.catBreed === 'dafeiyu') {
      this.dafeiyu.update(dt, now, this.buildDaFeiYuLayout());
    } else {
      // Update plush cat tail key-patting physics for keys near the tail
      if (this.privacyMode || this.asleep) {
        this.catTail.active = false;
        this.catTail.heldVks.clear();
        this.clearTabletTailKeys();
      }
      const tailAge = Math.max(0, now - this.catTail.tapAt);
      const sinceLastPat = now - this.catTail.patAt;
      const tailPressing =
        this.catTail.active && (this.catTail.heldVks.size > 0 || sinceLastPat < 155);
      const sinceTailRelease =
        this.catTail.heldVks.size > 0
          ? 0
          : Math.max(0, now - Math.max(this.catTail.patAt + 155, this.catTail.releaseAt));
      if (this.catTail.active && !tailPressing && sinceTailRelease > 460) {
        this.catTail.active = false;
        this.clearTabletTailKeys();
      }

      const targetReach = this.catTail.active ? 1 : 0;
      const reachRate = this.catTail.active ? 28 : 9.5;
      this.catTail.reach += (targetReach - this.catTail.reach) * (1 - Math.exp(-reachRate * dt));
      if (this.catTail.reach < 0.002 && !this.catTail.active) this.catTail.reach = 0;

      let targetHover = 0;
      if (this.catTail.active) {
        if (tailAge < 75) {
          targetHover = Math.sin((tailAge / 75) * Math.PI) * 24;
        } else if (tailPressing) {
          targetHover = 0;
        } else {
          targetHover = 13 + Math.sin(now * 0.012) * 2.2;
        }
      }
      const hoverRate = tailAge < 75 ? 45 : tailPressing ? 52 : 16;
      this.catTail.hover += (targetHover - this.catTail.hover) * (1 - Math.exp(-hoverRate * dt));

      const tipFollow = 1 - Math.exp(-34 * dt);
      this.catTail.tipX += (this.catTail.targetX - this.catTail.tipX) * tipFollow;
      this.catTail.tipY += (this.catTail.targetY - this.catTail.tipY) * tipFollow;
      this.catTail.impactSquash = Math.max(0, this.catTail.impactSquash - dt * 6.5);

      // Smooth the near/far bezier blend used by drawTail() so hand-alternating typing sweeps the tail
      // silhouette around the hip instead of flickering between two shapes on every keystroke.
      const tailStartX = this.spinePoint(0.84, 0).x + 56;
      const tipRel = tailStartX - 10 - this.catTail.tipX;
      const targetCrossLeft = Math.max(0, Math.min(1, tipRel / (this.kbWidth * 0.65)));
      this.tailCrossLeft +=
        (targetCrossLeft - this.tailCrossLeft) * (1 - Math.exp(-TAIL_CROSS_BLEND_RATE * dt));

      // Rhythmic 3-beat grumpy tail desk-thump when cross (lift slowly -> slam hard -> bounce keyboard & dust puffs!)
      let targetThumpLift = 0;
      let targetThumpLash = 0;
      if (this.crossAmount > 0.08 && this.catTail.reach < 0.25) {
        const prevPhase = this.thumpPhase;
        this.thumpPhase += dt * 2.55;
        const beat = Math.floor(this.thumpPhase);
        const u = this.thumpPhase - beat;
        const restingBeat = beat % 4 === 3;
        if (!restingBeat) {
          targetThumpLift =
            u < 0.58
              ? smoothstep(0, 0.58, u)
              : u < 0.72
                ? 1 - ((u - 0.58) / 0.14) ** 2
                : 0;
        }
        targetThumpLash = Math.sin(this.thumpPhase * Math.PI * 0.5);
        const slamAt = beat + 0.72;
        if (!restingBeat && this.isCross && prevPhase < slamAt && this.thumpPhase >= slamAt) {
          this.onTailDeskSlam(now);
        }
      }
      this.thumpLift += (targetThumpLift - this.thumpLift) * (1 - Math.exp(-38 * dt));
      this.thumpLash += (targetThumpLash - this.thumpLash) * (1 - Math.exp(-18 * dt));
    }

    this.deskHopY = this.deskHopSpring.step(0, dt);
    this.headsetSpring.step(this.headphonesOn ? 1 : 0, dt);

    // Floating sleepy comic "Z" particles when asleep
    if (isCatMode && this.sleepAmount > 0.68 && now >= this.nextZAt) {
      this.nextZAt = now + 1350;
      const headPt = this.spinePoint(0.18, 0);
      this.fxParticles.push({
        kind: 'z',
        x: headPt.x + 42,
        y: headPt.y - 18,
        vx: 9,
        vy: -24,
        size: 13,
        createdAt: now,
        lifetime: 2400,
      });
    }

    // Update FX particles (impact starburst, dust puffs, sleep Zzz)
    for (let i = this.fxParticles.length - 1; i >= 0; i--) {
      const fx = this.fxParticles[i];
      if (now - fx.createdAt >= fx.lifetime) {
        this.fxParticles.splice(i, 1);
        continue;
      }
      fx.x += fx.vx * dt;
      fx.y += fx.vy * dt;
      if (fx.kind === 'dust') {
        fx.vx *= Math.exp(-2.2 * dt);
        fx.vy *= Math.exp(-1.5 * dt);
      }
    }

    // Note: active emotional/physics transitions (curious, cross, scruff, boop, chin, tail poke,
    // edge-peek slide, sleep transition, wake shake, desk hop, non-Z FX) and ambient gaze/fidgets
    // are evaluated directly by computePacingTier() so they never tack an extra 2.2s of 60 FPS
    // tail-off onto finished transitions, settled edge-peek, or sleep entry.

    this.earTwitchLeft = Math.max(0, this.earTwitchLeft - dt * 8);
    this.earTwitchRight = Math.max(0, this.earTwitchRight - dt * 8);

    // Pause blinking while staring curiously at fast cursor!
    if (curiousNow && this.elapsed >= this.nextBlinkAt - 0.2) {
      this.nextBlinkAt = this.elapsed + 0.6;
    }
    if (!this.isBlinking && this.elapsed >= this.nextBlinkAt) {
      this.isBlinking = true;
      this.blinkProgress = 0;
    }
    if (this.isBlinking) {
      this.blinkProgress += dt * 12;
      if (this.blinkProgress >= 2) {
        this.isBlinking = false;
        this.blinkProgress = 0;
        this.nextBlinkAt = this.elapsed + 2.8 + Math.random() * 3.6;
      }
    }

    // 3) Silky normalized eye tracking (9.5Hz critically-damped -> liquid follow!) & 2.5D face turn (2.9Hz -> follows a beat behind!)
    const cursorRecentlyMoved =
      now - this.lastCursorEyeAt < 2400 || now - this.lastMouseMoveAt < 2400;
    const pureTypingGlance = cursorRecentlyMoved || curiousNow ? 0 : this.typingHunch;
    let targetGazeX =
      gx * (1 - pureTypingGlance * 0.45) +
      pureTypingGlance * Math.max(-1, Math.min(1, this.typingSway * 0.55 + this.lastKeyBias * 0.32));
    let targetGazeY =
      gy * (1 - pureTypingGlance * 0.45) + pureTypingGlance * 0.72;

    if (act && act.kind === 'look') {
      targetGazeX = targetGazeX * (1 - actEnv) + act.side * 0.85 * actEnv;
      targetGazeY = targetGazeY * (1 - actEnv) - 0.22 * actEnv;
    }
    if (act && act.kind === 'doze' && actU >= 0.54) {
      const post = (actU - 0.54) / 0.46;
      const glance = Math.sin(Math.min(1, post / 0.65) * Math.PI * 2) * 0.72;
      targetGazeX = glance;
      targetGazeY = -0.14;
    }
    if (this.tailGlanceAmount > 0.05) {
      targetGazeX = targetGazeX * (1 - this.tailGlanceAmount * 0.85) + 0.92 * this.tailGlanceAmount * 0.85;
      targetGazeY = targetGazeY * (1 - this.tailGlanceAmount * 0.6) + 0.35 * this.tailGlanceAmount * 0.6;
    }
    if (this.crossAmount > 0.05) {
      // Stable huffy side-glance (locked direction -> zero sudden left/right snap when cursor crosses center!)
      const huffX = this.crossHuffDir * 0.72 * this.crossAmount;
      targetGazeX = targetGazeX * (1 - this.crossAmount * 0.62) + huffX * 0.62;
    }
    this.eyeLookX = Math.max(-1.05, Math.min(1.05, this.eyeXSpring.step(targetGazeX, dt)));
    this.eyeLookY = Math.max(-1.05, Math.min(1.05, this.eyeYSpring.step(targetGazeY, dt)));

    const huffFace = this.crossAmount * this.crossHuffDir * 7.5;
    const lookFace = act && act.kind === 'look' ? act.side * 5.5 * actEnv : 0;
    const tailGlanceFace = this.tailGlanceAmount * 7.0;
    const targetFaceTurn =
      gx * (5.2 + curiousClamped * 3.8) * (1 - this.crossAmount * 0.75) * (1 - this.tailGlanceAmount * 0.7) +
      huffFace +
      lookFace +
      tailGlanceFace +
      this.spineLean * 8.0 +
      this.typingSway * 8.5 +
      pureTypingGlance * 1.5;
    this.faceTurnX = this.faceTurnSpring.step(targetFaceTurn, dt);

    for (const anim of this.keyAnims.values()) {
      if (!anim.pressed && anim.pressAmount > 0) {
        anim.pressAmount = Math.max(0, anim.pressAmount - dt * 5.0);
      }
    }

    this.updatePaw(this.leftPaw, dt, now);
    this.updatePaw(this.rightPaw, dt, now);

    const beforeLen = this.bubbles.length;
    this.bubbles = this.bubbles.filter((b) => now - b.createdAt < b.lifetime);
    if (this.bubbles.length !== beforeLen) {
      this.layoutBubbles();
    }
    for (const b of this.bubbles) {
      const age = (now - b.createdAt) / b.lifetime;
      b.x += (b.targetX - b.x) * (1 - Math.exp(-18 * dt));
      const desiredY = b.targetY - age * 10;
      b.y += (desiredY - b.y) * (1 - Math.exp(-16 * dt));
    }
  }

  private latestHeldKeyFor(
    side: 'left' | 'right',
  ): { side: 'left' | 'right'; specId: string; x: number; y: number; at: number } | null {
    let best: { side: 'left' | 'right'; specId: string; x: number; y: number; at: number } | null =
      null;
    for (const entry of this.heldKeys.values()) {
      if (entry.side === side && (!best || entry.at >= best.at)) {
        best = entry;
      }
    }
    return best;
  }

  private updatePaw(paw: PawState, dt: number, now: number): void {
    const liveMouseX = this.mouseBaseX + this.mouseOffsetX;
    const liveMouseY = this.mouseBaseY + this.mouseOffsetY;
    const heldKey = this.latestHeldKeyFor(paw.side);
    const sideSign = paw.side === 'left' ? -1 : 1;
    const act = this.idleAct;
    const actU = act ? Math.max(0, Math.min(1, (now - act.t0) / act.dur)) : 0;

    // Special posture overrides: scruffed dangle > edge-peek grip > groom face-wash > keyboard stretch > biscuit knead
    if (this.scruffAmount > 0.14 && !this.privacyMode) {
      paw.mode = 'scruff';
      const chestSp = this.spinePoint(0.72, 0);
      const clampedSwing = Math.max(-1.6, Math.min(1.6, this.scruffSwing));
      const dangleSway = clampedSwing * 7.5 + Math.sin(this.elapsed * 5.2 + sideSign * 0.7) * 2.5;
      paw.target = {
        x: chestSp.x + sideSign * 22 + dangleSway,
        y: chestSp.y + 8 + Math.abs(clampedSwing) * 2.0,
      };
    } else if (this.peekAmount > 0.22) {
      // Keep internal paw anchor parked cleanly at seated idle base so exiting side-peek never flashes a floating arm!
      paw.mode = 'peek';
      const baseSp = this.spinePoint(1.0, 0);
      paw.target = { x: baseSp.x + sideSign * 19, y: baseSp.y };
      paw.idleWeight = 1;
    } else if (
      act &&
      act.kind === 'groom' &&
      ((act.side < 0 && paw.side === 'left') || (act.side > 0 && paw.side === 'right')) &&
      this.groomAmount > 0.08 &&
      !heldKey
    ) {
      paw.mode = 'groom';
      const headPt = this.spinePoint(0.24, 0);
      const mouthX = headPt.x + this.faceTurnX * 0.55 + sideSign * 14;
      const mouthY = headPt.y + 20;
      if (actU < 0.44) {
        // Phase 1: raise paw to mouth & bob gently while licking
        const lickBeat = actU > 0.12 ? Math.sin((((actU - 0.12) / 0.32) * 2 % 1) * Math.PI) : 0;
        paw.target = {
          x: mouthX,
          y: mouthY - lickBeat * 5.5,
        };
      } else {
        // Phase 2: lift high over ear & wipe smoothly down across cheek twice!
        const wp = Math.min(1.999, ((actU - 0.44) / 0.40) * 2);
        const frac = wp % 1;
        if (frac < 0.35) {
          const u = frac / 0.35;
          paw.target = {
            x: mouthX + sideSign * 26 * u,
            y: mouthY - 52 * u,
          };
        } else {
          const u = (frac - 0.35) / 0.65;
          paw.target = {
            x: headPt.x + sideSign * (42 - u * 16),
            y: headPt.y - 34 + u * 50,
          };
        }
      }
    } else if (this.stretchAmount > 0.10 && !heldKey && paw.mode !== 'mouse') {
      paw.mode = 'stretch';
      const kbTopY = this.kbCenterY - this.kbHeight * 0.28;
      const reach = this.stretchAmount;
      paw.target = {
        x: this.catCenterX + sideSign * (24 + reach * 34),
        y: this.catBaseY + reach * (kbTopY - this.catBaseY + 12),
      };
    } else if (this.kneadAmount > 0.10 && !heldKey && paw.mode !== 'mouse') {
      paw.mode = 'knead';
      const phase = this.kneadPhase + (paw.side === 'left' ? 0 : Math.PI);
      const lift = Math.max(0, Math.sin(phase));
      const press = Math.max(0, -Math.sin(phase));
      const rimY = this.kbCenterY - this.kbHeight * 0.36;
      paw.target = {
        x: this.catCenterX + sideSign * 28,
        y: rimY - lift * 13 + press * 3.5,
      };
      if (press > 0.72) {
        paw.impactSquash = Math.max(paw.impactSquash, press * 0.55);
      }
    } else if (
      paw.mode === 'scruff' ||
      paw.mode === 'peek' ||
      paw.mode === 'groom' ||
      paw.mode === 'stretch' ||
      paw.mode === 'knead'
    ) {
      paw.mode = heldKey ? 'poke' : 'idle';
    }

    if (paw.mode === 'pad' && this.deviceMode !== 'gamepad') paw.mode = 'idle';
    if (paw.mode === 'pen' && this.deviceMode !== 'tablet') paw.mode = 'idle';

    if (paw.mode === 'mouse') {
      const lrBias = this.mouseLeftPress - this.mouseRightPress;
      const anyClickPress = Math.max(this.mouseLeftPress, this.mouseRightPress, this.mouseMiddlePress);
      // Mouse always stays cat-facing (#92): palm heel at TOP, LMB = inner/+X, RMB = outer/-X
      paw.target = {
        x: liveMouseX + 1.2 + lrBias * 6.4,
        y: liveMouseY - 11.5 + anyClickPress * 3.6,
      };
      const stillHolding =
        this.mouseLeftDown ||
        this.mouseRightDown ||
        this.mouseMiddleDown ||
        now - this.lastMouseMoveAt < 2200;
      if (!stillHolding) {
        paw.mode = heldKey ? 'poke' : 'idle';
      }
    } else if (
      paw.mode !== 'scruff' &&
      paw.mode !== 'peek' &&
      paw.mode !== 'groom' &&
      paw.mode !== 'stretch' &&
      paw.mode !== 'knead'
    ) {
      if (heldKey) {
        // Keep paw pressed down onto the held keycap until keyUp (Fixes #3)
        paw.mode = 'poke';
        paw.target = { x: heldKey.x, y: heldKey.y };
        paw.pokeTime = Math.min(paw.pokeTime + dt, 0.10);
        paw.lastActiveAt = now;
      } else if (paw.mode === 'poke') {
        paw.pokeTime += dt;
        if (paw.pokeTime > 0.13) {
          if (paw.side === 'left' && (this.mouseLeftDown || this.mouseRightDown || now - this.lastMouseMoveAt < 450)) {
            paw.mode = 'mouse';
          } else if (now - this.lastAnyKeyAt < 650 || this.heldKeys.size > 0) {
            paw.mode = 'curled';
          } else {
            paw.mode = 'idle';
          }
        }
      } else if (paw.mode === 'curled') {
        if (now - this.lastAnyKeyAt > 680 && this.heldKeys.size === 0) {
          paw.mode = 'idle';
        }
      }

      if (paw.mode === 'curled') {
        paw.target = this.getLiveCurledPawPos(paw, 0);
      } else if (paw.mode === 'idle') {
        const baseSp = this.spinePoint(1.0, 0);
        paw.target = { x: baseSp.x + (paw.side === 'left' ? -19 : 19), y: baseSp.y };
      }
    }

    const wantIdle = paw.mode === 'idle' ? 1 : 0;
    const wantCurl = paw.mode === 'curled' ? 1 : 0;
    const blendRate = 1 - Math.exp(-20 * dt);
    paw.idleWeight += (wantIdle - paw.idleWeight) * blendRate;
    paw.curlWeight += (wantCurl - paw.curlWeight) * blendRate;

    // Unconditionally stable, framerate-independent tracking (ZERO Euler spring overshoot at any FPS!)
    const followRate =
      paw.mode === 'poke'
        ? 42
        : paw.mode === 'mouse'
          ? 32
          : paw.mode === 'groom' || paw.mode === 'knead' || paw.mode === 'scruff'
            ? 24
            : paw.mode === 'pad' || paw.mode === 'pen'
              ? 36
            : 22;
    const follow = 1 - Math.exp(-followRate * dt);
    paw.pos.x += (paw.target.x - paw.pos.x) * follow;
    paw.pos.y += (paw.target.y - paw.pos.y) * follow;
    paw.vel.x = 0;
    paw.vel.y = 0;

    // Hard guarantee: while poking a key, paw tip stays strictly on top of the keyboard surface
    if (paw.mode === 'poke') {
      const clamped = this.clampToKeyboardSurface(paw.pos);
      if (clamped.y < paw.pos.y || Math.abs(clamped.x - paw.pos.x) > 0.01) {
        paw.pos.x = clamped.x;
        paw.pos.y = Math.min(paw.pos.y, clamped.y);
      }
    }

    paw.impactSquash = Math.max(0, paw.impactSquash - dt * 7.5);

    for (const s of paw.smears) {
      s.alpha -= dt * 3.8;
    }
    paw.smears = paw.smears.filter((s) => s.alpha > 0.02);
  }

  // ---- High-fidelity true-scale rendering ----

  private render(): void {
    const ctx = this.ctx;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    if (this.chromaKeyBg) {
      ctx.fillStyle = this.chromaKeyBg;
      ctx.fillRect(0, 0, cw, ch);
    } else {
      ctx.clearRect(0, 0, cw, ch);
    }

    ctx.save();
    const { offsetX, offsetY, uniformScale } = this.getViewportTransform();
    ctx.translate(offsetX, offsetY);
    ctx.scale(uniformScale, uniformScale);

    const breath = Math.sin(this.breathPhase) * (1.0 + this.sleepAmount * 0.65);
    const purrShift = this.squintAmount > 0.4 ? Math.sin(this.elapsed * 22) * 0.45 * this.squintAmount : 0;

    if (this.catBreed === 'dafeiyu') {
      const now = performance.now();
      const layout = this.buildDaFeiYuLayout();
      const peekP = Math.max(0, Math.min(1, this.peekAmount));

      // Layer 1: BigFish sprite & Live2D eyes (rotated out cleanly from the screen border while peeking)
      ctx.save();
      if (peekP > 0.004) {
        const { tx, ty, rot, pivotX, pivotY } = this.peekTransform;
        ctx.translate(pivotX + tx, pivotY + ty);
        ctx.rotate(rot);
        ctx.translate(-pivotX, -pivotY);
      }
      this.dafeiyu.renderBody(ctx, now, layout, peekP);
      ctx.restore();

      // Layer 2: Foreground desk device (slide & fade cleanly away in Edge Peek Mode)
      if (peekP < 0.78) {
        ctx.save();
        if (peekP > 0.01) {
          ctx.globalAlpha = Math.max(0, 1 - peekP * 1.35);
          ctx.translate(0, peekP * 54);
        }
        this.drawDeskDevice(ctx);
        ctx.restore();
      }

      // Layer 3: Keyboard arms & whale slap fade smoothly out as she hides on the screen edge
      if (peekP < 0.35) {
        ctx.save();
        if (peekP > 0.004) {
          const { tx, ty, rot, pivotX, pivotY } = this.peekTransform;
          ctx.translate(pivotX + tx, pivotY + ty);
          ctx.rotate(rot);
          ctx.translate(-pivotX, -pivotY);
        }
        if (peekP > 0.01) {
          ctx.globalAlpha = Math.max(0, 1 - peekP * 3.0);
        }
        if (this.deviceMode === 'tablet') this.drawTabletPen(ctx);
        this.dafeiyu.renderForeground(ctx, this.lastDt, now, layout);
        if (this.deviceMode === 'gamepad') this.drawGamepadStickRings(ctx);
        ctx.restore();
      }

      // Layer 4: Screen-border-aligned chibi sailor hands wrapping flush around the vertical left/right edge
      if (peekP > 0.22) {
        const s = Math.max(0.001, uniformScale);
        const leftEdge = -offsetX / s;
        const rightEdge = (cw - offsetX) / s;
        const topEdge = -offsetY / s;
        const bottomEdge = (ch - offsetY) / s;
        const midY = (topEdge + bottomEdge) * 0.5;
        const isLeft = this.peekVisualEdge === 'left';
        const edgeX = isLeft ? leftEdge : rightEdge;
        this.dafeiyu.renderEdgePeekHands(ctx, edgeX, midY, isLeft, peekP, now);
      }

      // Layer 5: Device bubbles (hidden while peeking)
      if (this.showKeyBubbles && !this.privacyMode && peekP < 0.4) {
        if (this.deviceMode === 'keyboard') {
          this.drawKeyBubbles(ctx);
          this.drawMouseBadges(ctx);
        } else if (this.deviceMode === 'gamepad') {
          this.drawPadBubbles(ctx);
        } else if (this.deviceMode === 'tablet') {
          this.drawTabletBadges(ctx);
        }
      }
      ctx.restore();
      return;
    }

    // Layer 1: Foreground desk device (slide & fade cleanly away in Edge Peek Mode!)
    const peekP = Math.max(0, Math.min(1, this.peekAmount));
    if (peekP < 0.78) {
      ctx.save();
      if (peekP > 0.01) {
        ctx.globalAlpha = Math.max(0, 1 - peekP * 1.35);
        ctx.translate(0, peekP * 54);
      }
      this.drawDeskDevice(ctx);
      ctx.restore();
    }

    // Apply Edge-Peek transform to cat + paws + FX so ONLY the cat head & gripping paws peek cleanly from the screen border!
    ctx.save();
    if (peekP > 0.004) {
      const { tx, ty, rot, pivotX, pivotY } = this.peekTransform;
      ctx.translate(pivotX + tx, pivotY + ty);
      ctx.rotate(rot);
      ctx.translate(-pivotX, -pivotY);
    }

    // Layer 2: Plush cat tail (tucks away cleanly when peeking from edge!)
    if (peekP < 0.55) {
      ctx.save();
      if (peekP > 0.02) ctx.globalAlpha = Math.max(0, 1 - peekP * 1.9);
      this.drawTail(ctx);
      ctx.restore();
    }

    // Layer 3: Exact measured spine-deformable cat silhouette (ears, cheeks, neck, pear belly, grounded hind feet, eyes & tiny whiskers)
    this.drawCatBody(ctx, breath, purrShift);

    // Layer 4: The stylus the cat holds. It is drawn before the paws so the paw
    // wraps the grip instead of the pen floating on top of the fur.
    if (this.deviceMode === 'tablet') this.drawTabletPen(ctx);

    // Layer 5: True-scale velvety cat paws (tapered idle legs / planted diagonal mouse support leg / bent curled chest paw / plump round poking paw!)
    this.drawPaw(ctx, this.leftPaw, breath);
    this.drawPaw(ctx, this.rightPaw, breath);
    if (this.deviceMode === 'gamepad') this.drawGamepadStickRings(ctx);

    // Layer 4.5: Alive cat comic FX (anger 💢 mark, tail-slam starburst & dust puffs, sleepy Zzz bubbles)
    this.drawCatAliveFx(ctx, performance.now(), breath);
    ctx.restore();

    // Layer 4.8: Screen-edge-aligned 2D gripping paws hugging flush around the vertical left/right screen border!
    if (peekP > 0.22) {
      this.drawScreenEdgePeekPaws(ctx, peekP);
    }

    // Layer 5: Organic bouncing 3D keycap bubbles & crisp mouse click badges (hidden while peeking)
    if (this.showKeyBubbles && !this.privacyMode && peekP < 0.4) {
      if (this.deviceMode === 'keyboard') {
        this.drawKeyBubbles(ctx);
        this.drawMouseBadges(ctx);
      } else if (this.deviceMode === 'gamepad') {
        this.drawPadBubbles(ctx);
      } else if (this.deviceMode === 'tablet') {
        this.drawTabletBadges(ctx);
      }
    }

    ctx.restore();
  }

  private onTailDeskSlam(now: number): void {
    this.lastSlamAt = now;
    const hipRight = this.spinePoint(0.84, 0);
    const slamX = Math.min(this.logicalW - 22, hipRight.x + 132);
    const slamY = hipRight.y + 30;

    // Comic white starburst impact + 3 playful dust puffs!
    this.fxParticles.push({
      kind: 'bang',
      x: slamX,
      y: slamY - 4,
      vx: 0,
      vy: -8,
      size: 16,
      createdAt: now,
      lifetime: 240,
    });
    for (const s of [-1, 0, 1]) {
      this.fxParticles.push({
        kind: 'dust',
        x: slamX + s * 6,
        y: slamY,
        vx: s * 36 + (Math.random() - 0.5) * 14,
        vy: -24 - Math.random() * 18,
        size: 6.5 + Math.random() * 2.5,
        createdAt: now,
        lifetime: 460,
      });
    }
    this.deskHopSpring.kick(-38);
    this.squashSpring.kick(2.4);
  }

  private drawCatAliveFx(ctx: CanvasRenderingContext2D, now: number, breath: number): void {
    // 1) Pulsing comic anger vein (💢) beside upper head when grumpy/cross
    if (this.crossAmount > 0.12 && !this.privacyMode) {
      const headPt = this.spinePoint(0.18, breath);
      const slamPulse = 1 + 0.24 * Math.max(0, 1 - (now - this.lastSlamAt) / 250);
      const sc = this.crossAmount * slamPulse;
      ctx.save();
      ctx.translate(headPt.x - 57 + this.faceTurnX * 0.4, headPt.y - 34);
      ctx.rotate(-0.14);
      ctx.scale(sc, sc);
      ctx.globalAlpha = Math.min(1, this.crossAmount * 1.1);
      ctx.lineCap = 'round';
      const drawVein = (color: string, width: number) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        const r = 5.2;
        const off = 6.0;
        ctx.beginPath();
        ctx.arc(-off, -off, r, 0.05 * Math.PI, 0.45 * Math.PI);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(off, -off, r, 0.55 * Math.PI, 0.95 * Math.PI);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(off, off, r, 1.05 * Math.PI, 1.45 * Math.PI);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(-off, off, r, 1.55 * Math.PI, 1.95 * Math.PI);
        ctx.stroke();
      };
      drawVein('#fbfaf3', 5.2);
      drawVein('#e2483d', 2.6);
      ctx.restore();
    }

    // 2) Impact starburst ('bang'), dust puffs ('dust'), sleepy 'Z' ('z'), chin hearts ('heart'), groom sparkles ('sparkle'), sneeze puffs ('sneeze')
    for (const fx of this.fxParticles) {
      const age = now - fx.createdAt;
      const u = Math.max(0, Math.min(1, age / fx.lifetime));
      ctx.save();
      if (fx.kind === 'bang') {
        const s = fx.size * (0.55 + 0.65 * Math.min(1, u / 0.35));
        const alpha = u < 0.45 ? 1 : Math.max(0, 1 - (u - 0.45) / 0.55);
        ctx.globalAlpha = alpha;
        ctx.translate(fx.x, fx.y);
        ctx.beginPath();
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2;
          const rad = i % 2 === 0 ? s : s * 0.46;
          if (i === 0) ctx.moveTo(Math.cos(a) * rad, Math.sin(a) * rad);
          else ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
        }
        ctx.closePath();
        ctx.fillStyle = '#fbfaf3';
        ctx.strokeStyle = '#1d1d1b';
        ctx.lineWidth = 2.0;
        ctx.fill();
        ctx.stroke();
      } else if (fx.kind === 'dust') {
        const r = fx.size * (0.65 + 0.85 * u);
        ctx.globalAlpha = 0.85 * (1 - u);
        ctx.fillStyle = '#f4f1e6';
        ctx.strokeStyle = '#b9b4a4';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else if (fx.kind === 'z') {
        const swayX = Math.sin(age * 0.0028) * 6.5;
        const sc = 0.72 + u * 0.55;
        const alpha = Math.min(1, u / 0.16) * Math.max(0, Math.min(1, (1 - u) / 0.25));
        ctx.globalAlpha = alpha;
        ctx.translate(fx.x + swayX, fx.y);
        ctx.scale(sc, sc);
        ctx.font = '800 18px "Comic Sans MS", "Segoe UI", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 4.2;
        ctx.strokeStyle = '#1d1d1b';
        ctx.strokeText('Z', 0, 0);
        ctx.fillStyle = '#fbfaf3';
        ctx.fillText('Z', 0, 0);
      } else if (fx.kind === 'heart') {
        const swayX = Math.sin(age * 0.0055) * 5.0;
        const pop = Math.min(1, u / 0.18);
        const sc = (0.65 + 0.45 * pop) * (1 - u * 0.15);
        const alpha = pop * Math.max(0, Math.min(1, (1 - u) / 0.30));
        ctx.globalAlpha = alpha;
        ctx.translate(fx.x + swayX, fx.y);
        ctx.scale(sc, sc);
        const r = fx.size * 0.55;
        ctx.beginPath();
        ctx.moveTo(0, r * 0.9);
        ctx.bezierCurveTo(-r * 1.45, -r * 0.1, -r * 1.1, -r * 1.35, 0, -r * 0.45);
        ctx.bezierCurveTo(r * 1.1, -r * 1.35, r * 1.45, -r * 0.1, 0, r * 0.9);
        ctx.closePath();
        ctx.fillStyle = '#ffcb52';
        ctx.strokeStyle = '#241f1c';
        ctx.lineWidth = 1.9;
        ctx.lineJoin = 'round';
        ctx.fill();
        ctx.stroke();
      } else if (fx.kind === 'sparkle') {
        const pop = Math.sin(u * Math.PI);
        const s = fx.size * (0.4 + 0.75 * pop);
        ctx.globalAlpha = Math.max(0, pop);
        ctx.translate(fx.x, fx.y);
        ctx.rotate(u * 0.75);
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          const rad = i % 2 === 0 ? s : s * 0.28;
          if (i === 0) ctx.moveTo(Math.cos(a) * rad, Math.sin(a) * rad);
          else ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
        }
        ctx.closePath();
        ctx.fillStyle = '#fff5b8';
        ctx.strokeStyle = '#332e22';
        ctx.lineWidth = 1.35;
        ctx.fill();
        ctx.stroke();
      } else if (fx.kind === 'sneeze') {
        const sc = 0.55 + u * 0.8;
        ctx.globalAlpha = Math.max(0, (1 - u) * 0.92);
        ctx.translate(fx.x, fx.y);
        ctx.scale(sc, sc);
        ctx.strokeStyle = '#fbfaf3';
        ctx.lineWidth = 3.2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(0, 0, fx.size * 0.55, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#e7f5ff';
        ctx.fill();
      }
      ctx.restore();
    }
  }

  private drawTail(ctx: CanvasRenderingContext2D): void {
    // Exact ORIG 0.3s resting tail S-hook, smoothly morphing into:
    //  1) playful arched swan-neck pat onto near-tail keys (catTail.reach),
    //  2) grumpy 3-beat rhythmic desk-thump (crossAmount),
    //  3) cozy tucked sleeping curl (sleepAmount), and
    //  4) subtle curious tip twitch / idle fidget flick!
    const now = performance.now();
    const act = this.idleAct;
    const actU = act ? Math.max(0, Math.min(1, (now - act.t0) / act.dur)) : 0;
    const tailFlick = act && act.kind === 'tail' ? Math.sin(actU * Math.PI * 2) * 7.5 : 0;
    const curiousTwitch =
      this.curiousAmount > 0.05
        ? Math.sin(this.elapsed * 14.5) * 4.2 * Math.min(1, this.curiousAmount)
        : 0;
    const swayAmp = (1.4 + this.typingEnergy * 2.2) * (1 - this.sleepAmount * 0.85);
    const gentleDrift = Math.sin(this.tailDriftPhase) * swayAmp;
    const hipRight = this.spinePoint(0.84, 0);

    const startX = hipRight.x + 56;
    const startY = hipRight.y - 2 + this.sleepAmount * 14;
    let restCp1X = startX + 34;
    let restCp1Y = startY + 4 + gentleDrift * 0.25;
    let restCp2X = startX + 38;
    let restCp2Y = startY - 34 + gentleDrift * 0.45;
    let restEndX = startX + 70 + gentleDrift * 0.35 + tailFlick * 0.4;
    let restEndY = startY - 35 + gentleDrift + tailFlick + curiousTwitch;

    // Sleepy cozy curl: tucks low and forward beside the cat's hip
    if (this.sleepAmount > 0.01) {
      const sl = this.sleepAmount;
      const slCp1X = startX + 42;
      const slCp1Y = startY + 14;
      const slCp2X = startX + 54;
      const slCp2Y = startY + 28;
      const slEndX = startX + 26;
      const slEndY = startY + 26;
      restCp1X += (slCp1X - restCp1X) * sl;
      restCp1Y += (slCp1Y - restCp1Y) * sl;
      restCp2X += (slCp2X - restCp2X) * sl;
      restCp2Y += (slCp2Y - restCp2Y) * sl;
      restEndX += (slEndX - restEndX) * sl;
      restEndY += (slEndY - restEndY) * sl;
    }

    // Happy high question-mark tail during big stretch!
    if (this.stretchAmount > 0.01) {
      const st = this.stretchAmount;
      const quiver = Math.sin(this.elapsed * 20) * 3.2 * st;
      restCp1X += (startX + 24 - restCp1X) * st;
      restCp1Y += (startY - 26 - restCp1Y) * st;
      restCp2X += (startX + 44 - restCp2X) * st;
      restCp2Y += (startY - 76 - restCp2Y) * st;
      restEndX += (startX + 26 + quiver - restEndX) * st;
      restEndY += (startY - 82 - restEndY) * st;
    }

    // Scruffed dangle: limp lower tail swaying with drag inertia!
    if (this.scruffAmount > 0.01) {
      const sc = Math.min(1, this.scruffAmount);
      const sw = this.scruffSwing * 36;
      restCp1X += (startX + 22 + sw * 0.4 - restCp1X) * sc;
      restCp1Y += (startY + 20 - restCp1Y) * sc;
      restCp2X += (startX + 28 + sw * 0.8 - restCp2X) * sc;
      restCp2Y += (startY + 42 - restCp2Y) * sc;
      restEndX += (startX + 18 + sw - restEndX) * sc;
      restEndY += (startY + 52 - restEndY) * sc;
    }

    // Tail poke recoil: snaps tightly curled inward toward the hip!
    if (this.tailRecoil > 0.01) {
      const tr = Math.min(1, this.tailRecoil);
      restCp1X += (startX + 14 - restCp1X) * tr;
      restCp1Y += (startY + 12 - restCp1Y) * tr;
      restCp2X += (startX + 18 - restCp2X) * tr;
      restCp2Y += (startY + 22 - restCp2Y) * tr;
      restEndX += (startX - 4 - restEndX) * tr;
      restEndY += (startY + 18 - restEndY) * tr;
    }

    // Grumpy 3-beat desk-thump pose when cross (lifts up smoothly, slams down onto desk!)
    const r = Math.max(0, Math.min(1, this.catTail.reach));
    const smoothR = r * r * (3 - 2 * r);
    const thumpBlend = this.crossAmount * (1 - smoothR);
    if (thumpBlend > 0.01) {
      const lift = this.thumpLift;
      const lash = this.thumpLash;
      const maxEdge = this.logicalW - 18;
      const thCp1X = Math.min(maxEdge, startX + 36);
      const thCp1Y = startY + 14 - lift * 16;
      const thCp2X = Math.min(maxEdge, startX + 64 - lift * 10);
      const thCp2Y = startY + 24 - lift * 52;
      const thEndX = Math.min(maxEdge, startX + 78 - lift * 16 + lash * 6);
      const thEndY = startY + 30 - lift * 76;
      restCp1X += (thCp1X - restCp1X) * thumpBlend;
      restCp1Y += (thCp1Y - restCp1Y) * thumpBlend;
      restCp2X += (thCp2X - restCp2X) * thumpBlend;
      restCp2Y += (thCp2Y - restCp2Y) * thumpBlend;
      restEndX += (thEndX - restEndX) * thumpBlend;
      restEndY += (thEndY - restEndY) * thumpBlend;
    }

    const patEndX = this.catTail.tipX;
    const patEndY = this.catTail.tipY - this.catTail.hover - 2;
    const maxEdgeX = this.logicalW - 14;
    // Near-right keys keep the iconic high swan-neck arch; far-left keys sweep smoothly around the
    // right hip and glide across the front keyboard deck below the cat's belly (zero body clipping!).
    const crossLeft = this.tailCrossLeft;
    const nearCp1X = Math.min(maxEdgeX, Math.max(startX + 44, patEndX + 32));
    const nearCp1Y = startY - 12 - this.catTail.hover * 0.35;
    const nearCp2X = Math.min(maxEdgeX, Math.max(startX + 54, patEndX + 40));
    const nearCp2Y = Math.min(startY + 24, (startY + patEndY) * 0.5 - 30 - this.catTail.hover * 0.55);

    const farCp1X = Math.min(maxEdgeX, startX + 56);
    const farCp1Y = startY + 36 - this.catTail.hover * 0.25;
    const farCp2X = (startX + patEndX) * 0.5 + 24;
    const farCp2Y = Math.max(this.kbCenterY - this.kbHeight * 0.34, patEndY - 22 - this.catTail.hover * 0.45);

    const patCp1X = nearCp1X + (farCp1X - nearCp1X) * crossLeft;
    const patCp1Y = nearCp1Y + (farCp1Y - nearCp1Y) * crossLeft;
    const patCp2X = nearCp2X + (farCp2X - nearCp2X) * crossLeft;
    const patCp2Y = nearCp2Y + (farCp2Y - nearCp2Y) * crossLeft;

    const cp1X = restCp1X + (patCp1X - restCp1X) * smoothR;
    const cp1Y = restCp1Y + (patCp1Y - restCp1Y) * smoothR;
    const cp2X = restCp2X + (patCp2X - restCp2X) * smoothR;
    const cp2Y = restCp2Y + (patCp2Y - restCp2Y) * smoothR;
    const endX = restEndX + (patEndX - restEndX) * smoothR;
    const endY = restEndY + (patEndY - restEndY) * smoothR;
    const tipAngle = Math.atan2(endY - cp2Y, endX - cp2X);
    const tipSquash = this.catTail.impactSquash * smoothR;

    // Cache live sampled points along the visible tail for pixel-exact tail-poke hit testing!
    this.liveTailCurvePts = [];
    for (const u of [0.22, 0.36, 0.50, 0.64, 0.78, 0.90, 1.0]) {
      const m = 1 - u;
      this.liveTailCurvePts.push({
        x: m * m * m * startX + 3 * m * m * u * cp1X + 3 * m * u * u * cp2X + u * u * u * endX,
        y: m * m * m * startY + 3 * m * m * u * cp1Y + 3 * m * u * u * cp2Y + u * u * u * endY,
      });
    }

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Subtle tactile contact shadow directly on the keycap when the tail pats down!
    if (smoothR > 0.35) {
      const prox = Math.max(0, 1 - this.catTail.hover / 28);
      const shadowA = smoothR * prox * 0.34;
      if (shadowA > 0.02) {
        ctx.fillStyle = `rgba(18, 22, 32, ${shadowA.toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(
          this.catTail.tipX,
          this.catTail.tipY + 3.5,
          12.5 + tipSquash * 3.5,
          6.2 + tipSquash * 1.4,
          0,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    }

    if (this.customSkin) {
      const s = this.customSkin;
      const tailW = s.tailFluffy ? 20.0 : 16.0;
      if (s.outlineColor) {
        if (!this.chromaKeyBg) {
          ctx.shadowColor = 'rgba(30, 32, 40, 0.22)';
          ctx.shadowBlur = 0; /* perf: no per-frame blur */
          ctx.shadowOffsetY = 1.5;
        }
        ctx.strokeStyle = s.outlineColor;
        ctx.lineWidth = tailW + 3.4;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, endX, endY);
        ctx.stroke();
        ctx.shadowBlur =0; /* perf: no per-frame blur */
        ctx.shadowOffsetY = 0;
      } else if (!this.chromaKeyBg) {
        ctx.shadowColor = 'rgba(18, 17, 18, 0.42)';
        ctx.shadowBlur = 0; /* perf: no per-frame blur */
      }

      const tailGrad = ctx.createLinearGradient(startX, startY, endX, endY);
      tailGrad.addColorStop(0.0, s.tailColor);
      tailGrad.addColorStop(1.0, s.tailTipColor);
      ctx.strokeStyle = tailGrad;
      ctx.lineWidth = tailW;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, endX, endY);
      ctx.stroke();

      if (s.tailFluffy) {
        ctx.fillStyle = s.tailTipColor;
        ctx.beginPath();
        ctx.ellipse(
          endX + Math.cos(tipAngle) * 1.2,
          endY + Math.sin(tipAngle) * 1.2,
          11.8 * (1 + tipSquash * 0.14),
          10.2 * (1 - tipSquash * 0.10),
          tipAngle,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      } else if (tipSquash > 0.05) {
        ctx.fillStyle = s.tailTipColor;
        ctx.beginPath();
        ctx.ellipse(
          endX,
          endY,
          tailW * 0.54 * (1 + tipSquash * 0.16),
          tailW * 0.50 * (1 - tipSquash * 0.12),
          tipAngle,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }

      // Cute tabby tail rings when tailStripes is enabled!
      if (s.tailStripes && (s.stripeColor || s.tailTipColor)) {
        const ringColor = s.stripeColor || s.tailTipColor;
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = 3.2;
        ctx.shadowBlur =0; /* perf: no per-frame blur */
        for (const t of [0.24, 0.44, 0.64, 0.82]) {
          const mt = 1 - t;
          const bx =
            mt * mt * mt * startX +
            3 * mt * mt * t * cp1X +
            3 * mt * t * t * cp2X +
            t * t * t * endX;
          const by =
            mt * mt * mt * startY +
            3 * mt * mt * t * cp1Y +
            3 * mt * t * t * cp2Y +
            t * t * t * endY;
          const tx =
            3 * mt * mt * (cp1X - startX) +
            6 * mt * t * (cp2X - cp1X) +
            3 * t * t * (endX - cp2X);
          const ty =
            3 * mt * mt * (cp1Y - startY) +
            6 * mt * t * (cp2Y - cp1Y) +
            3 * t * t * (endY - cp2Y);
          const tLen = Math.max(1, Math.hypot(tx, ty));
          const nx = (-ty / tLen) * (tailW * 0.42);
          const ny = (tx / tLen) * (tailW * 0.42);
          ctx.beginPath();
          ctx.moveTo(bx - nx, by - ny);
          ctx.lineTo(bx + nx, by + ny);
          ctx.stroke();
        }
      }

      ctx.restore();
      return;
    }

    if (this.catBreed === 'ragdoll') {
      // Plush bushy warm cocoa-taupe Ragdoll plume tail matching the real cat photo!
      if (!this.chromaKeyBg) {
        ctx.shadowColor = 'rgba(48, 38, 30, 0.22)';
        ctx.shadowBlur = 0; /* perf: no per-frame blur */
        ctx.shadowOffsetY = 1.5;
      }
      ctx.strokeStyle = '#4e4239';
      ctx.lineWidth = 23.5;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, endX, endY);
      ctx.stroke();

      ctx.shadowBlur =0; /* perf: no per-frame blur */
      ctx.shadowOffsetY = 0;
      const tailGrad = ctx.createLinearGradient(startX, startY, endX, endY);
      tailGrad.addColorStop(0.0, '#8d7e6f');
      tailGrad.addColorStop(0.5, '#726356');
      tailGrad.addColorStop(1.0, '#584b40');
      ctx.strokeStyle = tailGrad;
      ctx.lineWidth = 20.2;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, endX, endY);
      ctx.stroke();

      // Bushy warm cocoa-taupe plume tip puff
      ctx.fillStyle = '#584b40';
      ctx.beginPath();
      ctx.ellipse(
        endX + Math.cos(tipAngle) * 1.2,
        endY + Math.sin(tipAngle) * 1.2,
        12.2 * (1 + tipSquash * 0.14),
        10.6 * (1 - tipSquash * 0.10),
        tipAngle,
        0,
        Math.PI * 2,
      );
      ctx.fill();

      // Soft warm creamy sheen along upper fluff curve
      ctx.strokeStyle = 'rgba(246, 240, 232, 0.26)';
      ctx.lineWidth = 5.0;
      ctx.beginPath();
      ctx.moveTo(startX + 4, startY - 4);
      ctx.bezierCurveTo(cp1X - 2, cp1Y - 4, cp2X - 3, cp2Y - 4, endX - 3, endY - 4);
      ctx.stroke();
    } else {
      ctx.strokeStyle = '#141314';
      ctx.lineWidth = 16.0;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, endX, endY);
      ctx.stroke();

      if (tipSquash > 0.05) {
        ctx.fillStyle = '#141314';
        ctx.beginPath();
        ctx.ellipse(
          endX,
          endY,
          8.8 * (1 + tipSquash * 0.16),
          8.0 * (1 - tipSquash * 0.12),
          tipAngle,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    }

    ctx.restore();
  }

  private drawCatBody(ctx: CanvasRenderingContext2D, breath: number, purrShift: number): void {
    if (this.customSkin) {
      this.drawCustomCatBody(ctx, this.customSkin, breath, purrShift);
      return;
    }
    const isRagdoll = this.catBreed === 'ragdoll';
    const catBlack = '#141314';
    const inkOutline = '#5d5148';

    // Evaluate measured left & right silhouette points deformed by flexible cat spine + unified head tilt!
    const leftPts: Vec2[] = [];
    const rightPts: Vec2[] = [];
    const scruffSlim = Math.min(1, this.scruffAmount) * 0.14;
    const bellySwell = 1 + this.typingHunch * 0.04 + this.sleepAmount * 0.085 - scruffSlim;
    const headCenter = this.spinePoint(0.24, breath);
    const hcx = headCenter.x + purrShift;
    const hcy = headCenter.y;

    for (const slice of BODY_SLICES) {
      const sp = this.spinePoint(slice.t, breath);
      const widen = slice.t > 0.45 ? bellySwell : 1;
      const hw = slice.hw * widen;

      if (slice.t <= 0.38) {
        const tiltW = slice.t <= 0.30 ? 1.0 : (0.42 - slice.t) / 0.12;
        const ang = this.headTilt * tiltW;
        const cosA = Math.cos(ang);
        const sinA = Math.sin(ang);
        const relY = sp.y - hcy;
        const lx0 = sp.x + purrShift - hw - hcx;
        const rx0 = sp.x + purrShift + hw - hcx;
        leftPts.push({
          x: hcx + lx0 * cosA - relY * sinA,
          y: hcy + lx0 * sinA + relY * cosA,
        });
        rightPts.push({
          x: hcx + rx0 * cosA - relY * sinA,
          y: hcy + rx0 * sinA + relY * cosA,
        });
      } else {
        leftPts.push({ x: sp.x + purrShift - hw, y: sp.y });
        rightPts.push({ x: sp.x + purrShift + hw, y: sp.y });
      }
    }

    const crownRelY = this.spinePoint(0.11, breath).y - hcy;
    const crownPt = {
      x: hcx - crownRelY * Math.sin(this.headTilt),
      y: hcy + crownRelY * Math.cos(this.headTilt),
    };
    const basePt = this.spinePoint(1.0, breath);

    ctx.save();
    if (isRagdoll && !this.chromaKeyBg) {
      ctx.shadowColor = 'rgba(26, 30, 40, 0.24)';
      ctx.shadowBlur = 0; /* perf: no per-frame blur */
      ctx.shadowOffsetY = 2;
    }

    // 1) Cute rounded grounded hind paws always rendered in seated posture (dangle softly when scruffed!)
    ctx.fillStyle = isRagdoll ? '#f7f5f0' : catBlack;
    ctx.strokeStyle = inkOutline;
    ctx.lineWidth = 1.9;
    const scruffFootDrop = Math.min(1, this.scruffAmount) * 12.0;
    const scruffFootSway = Math.min(1, this.scruffAmount) * this.scruffSwing * 14;
    const scruffFootRot = Math.min(1, this.scruffAmount) * this.scruffSwing * 0.24;
    const scruffFootScaleX = 1 - Math.min(1, this.scruffAmount) * 0.14;
    const scruffFootScaleY = 1 + Math.min(1, this.scruffAmount) * 0.24;
    for (const [fx, fy, rx, ry] of [
      [basePt.x - 42 + scruffFootSway, basePt.y - 3 + scruffFootDrop, 14.5 * scruffFootScaleX, 11.5 * scruffFootScaleY],
      [basePt.x + 32 + scruffFootSway, basePt.y - 1 + scruffFootDrop, 15.0 * scruffFootScaleX, 11.5 * scruffFootScaleY],
    ]) {
      ctx.beginPath();
      ctx.ellipse(fx, fy, rx, ry, scruffFootRot, 0, Math.PI * 2);
      ctx.fill();
      if (isRagdoll) {
        ctx.save();
        ctx.shadowBlur =0; /* perf: no per-frame blur */
        ctx.shadowOffsetY = 0;
        ctx.stroke();
        ctx.restore();
      }
    }

    // 2) Build exact smooth spline through measured silhouette slices (left top -> right top -> right down -> bottom -> left up)!
    const traceBodyPath = () => {
      ctx.beginPath();
      const crownCos = Math.cos(this.headTilt);
      const crownSin = Math.sin(this.headTilt);
      ctx.moveTo(leftPts[0].x + 14 * crownCos + 6 * crownSin, leftPts[0].y + 14 * crownSin - 6 * crownCos);
      ctx.quadraticCurveTo(crownPt.x, crownPt.y - 2, rightPts[0].x - 14 * crownCos + 6 * crownSin, rightPts[0].y - 14 * crownSin - 6 * crownCos);

      ctx.lineTo(rightPts[0].x, rightPts[0].y);
      for (let i = 0; i < rightPts.length - 1; i++) {
        const p0 = rightPts[i];
        const p1 = rightPts[i + 1];
        const mx = (p0.x + p1.x) * 0.5;
        const my = (p0.y + p1.y) * 0.5;
        ctx.quadraticCurveTo(p0.x, p0.y, mx, my);
      }
      const lastR = rightPts[rightPts.length - 1];
      ctx.lineTo(lastR.x, lastR.y);

      const lastL = leftPts[leftPts.length - 1];
      ctx.quadraticCurveTo(basePt.x + purrShift, basePt.y + 6, lastL.x, lastL.y);

      for (let i = leftPts.length - 1; i > 0; i--) {
        const p0 = leftPts[i];
        const p1 = leftPts[i - 1];
        const mx = (p0.x + p1.x) * 0.5;
        const my = (p0.y + p1.y) * 0.5;
        ctx.quadraticCurveTo(p0.x, p0.y, mx, my);
      }
      ctx.lineTo(leftPts[0].x, leftPts[0].y);
      ctx.closePath();
    };

    traceBodyPath();
    if (isRagdoll) {
      // Warm creamy ivory base coat matching the real fluffy Ragdoll photo!
      const furGrad = ctx.createRadialGradient(hcx, hcy + 68, 18, basePt.x, basePt.y - 60, 148);
      furGrad.addColorStop(0.0, '#fbf9f3');
      furGrad.addColorStop(0.68, '#f4f0e6');
      furGrad.addColorStop(1.0, '#e8e2d6');
      ctx.fillStyle = furGrad;
      ctx.fill();

      // Paint custom warm milk-tea taupe Ragdoll markings clipped cleanly inside the body silhouette!
      ctx.save();
      ctx.shadowBlur =0; /* perf: no per-frame blur */
      ctx.shadowOffsetY = 0;
      ctx.clip();

      // 2a) Plush warm taupe-brown lower flanks / hips wrapping around both outer thighs (matches photo!)
      const midTorso = this.spinePoint(0.72, breath);
      for (const sgn of [-1, 1]) {
        const flankGrad = ctx.createRadialGradient(
          midTorso.x + purrShift + sgn * 70,
          midTorso.y + 8,
          14,
          midTorso.x + purrShift + sgn * 50,
          midTorso.y + 10,
          72,
        );
        flankGrad.addColorStop(0.0, 'rgba(130, 115, 100, 0.78)');
        flankGrad.addColorStop(0.50, 'rgba(156, 141, 126, 0.45)');
        flankGrad.addColorStop(0.82, 'rgba(178, 165, 150, 0.14)');
        flankGrad.addColorStop(1.0, 'rgba(190, 178, 164, 0.0)');
        ctx.fillStyle = flankGrad;
        ctx.beginPath();
        ctx.ellipse(midTorso.x + purrShift + sgn * 60, midTorso.y + 8, 52, 84, sgn * -0.14, 0, Math.PI * 2);
        ctx.fill();
      }

      // 2b) Subtle fluffy creamy-white chest lion-mane fur tufts under chin
      const neckSp = this.spinePoint(0.47, breath);
      ctx.strokeStyle = 'rgba(182, 170, 156, 0.36)';
      ctx.lineWidth = 1.8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(neckSp.x + purrShift, neckSp.y - 2, 34, 0.22 * Math.PI, 0.78 * Math.PI);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(neckSp.x + purrShift - 16, neckSp.y + 18, 14, 0.18 * Math.PI, 0.72 * Math.PI);
      ctx.arc(neckSp.x + purrShift + 16, neckSp.y + 18, 14, 0.28 * Math.PI, 0.82 * Math.PI);
      ctx.stroke();

      // 2c) Custom warm milk-tea taupe crown cap & wide fluffy creamy-white blaze (1:1 match to user's real Ragdoll photos!)
      ctx.save();
      ctx.translate(hcx, hcy);
      ctx.rotate(this.headTilt);

      const maskShift = this.faceTurnX * 0.72;
      // Rich warm latte-taupe head mask covering crown, ears base, temples & outer cheeks
      const capGrad = ctx.createLinearGradient(0, -40, 0, 22);
      capGrad.addColorStop(0.0, '#8d7d6e');
      capGrad.addColorStop(0.42, '#9e8e7f');
      capGrad.addColorStop(0.84, '#b3a495');
      capGrad.addColorStop(1.0, 'rgba(186, 173, 158, 0.14)');

      ctx.fillStyle = capGrad;
      ctx.shadowColor = 'rgba(138, 122, 108, 0.45)';
      ctx.shadowBlur = 0; /* perf: no per-frame blur */

      // Full warm milk-tea head mask curving around outer eyes & cheeks, opening into a wide soft fluffy white blaze!
      ctx.beginPath();
      ctx.moveTo(-74, -44);
      ctx.lineTo(74, -44);
      ctx.lineTo(70, 20);
      ctx.quadraticCurveTo(maskShift + 42, 18, maskShift + 26, 9);
      ctx.quadraticCurveTo(maskShift + 17, 0, maskShift + 13.5, -13);
      // Soft wide fluffy dome peak of the creamy-white blaze between the brows (warm latte bridge stays connected across forehead!)
      ctx.quadraticCurveTo(maskShift + 7, -21.5, maskShift, -22.5);
      ctx.quadraticCurveTo(maskShift - 7, -21.5, maskShift - 13.5, -13);
      ctx.quadraticCurveTo(maskShift - 17, 0, maskShift - 26, 9);
      ctx.quadraticCurveTo(maskShift - 42, 18, -70, 20);
      ctx.closePath();
      ctx.fill();

      // Lighter warm champagne-beige soft forehead bridge highlight right between the ears (exact match to close-up photo!)
      ctx.shadowBlur = 0; /* perf: no per-frame blur */
      ctx.fillStyle = 'rgba(208, 194, 176, 0.58)';
      ctx.beginPath();
      ctx.ellipse(maskShift, -32, 18, 9, 0, 0, Math.PI * 2);
      ctx.fill();

      // Deeper warm taupe-brown shading along outer temples below both ears
      ctx.fillStyle = 'rgba(116, 100, 86, 0.40)';
      ctx.beginPath();
      ctx.ellipse(-44 + maskShift * 0.4, -10, 21, 22, -0.18, 0, Math.PI * 2);
      ctx.ellipse(44 + maskShift * 0.4, -10, 21, 22, 0.18, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore(); // end mask head-space
      ctx.restore(); // end body clip

      // Clean refined soft warm-brown body outline so creamy fur pops crisply on BOTH light & dark wallpapers!
      ctx.save();
      ctx.shadowBlur =0; /* perf: no per-frame blur */
      ctx.shadowOffsetY = 0;
      traceBodyPath();
      ctx.strokeStyle = inkOutline;
      ctx.lineWidth = 1.8;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.fillStyle = catBlack;
      ctx.fill();
    }

    // 3) Compact plush rounded cat ears matching ORIG 0.3s exact height (shorter & cuter, no tall rabbit ears!)
    ctx.save();
    ctx.translate(hcx, hcy);
    ctx.rotate(this.headTilt);

    const nowEar = performance.now();
    const earAct = this.idleAct;
    const earActU = earAct && earAct.kind === 'ear' ? Math.max(0, Math.min(1, (nowEar - earAct.t0) / earAct.dur)) : 0;
    const lFlick = earAct && earAct.kind === 'ear' && earAct.side === -1 ? Math.sin(earActU * Math.PI * 3) * 0.24 * (1 - earActU) : 0;
    const rFlick = earAct && earAct.kind === 'ear' && earAct.side === 1 ? Math.sin(earActU * Math.PI * 3) * 0.24 * (1 - earActU) : 0;
    const lTwitch = Math.sin(this.earTwitchLeft * Math.PI) * 0.12 + lFlick + this.groomEarPressLeft * 0.44;
    const rTwitch = Math.sin(this.earTwitchRight * Math.PI) * 0.12 + rFlick + this.groomEarPressRight * 0.44;
    const earPerk = this.earPerkSpring.x; // +0.16 curious/perky, -0.58 airplane ears!
    const airplaneDrop = Math.max(0, -earPerk) * 11;
    const airplaneSpread = Math.max(0, -earPerk) * 6;

    const drawOneEar = (sideSign: -1 | 1, twitch: number) => {
      ctx.save();
      ctx.translate(sideSign * (33 + airplaneSpread) + this.faceTurnX * 0.18, -28 + airplaneDrop);
      ctx.rotate(sideSign * (0.08 - earPerk + twitch));

      const earPath = () => {
        ctx.beginPath();
        ctx.moveTo(sideSign * 19, 20);
        ctx.bezierCurveTo(sideSign * 19, -8, sideSign * 12, -23, sideSign * 3, -21);
        ctx.bezierCurveTo(sideSign * -8, -18, sideSign * -16, -6, sideSign * -21, 8);
        ctx.closePath();
      };

      if (isRagdoll) {
        // Rich dark espresso-taupe ear rims fading to soft warm latte base (1:1 match to user's real cat!)
        const earGrad = ctx.createLinearGradient(0, -23, 0, 18);
        earGrad.addColorStop(0.0, '#463b33');
        earGrad.addColorStop(0.42, '#625449');
        earGrad.addColorStop(0.82, '#8b7c6e');
        earGrad.addColorStop(1.0, '#9c8d7e');
        ctx.fillStyle = earGrad;
        earPath();
        ctx.fill();

        // Stroke outer ear rim cleanly (open at bottom skull merge so there is zero seam line!)
        ctx.save();
        ctx.shadowBlur =0; /* perf: no per-frame blur */
        ctx.shadowOffsetY = 0;
        ctx.strokeStyle = '#473c34';
        ctx.lineWidth = 1.9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(sideSign * 19, 17);
        ctx.bezierCurveTo(sideSign * 19, -8, sideSign * 12, -23, sideSign * 3, -21);
        ctx.bezierCurveTo(sideSign * -8, -18, sideSign * -16, -6, sideSign * -19, 5);
        ctx.stroke();

        // Soft warm dusty-blush cream inner ear
        ctx.fillStyle = '#dec4be';
        ctx.beginPath();
        ctx.moveTo(sideSign * 11, 10);
        ctx.bezierCurveTo(sideSign * 11, -3, sideSign * 7, -13, sideSign * 2, -11);
        ctx.bezierCurveTo(sideSign * -4, -9, sideSign * -9, -1, sideSign * -10, 8);
        ctx.closePath();
        ctx.fill();

        // Fluffy creamy-white Ragdoll ear furnishings
        ctx.strokeStyle = 'rgba(252, 249, 242, 0.90)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(sideSign * -7, 6);
        ctx.quadraticCurveTo(sideSign * -1, 3, sideSign * 5, 6);
        ctx.moveTo(sideSign * -4, 10);
        ctx.quadraticCurveTo(sideSign * 2, 7.5, sideSign * 8, 10);
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.fillStyle = catBlack;
        earPath();
        ctx.fill();
      }
      ctx.restore();
    };

    this.drawHeadphonesBack(ctx);
    drawOneEar(-1, lTwitch);
    drawOneEar(1, rTwitch);

    ctx.shadowBlur =0; /* perf: no per-frame blur */
    ctx.shadowOffsetY = 0;

    const wShift = this.faceTurnX * 0.72;

    // 4) Ragdoll rosy petting/chin blush + adorable tiny pink nose & gentle kitten smile (morphs smoothly for yawn & groom lick!)
    const blushBoost = Math.max(this.squintAmount, this.chinAmount * 1.15, this.kneadAmount * 0.85);
    if (isRagdoll) {
      if (blushBoost > 0.12) {
        ctx.fillStyle = `rgba(244, 146, 166, ${(0.44 * Math.min(1.15, blushBoost)).toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(wShift - 30, 13, 8.5, 4.6, -0.08, 0, Math.PI * 2);
        ctx.ellipse(wShift + 30, 13, 8.5, 4.6, 0.08, 0, Math.PI * 2);
        ctx.fill();
      }

      // Cute rosy-pink Ragdoll nose centered neatly inside the snow-white inverted-V blaze (scrunches up gently on Boop & Yawn!)
      const noseWiggleY = -1.4 * this.boopCrossEye - 1.3 * this.yawnAmount;
      ctx.fillStyle = '#ee8e9e';
      ctx.beginPath();
      ctx.moveTo(wShift - 4.1, 9.6 + noseWiggleY);
      ctx.quadraticCurveTo(wShift, 8.5 + noseWiggleY, wShift + 4.1, 9.6 + noseWiggleY);
      ctx.quadraticCurveTo(wShift + 3.2, 13.8 + noseWiggleY, wShift, 14.3 + noseWiggleY);
      ctx.quadraticCurveTo(wShift - 3.2, 13.8 + noseWiggleY, wShift - 4.1, 9.6 + noseWiggleY);
      ctx.closePath();
      ctx.fill();

      // Delicate cute kitten "w" mouth (hides smoothly while big yawn mouth is open)
      if (this.yawnAmount < 0.25) {
        ctx.save();
        ctx.globalAlpha = 1 - this.yawnAmount / 0.25;
        ctx.strokeStyle = 'rgba(72, 77, 92, 0.80)';
        ctx.lineWidth = 1.35;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(wShift - 5.8, 16.6);
        ctx.quadraticCurveTo(wShift - 2.9, 19.6, wShift, 16.4);
        ctx.quadraticCurveTo(wShift + 2.9, 19.6, wShift + 5.8, 16.6);
        ctx.stroke();
        ctx.restore();
      }
    } else if (this.chinAmount > 0.2) {
      // Subtle cozy warm cheek glow on Black Cat during blissful chin scratch!
      ctx.fillStyle = `rgba(255, 168, 186, ${(0.24 * this.chinAmount).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(wShift - 30, 14, 7.5, 4.0, -0.08, 0, Math.PI * 2);
      ctx.ellipse(wShift + 30, 14, 7.5, 4.0, 0.08, 0, Math.PI * 2);
      ctx.fill();
    }
    this.drawYawnOrLickMouth(ctx, wShift, isRagdoll ? '#473c34' : '#3a232b');

    // 5) Delicate wispy cheek whiskers adapting to 2.5D head turn
    ctx.strokeStyle = isRagdoll ? 'rgba(98, 86, 76, 0.52)' : 'rgba(205, 208, 214, 0.54)';
    ctx.lineWidth = isRagdoll ? 1.15 : 1.05;
    ctx.lineCap = 'round';
    const leftLen = Math.max(8, 12 - this.faceTurnX * 0.55);
    const rightLen = Math.max(8, 12 + this.faceTurnX * 0.55);
    for (let i = 0; i < 3; i++) {
      const wy = 16 + i * 5.0;
      const slant = 2.0 + i * 1.1;
      ctx.beginPath();
      ctx.moveTo(-34 + wShift, wy);
      ctx.lineTo(-34 + wShift - leftLen, wy + slant);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(34 + wShift, wy);
      ctx.lineTo(34 + wShift + rightLen, wy + slant);
      ctx.stroke();
    }

    // 6) Expressive eyes (lemon-chartreuse for Black Cat / luminous sapphire-blue for Ragdoll!)
    this.drawEyes(ctx, wShift, -1);
    this.drawHeadphonesFront(ctx);

    ctx.restore(); // end head

    ctx.restore();
  }

  private getHeadphoneLedColors(): { ring: string; glow: string; mic: string } {
    const rgbMix = 0.5 + 0.5 * Math.sin(this.elapsed * 2.3 + this.typingEnergy * 2.0);
    const pulse = 0.88 + 0.12 * Math.sin(this.elapsed * 5.2) + this.typingEnergy * 0.14;
    const t = rgbMix * 0.58;
    const r = Math.min(255, Math.round((212 * (1 - t) + 61 * t) * pulse));
    const g = Math.min(255, Math.round((245 * (1 - t) + 242 * t) * pulse));
    const b = Math.min(255, Math.round((61 * (1 - t) + 232 * t) * pulse));
    return {
      ring: `rgb(${r}, ${g}, ${b})`,
      glow: `rgba(${r}, ${g}, ${b}, 0.58)`,
      mic: `rgba(82, 247, 212, ${(0.82 + 0.18 * Math.sin(this.elapsed * 3.8)).toFixed(2)})`,
    };
  }

  /** Pass 1 (behind ears): sleek arched padded gaming headband + titanium sliders! */
  private drawHeadphonesBack(ctx: CanvasRenderingContext2D): void {
    const hs = Math.max(0, Math.min(1.18, this.headsetSpring.x));
    if (hs <= 0.015) return;

    const settled = Math.min(1, hs);
    const dropY = -(1 - settled) * 38;
    const sc = 0.86 + 0.14 * settled + Math.max(0, hs - 1) * 0.12;

    ctx.save();
    ctx.globalAlpha = Math.min(1, settled * 1.45);
    ctx.translate(0, dropY);
    ctx.scale(sc, sc);
    ctx.shadowBlur =0; /* perf: no per-frame blur */
    ctx.shadowOffsetY = 0;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const traceArch = (inset = 0) => {
      ctx.beginPath();
      ctx.moveTo(-64 + inset * 0.7, 4);
      ctx.bezierCurveTo(-66 + inset * 0.7, -34 + inset, -34, -56 + inset, 0, -56 + inset);
      ctx.bezierCurveTo(34, -56 + inset, 66 - inset * 0.7, -34 + inset, 64 - inset * 0.7, 4);
    };

    // Subtle light specular outline so headband reads crisply even on pure Black Cat!
    traceArch(0);
    ctx.strokeStyle = '#6f7e99';
    ctx.lineWidth = 12.2;
    ctx.stroke();

    // Matte-charcoal outer headband shell
    traceArch(0);
    ctx.strokeStyle = '#242a36';
    ctx.lineWidth = 10.0;
    ctx.stroke();

    // Soft top satin highlight along crown
    ctx.beginPath();
    ctx.moveTo(-26, -54.2);
    ctx.quadraticCurveTo(0, -58.5, 26, -54.2);
    ctx.strokeStyle = 'rgba(216, 228, 248, 0.36)';
    ctx.lineWidth = 2.0;
    ctx.stroke();

    // Plush under-crown inner foam pad
    ctx.beginPath();
    ctx.moveTo(-28, -48.5);
    ctx.quadraticCurveTo(0, -52.5, 28, -48.5);
    ctx.strokeStyle = '#3b4454';
    ctx.lineWidth = 5.4;
    ctx.stroke();

    // Brushed-titanium lower side slider brackets
    for (const s of [-1, 1] as const) {
      ctx.beginPath();
      ctx.moveTo(s * 62.5, -14);
      ctx.lineTo(s * 64.0, 2);
      ctx.strokeStyle = '#a2afc4';
      ctx.lineWidth = 6.2;
      ctx.stroke();
    }

    ctx.restore();
  }

  /** Pass 2 (in front of cheeks): plush over-ear cups, glowing LED rings & curved boom mic! */
  private drawHeadphonesFront(ctx: CanvasRenderingContext2D): void {
    const hs = Math.max(0, Math.min(1.18, this.headsetSpring.x));
    if (hs <= 0.015) return;

    const settled = Math.min(1, hs);
    const dropY = -(1 - settled) * 38;
    const sc = 0.86 + 0.14 * settled + Math.max(0, hs - 1) * 0.12;
    const led = this.getHeadphoneLedColors();
    const turnShift = this.faceTurnX * 0.25;

    ctx.save();
    ctx.globalAlpha = Math.min(1, settled * 1.45);
    ctx.translate(0, dropY);
    ctx.scale(sc, sc);
    ctx.shadowBlur =0; /* perf: no per-frame blur */
    ctx.shadowOffsetY = 0;

    for (const s of [-1, 1] as const) {
      ctx.save();
      ctx.translate(s * 60 + turnShift * 0.5, 5);
      ctx.rotate(s * 0.09);

      // Inner plush memory-foam cheek cushion
      ctx.fillStyle = '#384050';
      ctx.strokeStyle = '#1b1f29';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(-s * 3.5, 0, 10.5, 19.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Domed matte-charcoal outer earcup shell
      const cupGrad = ctx.createLinearGradient(-10, -18, 10, 18);
      cupGrad.addColorStop(0.0, '#363e4f');
      cupGrad.addColorStop(0.55, '#242934');
      cupGrad.addColorStop(1.0, '#191d26');
      ctx.fillStyle = cupGrad;
      ctx.strokeStyle = '#8fa0bd';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.ellipse(s * 4.2, 0, 10.2, 18.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Reactive KuroCat-lime / electric-cyan gaming LED ring!
      ctx.save();
      ctx.shadowColor = led.glow;
      ctx.shadowBlur = 0; /* perf: no per-frame blur */
      ctx.strokeStyle = led.ring;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.ellipse(s * 6.0, 0, 5.4, 11.4, 0, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = led.ring;
      ctx.beginPath();
      ctx.ellipse(s * 6.4, 0, 1.9, 2.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.restore();
    }

    // Sleek curved flexible boom microphone from left earcup (-X) curving beside lower cheek
    const mx0 = -60 + turnShift * 0.5;
    const mxTip = -22 + this.faceTurnX * 0.55;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#5c6980';
    ctx.lineWidth = 4.6;
    ctx.beginPath();
    ctx.moveTo(mx0, 14);
    ctx.quadraticCurveTo(mx0 + 6, 29, mxTip, 23);
    ctx.stroke();

    ctx.strokeStyle = '#1f242f';
    ctx.lineWidth = 2.8;
    ctx.beginPath();
    ctx.moveTo(mx0, 14);
    ctx.quadraticCurveTo(mx0 + 6, 29, mxTip, 23);
    ctx.stroke();

    // Metallic swivel joint on earcup
    ctx.fillStyle = '#a2afc4';
    ctx.beginPath();
    ctx.arc(mx0, 14, 3.0, 0, Math.PI * 2);
    ctx.fill();

    // Plush charcoal foam windscreen capsule + glowing mic-live indicator dot
    ctx.fillStyle = '#333b4a';
    ctx.strokeStyle = '#73829c';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(mxTip + 2.5, 22.4, 5.6, 3.8, -0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = led.mic;
    ctx.shadowColor = led.mic;
    ctx.shadowBlur = 0; /* perf: no per-frame blur */
    ctx.beginPath();
    ctx.arc(mxTip + 6.2, 21.5, 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.restore();
  }

  /** Expressive kitten "ω"-lipped yawn anchored strictly BELOW the nose with nestled pink tongue, or tiny groom lick tongue! */
  private drawYawnOrLickMouth(ctx: CanvasRenderingContext2D, cx: number, rimColor: string): void {
    if (this.yawnAmount > 0.04) {
      const y = Math.min(1, this.yawnAmount);
      const topY = 17.2; // Strictly below nose bottom (y <= 14.3), drops downward as jaw opens!
      const w = 4.2 + y * 5.2;
      const h = 2.0 + y * 11.4;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx, topY + 1.4);
      ctx.quadraticCurveTo(cx + w * 0.52, topY - 1.1, cx + w, topY + 2.0);
      ctx.bezierCurveTo(cx + w * 1.12, topY + h * 0.58, cx + w * 0.72, topY + h, cx, topY + h);
      ctx.bezierCurveTo(cx - w * 0.72, topY + h, cx - w * 1.12, topY + h * 0.58, cx - w, topY + 2.0);
      ctx.quadraticCurveTo(cx - w * 0.52, topY - 1.1, cx, topY + 1.4);
      ctx.closePath();
      ctx.fillStyle = '#6d2c3e';
      ctx.fill();

      // Cute curved pastel-pink tongue nestled snugly inside lower jaw
      ctx.save();
      ctx.clip();
      ctx.fillStyle = '#ff9bb3';
      ctx.beginPath();
      ctx.ellipse(cx, topY + h * 0.88, w * 0.78, h * 0.44, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(180, 62, 92, 0.35)';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(cx, topY + h * 0.58);
      ctx.lineTo(cx, topY + h * 0.96);
      ctx.stroke();
      ctx.restore();

      ctx.strokeStyle = rimColor;
      ctx.lineWidth = 1.3;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (this.groomLickAmount > 0.08) {
      const l = Math.min(1, this.groomLickAmount);
      ctx.save();
      ctx.fillStyle = '#ff9bb3';
      ctx.strokeStyle = '#6c2a3a';
      ctx.lineWidth = 1.05;
      ctx.beginPath();
      ctx.ellipse(cx, 19.4 + l * 2.6, 3.6 * l + 1.1, 4.2 * l + 1.0, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawEyes(ctx: CanvasRenderingContext2D, cx: number, eyeY: number): void {
    const isRagdoll = this.catBreed === 'ragdoll';
    const nowEye = performance.now();
    const slowBlinkVal =
      this.idleAct && this.idleAct.kind === 'slowBlink'
        ? 0.92 * Math.sin(Math.max(0, Math.min(1, (nowEye - this.idleAct.t0) / this.idleAct.dur)) * Math.PI)
        : 0;
    const blinkVal = Math.max(this.isBlinking ? 1 - Math.abs(this.blinkProgress - 1) : 0, slowBlinkVal);
    const yawnClose = Math.min(1, this.yawnAmount * 1.45);
    const stretchClose = Math.min(1, this.stretchAmount * 1.25);
    const groomClose = Math.min(0.85, this.groomAmount * 0.95);
    const closedness = Math.max(
      blinkVal,
      this.squintAmount * 0.85,
      this.privacyClose,
      this.sleepAmount,
      this.dozeLidClose,
      yawnClose,
      stretchClose,
      groomClose,
    );
    const curious = Math.min(1, this.curiousAmount);
    const scruff = Math.min(1, this.scruffAmount);
    const cross = this.crossAmount;

    // Exact measured eye spacing & size from original 0.3s & 10.6s!
    const eyeXs = [cx - 23.0, cx + 23.0];
    const rx = (14.8 + this.typingHunch * 1.0) * (1 + curious * 0.06 + scruff * 0.09);
    const ry = (13.4 - this.typingHunch * 0.5) * (1 + curious * 0.09 + scruff * 0.13);

    for (let idx = 0; idx < 2; idx++) {
      const ex = eyeXs[idx];
      ctx.save();
      ctx.translate(ex, eyeY);

      if (this.privacyClose > 0.45 || this.sleepAmount > 0.52) {
        ctx.strokeStyle = isRagdoll ? '#212533' : '#d4f044';
        ctx.lineWidth = 2.9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-13.5, -0.5);
        ctx.quadraticCurveTo(0, 5.2, 13.5, -0.5);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      // Cozy squeezed-shut happy arcs during big yawn or satisfying stretch!
      if (yawnClose > 0.48 || stretchClose > 0.52) {
        ctx.strokeStyle = isRagdoll ? '#212533' : '#d4f044';
        ctx.lineWidth = 3.0;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-12.5, 2.0);
        ctx.quadraticCurveTo(0, -5.2, 12.5, 2.0);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      // Extra blissful upturned happy smile arcs when getting chin scratches!
      if (this.chinAmount > 0.36 && blinkVal < 0.3) {
        ctx.strokeStyle = isRagdoll ? '#212533' : '#d4f044';
        ctx.lineWidth = 2.9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-13.0, 2.6);
        ctx.quadraticCurveTo(0, -4.4, 13.0, 2.6);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      if ((this.squintAmount > 0.38 || groomClose > 0.48) && blinkVal < 0.3) {
        if (isRagdoll) {
          // Sleek lazy drooping slits with a subtle crystal-blue underside shimmer!
          ctx.strokeStyle = 'rgba(174, 224, 255, 0.72)';
          ctx.lineWidth = 4.4;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(-12.5, 0.2);
          ctx.quadraticCurveTo(0, 2.2, 12.5, 1.8);
          ctx.stroke();

          ctx.strokeStyle = '#212533';
          ctx.lineWidth = 2.7;
          ctx.beginPath();
          ctx.moveTo(-13.5, -0.5);
          ctx.quadraticCurveTo(0, 1.4, 13.5, 1.2);
          ctx.stroke();
        } else {
          // Exact sleek thin horizontal lazy-slanted lemon-chartreuse slits from user's reference photo (NO grey lid blob!)
          ctx.strokeStyle = '#d4f044';
          ctx.lineWidth = 2.9;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(-13.5, -0.5);
          ctx.quadraticCurveTo(0, 1.4, 13.5, 1.2);
          ctx.stroke();
        }
        ctx.restore();
        continue;
      }

      const openRy = Math.max(1.2, ry * (1 - closedness));
      const curiousTilt = (idx === 0 ? -0.1 : 0.1) * (0.25 + this.typingHunch * 0.75) * (1 - scruff * 0.8);
      ctx.rotate(curiousTilt);

      const suspLid = this.tailGlanceAmount * 0.45;
      const hasGrumpyLid = cross > 0.04 || suspLid > 0.04;
      const lidEff = Math.max(cross, suspLid);
      const innerDrop = -openRy + openRy * 0.90 * lidEff;
      const outerDrop = -openRy + openRy * 0.56 * lidEff;
      const leftDrop = idx === 0 ? outerDrop : innerDrop;
      const rightDrop = idx === 0 ? innerDrop : outerDrop;

      // Clip the eye cleanly below the slanted grumpy eyelid so underlying fur / bicolor masks show through seamlessly!
      ctx.save();
      if (hasGrumpyLid) {
        ctx.beginPath();
        ctx.moveTo(-rx - 4, leftDrop);
        ctx.lineTo(rx + 4, rightDrop);
        ctx.lineTo(rx + 4, openRy + 4);
        ctx.lineTo(-rx - 4, openRy + 4);
        ctx.closePath();
        ctx.clip();
      }

      if (isRagdoll) {
        // Gentle soulful sky-cerulean Ragdoll eyes (warm & lifelike, matching user's Ragdoll!)
        const irisGrad = ctx.createLinearGradient(0, -openRy, 0, openRy);
        irisGrad.addColorStop(0.0, '#2c5594');
        irisGrad.addColorStop(0.50, '#5a94d6');
        irisGrad.addColorStop(1.0, '#a3d2f2');
        ctx.fillStyle = irisGrad;
      } else {
        ctx.fillStyle = '#d4f044';
      }

      ctx.beginPath();
      ctx.ellipse(0, 0, rx, openRy, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.clip();

      if (openRy > 3.2) {
        // Dilated huge round pupils when Curious/Scruffed, slightly tightened on Boop surprise, narrow slits when Cross!
        const boopShrink = 1 - this.boopCrossEye * 0.22;
        const pupilRx = Math.min(
          rx - 2.4,
          (6.2 + curious * 4.2 + scruff * 3.4 + this.typingEnergy * 0.8) * (1 - cross * 0.34) * boopShrink,
        );
        const pupilRy = Math.min(
          openRy - 1.4,
          (8.8 + curious * 1.9 + scruff * 2.2) * (1 - cross * 0.08) * boopShrink,
        );
        // Scale normalized gaze (-1..+1) smoothly into available travel room (never sticks on a clamp wall!)
        const maxTravelX = Math.max(2.6, rx - pupilRx - 1.0);
        const maxTravelY = Math.max(2.2, openRy - pupilRy - 0.6);
        const crossEyeDir = idx === 0 ? 1 : -1;
        const gazeXEff =
          this.eyeLookX * (1 - this.boopCrossEye) + crossEyeDir * 0.94 * this.boopCrossEye;
        const gazeYEff =
          this.eyeLookY * (1 - this.boopCrossEye) + 0.42 * this.boopCrossEye;
        const px = Math.max(-maxTravelX, Math.min(maxTravelX, gazeXEff * maxTravelX));
        const py = Math.max(-maxTravelY, Math.min(maxTravelY, gazeYEff * maxTravelY));

        ctx.fillStyle = isRagdoll ? '#101624' : '#0e0e10';
        ctx.beginPath();
        ctx.ellipse(px, py, pupilRx, pupilRy, 0, 0, Math.PI * 2);
        ctx.fill();

        const sparkleBoost = Math.max(curious, scruff * 0.75, this.boopCrossEye * 0.65);
        if (isRagdoll || sparkleBoost > 0.25) {
          // Crisp glossy starlight catchlights (always on Ragdoll, plus sparkles on Black Cat when curious/scruffed/booped!)
          const ca = isRagdoll ? 0.94 : Math.min(0.92, sparkleBoost * 0.95);
          ctx.fillStyle = `rgba(255, 255, 255, ${ca.toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(px - 3.6 - sparkleBoost * 0.8, py - 4.0 - sparkleBoost * 0.5, 2.5 + sparkleBoost * 0.7, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = `rgba(255, 255, 255, ${(ca * 0.76).toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(px + 3.2, py + 3.2, 1.2 + sparkleBoost * 0.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.restore();

      if (isRagdoll && openRy > 2.2) {
        // Delicate velvety eye rim so sapphire iris frames cleanly inside the blue-grey mask
        ctx.strokeStyle = 'rgba(34, 39, 54, 0.85)';
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, openRy, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore(); // end grumpy eyelid clip

      if (hasGrumpyLid && isRagdoll && openRy > 2.2) {
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(0, 0, rx + 0.9, openRy + 0.9, 0, 0, Math.PI * 2);
        ctx.clip();
        ctx.strokeStyle = 'rgba(34, 39, 54, 0.88)';
        ctx.lineWidth = 1.9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-rx - 2, leftDrop);
        ctx.lineTo(rx + 2, rightDrop);
        ctx.stroke();
        ctx.restore();
      }

      ctx.restore();
    }
  }

  private drawMiniMouse(ctx: CanvasRenderingContext2D): void {
    const mx = this.mouseBaseX + this.mouseOffsetX;
    const my = this.mouseBaseY + this.mouseOffsetY + this.deskHopY * 1.35;
    const rx = 18.5;
    const ry = 23.0;
    const lPress = this.mouseLeftPress;
    const rPress = this.mouseRightPress;
    const mPress = Math.max(this.mouseMiddlePress, this.mouseScrollFlash);
    const colors = this.getMouseButtonColors();

    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(-0.06);

    // Soft 3D base rim / drop shadow
    ctx.save();
    if (!this.chromaKeyBg) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
      ctx.shadowBlur = 0; /* perf: no per-frame blur */
      ctx.shadowOffsetY = 3.5;
    }
    ctx.fillStyle = '#c8cac4';
    ctx.beginPath();
    ctx.ellipse(0, 1.8, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Main mouse palm shell (rear/palm at TOP closest to cat; split L/R buttons at BOTTOM pointing away from cat)
    const palmGrad = ctx.createLinearGradient(0, -ry, 0, 2);
    palmGrad.addColorStop(0.0, '#ecece7');
    palmGrad.addColorStop(1.0, '#f4f4f0');
    ctx.fillStyle = palmGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();

    // Clip inside mouse silhouette to render strictly separated Left / Right front button plates!
    // Mouse always stays cat-facing (#92): palm at TOP, buttons at BOTTOM, L = +X (inner), R = -X (outer)
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 0, rx - 0.5, ry - 0.5, 0, 0, Math.PI * 2);
    ctx.clip();

    const traceSeam = () => {
      ctx.moveTo(-rx - 2, -0.8);
      ctx.quadraticCurveTo(0, 1.8, rx + 2, -0.8);
    };

    // 1) Left Mouse Button plate (+X half -> inner-bottom in cat-facing orientation)
    ctx.beginPath();
    ctx.moveTo(0, 0.5);
    ctx.quadraticCurveTo(rx * 0.52, 0.4, rx + 2, -0.8);
    ctx.lineTo(rx + 2, ry + 2);
    ctx.lineTo(0, ry + 2);
    ctx.closePath();
    ctx.fillStyle = lPress > 0.08 ? colors.left : '#fafaf7';
    ctx.fill();
    if (lPress > 0.08) {
      ctx.fillStyle = `rgba(18, 22, 28, ${(0.18 * lPress).toFixed(3)})`;
      ctx.fillRect(0, -1, rx + 2, 3.8);
      ctx.fillRect(0, -1, 2.2, ry + 2);
    }

    // 2) Right Mouse Button plate (-X half -> outer-bottom in cat-facing orientation)
    ctx.beginPath();
    ctx.moveTo(-rx - 2, -0.8);
    ctx.quadraticCurveTo(-rx * 0.52, 0.4, 0, 0.5);
    ctx.lineTo(0, ry + 2);
    ctx.lineTo(-rx - 2, ry + 2);
    ctx.closePath();
    ctx.fillStyle = rPress > 0.08 ? colors.right : '#fafaf7';
    ctx.fill();
    if (rPress > 0.08) {
      ctx.fillStyle = `rgba(18, 22, 28, ${(0.18 * rPress).toFixed(3)})`;
      ctx.fillRect(-rx - 2, -1, rx + 2, 3.8);
      ctx.fillRect(-2.2, -1, 2.2, ry + 2);
    }

    // Crisp horizontal palm-to-button seam & vertical center L/R split line
    ctx.strokeStyle = 'rgba(42, 45, 52, 0.56)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    traceSeam();
    ctx.stroke();

    ctx.strokeStyle = 'rgba(42, 45, 52, 0.66)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(0, 0.6);
    ctx.lineTo(0, ry + 1);
    ctx.stroke();

    // Recessed scroll wheel housing + interactive wheel (middle click & scroll glow)
    ctx.fillStyle = '#2d2f36';
    this.roundRect(ctx, -2.5, 4.2, 5.0, 9.4, 2.5);
    ctx.fill();

    ctx.fillStyle = mPress > 0.12 ? colors.middle : '#6b6f78';
    this.roundRect(ctx, -1.7, 5.0 + this.mouseMiddlePress * 0.8, 3.4, 7.6, 1.7);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(-1.0, 8.8 + this.mouseMiddlePress * 0.8);
    ctx.lineTo(1.0, 8.8 + this.mouseMiddlePress * 0.8);
    ctx.stroke();

    // Always draw upright crisp L / R button legends in unobstructed front tips!
    ctx.font = '800 7.6px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = lPress > 0.12 ? '#14161a' : 'rgba(72, 76, 86, 0.56)';
    ctx.fillText('L', 7.4, 14.0 + lPress * 0.9);
    ctx.fillStyle = rPress > 0.12 ? '#ffffff' : 'rgba(72, 76, 86, 0.56)';
    ctx.fillText('R', -7.4, 14.0 + rPress * 0.9);

    ctx.restore(); // end mouse clip

    // Crisp outer silhouette stroke
    ctx.strokeStyle = '#2b2d34';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  private drawKeyboard(ctx: CanvasRenderingContext2D): void {
    const layout = getKeyboardLayout(this.keyboardLayout);
    const isCatFacing = this.keyboardOrientation === 'cat';
    const is108 = this.keyboardLayout === '108';
    const padX = 7;
    const padY = 6;
    const innerW = this.kbWidth - padX * 2;
    const innerH = this.kbHeight - padY * 2;

    ctx.save();
    ctx.translate(this.kbCenterX, this.kbCenterY + this.kbBounce * 1.1 + this.deskHopY);
    ctx.rotate(this.kbTiltRad);

    // True 3D desk trapezoid perspective: far edge (top) is narrower, near edge (bottom) is wider,
    // cleanly re-projected for BOTH cat-facing (Spacebar at narrow top) and viewer-facing (Esc/F-row at narrow top)!
    const topHalfW = (this.kbWidth * 0.955) / 2;
    const botHalfW = (this.kbWidth * 1.035) / 2;
    const halfH = this.kbHeight / 2;
    const rowH = innerH / layout.totalRows;
    const unitW = innerW / layout.totalUnits;
    const gap = is108 ? 0.85 : 0.9;

    const drawSingleKey = (
      targetCtx: CanvasRenderingContext2D,
      key: KeySpec,
      press: number,
      isTailSelected: boolean,
      isTailHovered: boolean,
      pickerAccentTop: string,
      pickerAccentSide: string,
    ) => {
      const rY = key.rowY ?? key.row;
      const rSpan = key.rowSpan ?? 1;
      const screenRowTop = isCatFacing ? layout.totalRows - (rY + rSpan) : rY;
      const screenUStart = isCatFacing
        ? layout.totalUnits - (key.uStart + key.uWidth)
        : key.uStart;

      const rowCenterFrac = (screenRowTop + rSpan * 0.5) / layout.totalRows;
      const depthScale = 0.94 + rowCenterFrac * 0.09;

      const rawX = -innerW / 2 + screenUStart * unitW + gap * 0.5;
      const rawW = key.uWidth * unitW - gap;
      const x = rawX * depthScale;
      const w = rawW * depthScale;
      const y = -innerH / 2 + screenRowTop * rowH + gap * 0.5 + press * 2.0;
      const h = rSpan * rowH - gap - 0.8;

      let topColor = '#f8f8f5';
      let sideColor = '#d0d2cc';
      if (press > 0.14) {
        topColor = this.customSkin
          ? this.customSkin.accentColor
          : this.catBreed === 'dafeiyu'
            ? '#5cc8ff'
            : this.catBreed === 'ragdoll'
              ? '#7ac7ff'
              : '#d2f244';
        sideColor = this.customSkin
          ? this.customSkin.accentSideColor
          : this.catBreed === 'dafeiyu'
            ? '#2563eb'
            : this.catBreed === 'ragdoll'
              ? '#4690d8'
              : '#8cb014';
      } else if (isTailSelected) {
        topColor = pickerAccentTop;
        sideColor = pickerAccentSide;
      } else if (key.accent === 'orange') {
        topColor = '#f4a524';
        sideColor = '#c27a10';
      } else if (key.accent === 'mod') {
        topColor = '#efefeb';
        sideColor = '#c7c9c3';
      }

      // When overdrawing an animated key onto the cached base, paint the inner keybed strip behind it
      if (press > 0.01) {
        targetCtx.fillStyle = '#d4d6d1';
        targetCtx.fillRect(x - 0.4, -innerH / 2 + screenRowTop * rowH + gap * 0.5 - 0.4, w + 0.8, h + 3.8);
      }

      targetCtx.fillStyle = sideColor;
      this.roundRect(targetCtx, x, y + 1.4, w, h, 1.8);
      targetCtx.fill();

      targetCtx.fillStyle = topColor;
      this.roundRect(targetCtx, x, y, w, h - 0.9, 1.8);
      targetCtx.fill();

      if (isTailHovered) {
        targetCtx.save();
        targetCtx.strokeStyle = isTailSelected ? '#111214' : pickerAccentTop;
        targetCtx.lineWidth = 1.65;
        this.roundRect(targetCtx, x - 0.3, y - 0.3, w + 0.6, h - 0.3, 2.0);
        targetCtx.stroke();
        targetCtx.restore();
      } else if (isTailSelected) {
        targetCtx.save();
        targetCtx.strokeStyle = 'rgba(17, 18, 20, 0.55)';
        targetCtx.lineWidth = 0.85;
        this.roundRect(targetCtx, x + 0.25, y + 0.25, w - 0.5, h - 1.4, 1.6);
        targetCtx.stroke();
        targetCtx.restore();
      }

      const legend = key.id === 'space' ? (isTailSelected ? '␣' : '') : key.id === 'esc' ? 'Esc' : key.label;
      if (legend) {
        const isWideWord = legend.length >= 3;
        const fontSize = is108
          ? isWideWord
            ? 5.0
            : legend.length === 2
              ? 5.8
              : 7.2
          : isWideWord
            ? 5.6
            : legend.length === 2
              ? 6.4
              : 7.8;
        targetCtx.save();
        targetCtx.translate(x + w * 0.5, y + (h - 0.9) * 0.50);
        if (isCatFacing) {
          targetCtx.rotate(Math.PI);
        }
        targetCtx.font = `700 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
        targetCtx.fillStyle = press > 0.14 || isTailSelected
          ? '#111214'
          : key.accent === 'orange'
            ? '#ffffff'
            : '#2c2f36';
        targetCtx.textAlign = 'center';
        targetCtx.textBaseline = 'middle';
        targetCtx.fillText(legend, 0, 0);
        targetCtx.restore();
      }
    };

    const pickerAccentTop =
      this.catBreed === 'dafeiyu' ? '#5cc8ff' : this.catBreed === 'ragdoll' ? '#7ac7ff' : '#c8f538';
    const pickerAccentSide =
      this.catBreed === 'dafeiyu' ? '#2563eb' : this.catBreed === 'ragdoll' ? '#4690d8' : '#8cb014';

    if (!this.tailPickerActive) {
      // Cache the entire static keyboard (chassis + Gaussian shadowBlur + all 65/108 unpressed keycaps & legends)
      // on an offscreen canvas so each active frame is just 1 drawImage() + 0-3 pressed keys!
      const { uniformScale } = this.getViewportTransform();
      const cacheScale = Math.min(2.5, Math.max(1.5, Math.ceil(uniformScale * 2) / 2));
      const padMargin = 20;
      const cacheLogW = Math.ceil(botHalfW * 2 + padMargin * 2);
      const cacheLogH = Math.ceil(this.kbHeight + padMargin * 2);
      const nextKey = `${this.keyboardLayout}|${this.keyboardOrientation}|${this.kbWidth}|${this.kbHeight}|${cacheScale}|${this.chromaKeyBg ? 1 : 0}`;

      if (!this.kbCacheCanvas || this.kbCacheKey !== nextKey) {
        if (!this.kbCacheCanvas) this.kbCacheCanvas = document.createElement('canvas');
        this.kbCacheCanvas.width = Math.round(cacheLogW * cacheScale);
        this.kbCacheCanvas.height = Math.round(cacheLogH * cacheScale);
        const cg = this.kbCacheCanvas.getContext('2d');
        if (cg) {
          cg.clearRect(0, 0, this.kbCacheCanvas.width, this.kbCacheCanvas.height);
          cg.save();
          cg.scale(cacheScale, cacheScale);
          cg.translate(cacheLogW * 0.5, cacheLogH * 0.5);

          cg.save();
          if (!this.chromaKeyBg) {
            cg.shadowColor = 'rgba(0, 0, 0, 0.34)';
            cg.shadowBlur = 11;
            cg.shadowOffsetY = 5;
          }
          cg.fillStyle = '#191a1e';
          this.trapezoidPath(cg, topHalfW, botHalfW, -halfH + 3.5, halfH + 5.5, 6.5);
          cg.fill();
          cg.restore();

          cg.fillStyle = '#24262c';
          cg.strokeStyle = '#363840';
          cg.lineWidth = 1.1;
          this.trapezoidPath(cg, topHalfW, botHalfW, -halfH, halfH, 6.5);
          cg.fill();
          cg.stroke();

          cg.fillStyle = '#d4d6d1';
          this.trapezoidPath(cg, topHalfW - 5, botHalfW - 5, -halfH + 4, halfH - 4, 3.5);
          cg.fill();

          for (const key of layout.keys) {
            drawSingleKey(cg, key, 0, false, false, pickerAccentTop, pickerAccentSide);
          }
          cg.restore();
          this.kbCacheKey = nextKey;
        }
      }

      if (this.kbCacheCanvas) {
        ctx.drawImage(this.kbCacheCanvas, -cacheLogW * 0.5, -cacheLogH * 0.5, cacheLogW, cacheLogH);
        for (const key of layout.keys) {
          const anim = this.keyAnims.get(key.id);
          const press = anim ? anim.pressAmount : 0;
          if (press > 0.01) {
            drawSingleKey(ctx, key, press, false, false, pickerAccentTop, pickerAccentSide);
          }
        }
      }
    } else {
      // Interactive tail-picker mode: draw live highlights & hover outlines
      ctx.save();
      if (!this.chromaKeyBg) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.34)';
        ctx.shadowBlur = 0; /* perf: no per-frame blur */
        ctx.shadowOffsetY = 5;
      }
      ctx.fillStyle = '#191a1e';
      this.trapezoidPath(ctx, topHalfW, botHalfW, -halfH + 3.5, halfH + 5.5, 6.5);
      ctx.fill();
      ctx.restore();

      ctx.fillStyle = '#24262c';
      ctx.strokeStyle = pickerAccentTop;
      ctx.lineWidth = 2.0;
      this.trapezoidPath(ctx, topHalfW, botHalfW, -halfH, halfH, 6.5);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#d4d6d1';
      this.trapezoidPath(ctx, topHalfW - 5, botHalfW - 5, -halfH + 4, halfH - 4, 3.5);
      ctx.fill();

      const selectedTailKeys = this.tailPickerSelection ?? this.tailKeyIdSet;
      for (const key of layout.keys) {
        const anim = this.keyAnims.get(key.id);
        const press = anim ? anim.pressAmount : 0;
        const isTailSelected = selectedTailKeys.has(key.id);
        const isTailHovered = this.tailPickerHoverId === key.id;
        drawSingleKey(ctx, key, press, isTailSelected, isTailHovered, pickerAccentTop, pickerAccentSide);
      }
    }

    if (this.privacyClose > 0.08) {
      ctx.save();
      ctx.globalAlpha = this.privacyClose;
      ctx.fillStyle = 'rgba(15, 20, 32, 0.74)';
      this.trapezoidPath(ctx, topHalfW - 2, botHalfW - 2, -halfH + 1.5, halfH - 1.5, 5.5);
      ctx.fill();
      ctx.strokeStyle = 'rgba(244, 114, 182, 0.45)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.font = '700 11.5px "Segoe UI", "PingFang SC", sans-serif';
      ctx.fillStyle = '#fbcfe8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const dots = performance.now() - this.privacyTypingAt < 350 ? ' • • •' : '';
      const label = this.catBreed === 'dafeiyu' ? '🔒 非礼勿视 · 已隐藏按键' : '🔒 密码输入中 · 已隐藏按键';
      ctx.fillText(label + dots, 0, 0);
      ctx.restore();
    }

    ctx.restore();
  }

  /**
   * True-scale plush velvety cat arm & chubby rounded paw ball (1:1 match to reference photo & 8.3s / 13.2s / 31.0s!)
   */
  private drawPlumpCatArm(
    ctx: CanvasRenderingContext2D,
    side: 'left' | 'right',
    sx: number,
    sy: number,
    px: number,
    py: number,
    squash: number,
    withCrease: boolean,
    isSmear = false,
  ): void {
    const dx = px - sx;
    const dy = py - sy;
    const len = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;

    const wristDist = Math.max(6, len - 8);
    const wx = sx + ux * wristDist;
    const wy = sy + uy * wristDist;

    // Cute chubby plush proportions!
    const rShoulder = 15.0;
    const rWrist = 10.6;
    const pawRx = 14.8 * (1 + squash * 0.14);
    const pawRy = 12.0 * (1 - squash * 0.12);

    if (this.customSkin) {
      this.drawCustomPlumpArm(ctx, this.customSkin, side, sx, sy, px, py, squash, withCrease, isSmear);
      return;
    }

    const isRagdoll = this.catBreed === 'ragdoll';
    ctx.save();

    // Subtle organic plush kitten-arm bow (avoids stiff straight broomstick look!)
    const bowSide = side === 'left' ? -1 : 1;
    const bowAmp = Math.min(7.5, len * 0.052);
    const midX = (sx + wx) * 0.5 + bowSide * bowAmp * Math.abs(uy);
    const midY = (sy + wy) * 0.5 + bowAmp * 0.45 * Math.abs(ux);

    if (isRagdoll) {
      // Seamless pure creamy snow-white Ragdoll mitten arm melting smoothly out of the white chest!
      const armGrad = ctx.createLinearGradient(sx, sy, px, py);
      if (isSmear) {
        armGrad.addColorStop(0.0, 'rgba(249, 246, 239, 0.0)');
        armGrad.addColorStop(0.45, 'rgba(249, 246, 239, 0.0)');
        armGrad.addColorStop(0.75, 'rgba(249, 246, 239, 0.58)');
        armGrad.addColorStop(1.0, 'rgba(252, 250, 244, 0.85)');
      } else {
        armGrad.addColorStop(0.0, 'rgba(226, 219, 208, 0.0)');
        armGrad.addColorStop(0.11, 'rgba(232, 226, 216, 1.0)');
        armGrad.addColorStop(0.32, '#f5f1e8');
        armGrad.addColorStop(0.62, '#f9f6ef');
        armGrad.addColorStop(1.0, '#fcfaf4');
      }

      ctx.fillStyle = armGrad;

      // Tapered snow-white arm silhouette (NO dark shadow smudge over the white chest!)
      const traceArmPath = () => {
        ctx.beginPath();
        ctx.moveTo(sx + nx * rShoulder, sy + ny * rShoulder);
        ctx.quadraticCurveTo(
          midX + nx * (rShoulder * 0.86),
          midY + ny * (rShoulder * 0.86),
          wx + nx * rWrist,
          wy + ny * rWrist,
        );
        ctx.lineTo(wx - nx * rWrist, wy - ny * rWrist);
        ctx.quadraticCurveTo(
          midX - nx * (rShoulder * 0.86),
          midY - ny * (rShoulder * 0.86),
          sx - nx * rShoulder,
          sy - ny * rShoulder,
        );
        ctx.closePath();
      };
      traceArmPath();
      ctx.fill();

      // Signature unique marking from user's real Ragdoll photo: adorable warm taupe-brown oval patch on viewer's RIGHT front forearm!
      if (!isSmear && side === 'right' && len > 26) {
        ctx.save();
        traceArmPath();
        ctx.clip();
        const spotX = sx + ux * (len * 0.64) + nx * 2.0;
        const spotY = sy + uy * (len * 0.64) + ny * 2.0;
        const armAngle = Math.atan2(dy, dx);
        ctx.fillStyle = 'rgba(134, 118, 102, 0.84)';
        ctx.shadowColor = 'rgba(134, 118, 102, 0.45)';
        ctx.shadowBlur = 0; /* perf: no per-frame blur */
        ctx.beginPath();
        ctx.ellipse(spotX, spotY, Math.min(13.5, len * 0.16), 8.2, armAngle, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Soft subtle contact shadow ONLY under the plump round white mitten paw ball
      ctx.save();
      if (!isSmear && !this.chromaKeyBg) {
        ctx.shadowColor = 'rgba(46, 38, 30, 0.22)';
        ctx.shadowBlur = 0; /* perf: no per-frame blur */
        ctx.shadowOffsetY = 1.5;
      }
      ctx.fillStyle = '#fcfaf4';
      ctx.beginPath();
      ctx.ellipse(px, py, pawRx, pawRy, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      if (!isSmear) {
        // Refined warm-taupe arm side strokes that fade gently in ONLY near lower torso/forearm (exact de Casteljau curve!)
        ctx.lineWidth = 1.65;
        ctx.lineCap = 'round';
        const startFrac = withCrease ? 0.22 : 0.18;
        for (const sgn of [-1, 1]) {
          const p0x = sx + nx * sgn * rShoulder;
          const p0y = sy + ny * sgn * rShoulder;
          const p1x = midX + nx * sgn * (rShoulder * 0.86);
          const p1y = midY + ny * sgn * (rShoulder * 0.86);
          const p2x = wx + nx * sgn * rWrist;
          const p2y = wy + ny * sgn * rWrist;

          const q0x = p0x + (p1x - p0x) * startFrac;
          const q0y = p0y + (p1y - p0y) * startFrac;
          const q1x = p1x + (p2x - p1x) * startFrac;
          const q1y = p1y + (p2y - p1y) * startFrac;
          const esx = q0x + (q1x - q0x) * startFrac;
          const esy = q0y + (q1y - q0y) * startFrac;

          const edgeGrad = ctx.createLinearGradient(esx, esy, p2x, p2y);
          edgeGrad.addColorStop(0.0, 'rgba(93, 81, 72, 0.0)');
          edgeGrad.addColorStop(0.28, 'rgba(93, 81, 72, 0.74)');
          edgeGrad.addColorStop(1.0, 'rgba(93, 81, 72, 0.90)');

          ctx.strokeStyle = edgeGrad;
          ctx.beginPath();
          ctx.moveTo(esx, esy);
          ctx.quadraticCurveTo(q1x, q1y, p2x, p2y);
          ctx.stroke();
        }

        // Crisp rounded mitten paw outline arc so the white paw reads clearly against white keyboard keys!
        const pawAng = Math.atan2(dy, dx);
        ctx.strokeStyle = 'rgba(93, 81, 72, 0.92)';
        ctx.beginPath();
        ctx.ellipse(px, py, pawRx, pawRy, 0, pawAng - Math.PI * 0.62, pawAng + Math.PI * 0.62);
        ctx.stroke();
      }

      ctx.restore();
      return;
    }

    if (isSmear) {
      const smearGrad = ctx.createLinearGradient(sx, sy, px, py);
      smearGrad.addColorStop(0.0, 'rgba(20, 19, 20, 0.0)');
      smearGrad.addColorStop(0.40, 'rgba(20, 19, 20, 0.0)');
      smearGrad.addColorStop(0.72, 'rgba(20, 19, 20, 0.65)');
      smearGrad.addColorStop(1.0, 'rgba(20, 19, 20, 1.0)');
      ctx.fillStyle = smearGrad;
    } else {
      ctx.fillStyle = '#141314';
    }

    // Arm silhouette tapering gently from shoulder to wrist
    ctx.beginPath();
    ctx.moveTo(sx + nx * rShoulder, sy + ny * rShoulder);
    ctx.quadraticCurveTo(
      midX + nx * (rShoulder * 0.86),
      midY + ny * (rShoulder * 0.86),
      wx + nx * rWrist,
      wy + ny * rWrist,
    );
    ctx.lineTo(wx - nx * rWrist, wy - ny * rWrist);
    ctx.quadraticCurveTo(
      midX - nx * (rShoulder * 0.86),
      midY - ny * (rShoulder * 0.86),
      sx - nx * rShoulder,
      sy - ny * rShoulder,
    );
    ctx.closePath();
    ctx.fill();

    // Seamless shoulder merge (not needed on smears)
    if (!isSmear) {
      ctx.beginPath();
      ctx.arc(sx, sy, rShoulder, 0, Math.PI * 2);
      ctx.fill();
    }

    // Plump, soft rounded black velvet paw ball pressing firmly onto the key!
    ctx.fillStyle = '#141314';
    ctx.beginPath();
    ctx.ellipse(px, py, pawRx, pawRy, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur =0; /* perf: no per-frame blur */

    // Clean crisp subtle light-grey side separation lines ONLY where the arm crosses the black body (exact 2.2s / 8.3s / 13.2s!)
    if (!isSmear && withCrease && len > 28) {
      const startFrac = 0.18;
      const endFrac = 0.72;
      for (const sgn of [-1, 1]) {
        const csx = sx + ux * (len * startFrac) + nx * sgn * (rShoulder * 0.86);
        const csy = sy + uy * (len * startFrac) + ny * sgn * (rShoulder * 0.86);
        const cex = sx + ux * (len * endFrac) + nx * sgn * (rWrist * 1.02);
        const cey = sy + uy * (len * endFrac) + ny * sgn * (rWrist * 1.02);

        const creaseGrad = ctx.createLinearGradient(csx, csy, cex, cey);
        creaseGrad.addColorStop(0.0, 'rgba(216, 218, 222, 0.0)');
        creaseGrad.addColorStop(0.22, 'rgba(216, 218, 222, 0.65)');
        creaseGrad.addColorStop(0.84, 'rgba(216, 218, 222, 0.56)');
        creaseGrad.addColorStop(1.0, 'rgba(216, 218, 222, 0.0)');

        ctx.strokeStyle = creaseGrad;
        ctx.lineWidth = 1.3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(csx, csy);
        ctx.lineTo(cex, cey);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /**
   * Real 2-segment articulated bent kitten arm (shoulder -> elbow -> curled plump paw on chest!)
   * Matches original video 8.3s (left paw), 10.6s (both paws), 23.2s, 26.2s!
   */
  private drawBentCurledArm(ctx: CanvasRenderingContext2D, paw: PawState, breath: number, alpha: number): void {
    const sh = this.getLiveShoulder(paw, breath);
    const cp = this.getLiveCurledPawPos(paw, breath);
    const sign = paw.side === 'left' ? -1 : 1;
    // Natural elbow bends slightly outward & down below shoulder before forearm curves inward-up!
    const elbowX = sh.x + sign * 8;
    const elbowY = cp.y + 8;

    if (this.customSkin) {
      this.drawCustomBentArm(ctx, this.customSkin, paw, breath, alpha);
      return;
    }

    const isRagdoll = this.catBreed === 'ragdoll';
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Continuous bent velvety arm + plump curled paw
    ctx.strokeStyle = isRagdoll ? '#f6f2ea' : '#141314';
    ctx.lineWidth = 20;
    ctx.beginPath();
    ctx.moveTo(sh.x, sh.y);
    ctx.quadraticCurveTo(elbowX, elbowY, cp.x, cp.y);
    ctx.stroke();

    // Signature warm taupe-brown patch on viewer's RIGHT curled forearm too!
    if (isRagdoll && paw.side === 'right') {
      ctx.save();
      ctx.fillStyle = 'rgba(134, 118, 102, 0.78)';
      ctx.beginPath();
      ctx.ellipse((elbowX + cp.x) * 0.5 + 2, (elbowY + cp.y) * 0.5 + 1, 7.5, 5.2, -0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.fillStyle = isRagdoll ? '#fcfaf4' : '#141314';
    ctx.beginPath();
    ctx.ellipse(cp.x, cp.y, 12.5, 11.0, sign * 0.2, 0, Math.PI * 2);
    ctx.fill();

    // Clear crisp contour along the bent curled forearm & kitten paw
    const grad = ctx.createLinearGradient(elbowX, elbowY - 12, cp.x, cp.y + 12);
    if (isRagdoll) {
      grad.addColorStop(0.0, 'rgba(93, 81, 72, 0.0)');
      grad.addColorStop(0.28, 'rgba(93, 81, 72, 0.68)');
      grad.addColorStop(0.86, 'rgba(93, 81, 72, 0.78)');
      grad.addColorStop(1.0, 'rgba(93, 81, 72, 0.35)');
    } else {
      grad.addColorStop(0.0, 'rgba(214, 216, 220, 0.0)');
      grad.addColorStop(0.30, 'rgba(214, 216, 220, 0.65)');
      grad.addColorStop(0.85, 'rgba(220, 222, 226, 0.72)');
      grad.addColorStop(1.0, 'rgba(220, 222, 226, 0.25)');
    }

    ctx.strokeStyle = grad;
    ctx.lineWidth = isRagdoll ? 1.65 : 1.4;
    ctx.beginPath();
    ctx.moveTo(elbowX + sign * 8, elbowY - 16);
    ctx.quadraticCurveTo(elbowX + sign * 4, elbowY + 12, cp.x + sign * 2, cp.y + 10);
    ctx.quadraticCurveTo(cp.x - sign * 11, cp.y + 8, cp.x - sign * 12, cp.y - 4);
    ctx.stroke();

    ctx.restore();
  }

  private drawPaw(ctx: CanvasRenderingContext2D, paw: PawState, breath: number): void {
    // 1) Seated idle vertical front legs (EXACT 4 clean lines of ORIG 0.3s!) OR planted diagonal supporting leg (ORIG 2.2s!)
    if (paw.idleWeight > 0.05) {
      ctx.save();
      ctx.globalAlpha = paw.idleWeight;

      if (paw.side === 'right' && this.leftPaw.mode === 'mouse') {
        const sh = this.getLiveShoulder(paw, breath);
        const baseSp = this.spinePoint(1.0, breath);
        this.drawPlumpCatArm(ctx, 'right', sh.x, sh.y + 4, baseSp.x + 30, baseSp.y - 2, 0, true);
      } else {
        // Exact 4-line seated leg silhouette from ORIG 0.3s (outer curved leg line + crisp inner center-gap line!)
        const topSp = this.spinePoint(0.66, breath);
        const midSp = this.spinePoint(0.84, breath);
        const botSp = this.spinePoint(1.0, breath);
        const sign = paw.side === 'left' ? -1 : 1;

        const outerTopX = topSp.x + sign * 41;
        const outerBotX = botSp.x + sign * 35;
        const innerTopX = topSp.x + sign * 6.5;
        const innerBotX = botSp.x + sign * 9.5;

        if (this.customSkin) {
          this.drawCustomIdleLegDetails(ctx, this.customSkin, paw, topSp, midSp, botSp, sign, outerTopX, outerBotX, innerTopX, innerBotX);
          ctx.restore();
          return;
        }

        // Signature warm taupe-brown oval leg patch on viewer's RIGHT seated front leg (1:1 match to user's real Ragdoll!)
        const isRagdoll = this.catBreed === 'ragdoll';
        if (isRagdoll && paw.side === 'right') {
          ctx.save();
          ctx.fillStyle = 'rgba(134, 118, 102, 0.80)';
          ctx.shadowColor = 'rgba(134, 118, 102, 0.40)';
          ctx.shadowBlur = 0; /* perf: no per-frame blur */
          ctx.beginPath();
          ctx.ellipse(midSp.x + 21, midSp.y + 12, 9.5, 13.5, 0.22, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }

        // Crisp subtle outer leg curve & inner leg-gap line (4 total lines across both legs — exact ORIG 0.3s!)
        const lineGrad = ctx.createLinearGradient(topSp.x, topSp.y, botSp.x, botSp.y);
        if (isRagdoll) {
          lineGrad.addColorStop(0.0, 'rgba(93, 81, 72, 0.0)');
          lineGrad.addColorStop(0.18, 'rgba(93, 81, 72, 0.62)');
          lineGrad.addColorStop(0.92, 'rgba(93, 81, 72, 0.68)');
          lineGrad.addColorStop(1.0, 'rgba(93, 81, 72, 0.28)');
        } else {
          lineGrad.addColorStop(0.0, 'rgba(210, 212, 216, 0.0)');
          lineGrad.addColorStop(0.18, 'rgba(210, 212, 216, 0.64)');
          lineGrad.addColorStop(0.92, 'rgba(210, 212, 216, 0.62)');
          lineGrad.addColorStop(1.0, 'rgba(210, 212, 216, 0.25)');
        }

        ctx.strokeStyle = lineGrad;
        ctx.lineWidth = isRagdoll ? 1.55 : 1.4;
        ctx.lineCap = 'round';

        // Outer front-leg separation line (gently curves inward toward paw!)
        ctx.beginPath();
        ctx.moveTo(outerTopX, topSp.y);
        ctx.quadraticCurveTo(midSp.x + sign * 41, midSp.y, outerBotX, botSp.y - 1);
        ctx.stroke();

        // Inner front-leg gap line (tapers slightly outward toward paws, exact inverted narrow V from ORIG 0.3s!)
        ctx.beginPath();
        ctx.moveTo(innerTopX, topSp.y + 10);
        ctx.lineTo(innerBotX, botSp.y - 1);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 2) Continuous bent articulated curled chest arm (8.3s / 10.6s / 23.2s / 26.2s!)
    if (paw.curlWeight > 0.05) {
      this.drawBentCurledArm(ctx, paw, breath, paw.curlWeight);
    }

    // 3) Plump velvety poking / mouse-holding cat arm!
    const activeArmWeight = Math.max(0, 1 - paw.idleWeight - paw.curlWeight);
    if (activeArmWeight > 0.05) {
      const sh = this.getLiveShoulder(paw, breath);
      const px = paw.pos.x;
      const actionPress =
        paw.mode === 'mouse'
          ? Math.max(this.mouseLeftPress, this.mouseRightPress, this.mouseMiddlePress)
          : paw.mode === 'pen'
            ? this.penPressure
            : paw.mode === 'pad'
              ? paw.side === 'left'
                ? this.padPressLeft
                : this.padPressRight
              : 0;
      const py = paw.pos.y + actionPress * 1.8;

      ctx.save();
      ctx.globalAlpha = Math.min(1, activeArmWeight * 1.2);

      for (const sm of paw.smears) {
        ctx.save();
        const smearMult = this.customSkin || this.catBreed === 'ragdoll' ? 0.58 : 1.0;
        ctx.globalAlpha = Math.max(0, sm.alpha * activeArmWeight * smearMult);
        this.drawPlumpCatArm(ctx, paw.side, sm.sx, sm.sy, sm.px, sm.py, 0, false, true);
        ctx.restore();
      }

      // Edge-peek paws are drawn flush in screen-border space by drawScreenEdgePeekPaws() (never overlapping eyes/whiskers!)
      if (paw.mode !== 'peek') {
        // Keep mouse-reaching arm pure velvet black in open air (ORIG 2.2s); show subtle separation lines when poking across black torso!
        this.drawPlumpCatArm(ctx, paw.side, sh.x, sh.y, px, py, paw.impactSquash, paw.mode !== 'mouse', false);
      }
      ctx.restore();
    }
  }

  /** Renders two chubby 2D paws wrapped flush around the vertical screen border above & below the peeking cat head! */
  private drawScreenEdgePeekPaws(ctx: CanvasRenderingContext2D, peekP: number): void {
    const { offsetX, offsetY, uniformScale } = this.getViewportTransform();
    const s = Math.max(0.001, uniformScale);
    const leftEdge = -offsetX / s;
    const rightEdge = (this.canvas.width - offsetX) / s;
    const topEdge = -offsetY / s;
    const bottomEdge = (this.canvas.height - offsetY) / s;
    const midY = (topEdge + bottomEdge) * 0.5;

    const isLeft = this.peekVisualEdge === 'left';
    const dir = isLeft ? 1 : -1;
    const edgeX = isLeft ? leftEdge : rightEdge;
    const alpha = Math.max(0, Math.min(1, (peekP - 0.22) / 0.38));
    const slide = (1 - Math.min(1, peekP)) * 22;

    const isRagdoll = this.catBreed === 'ragdoll';
    const fill = this.customSkin ? this.customSkin.pawColor : isRagdoll ? '#f9f6ef' : '#08080a';
    const isDarkPaw =
      !isRagdoll &&
      (!this.customSkin ||
        (fill.startsWith('#') &&
          fill.length === 7 &&
          parseInt(fill.slice(1, 3), 16) * 0.299 +
            parseInt(fill.slice(3, 5), 16) * 0.587 +
            parseInt(fill.slice(5, 7), 16) * 0.114 <
            115));
    const stroke = isDarkPaw
      ? this.customSkin?.armCreaseColor || 'rgba(215, 218, 226, 0.36)'
      : this.customSkin
        ? this.customSkin.pawOutlineColor || this.customSkin.outlineColor || 'rgba(72, 62, 56, 0.55)'
        : 'rgba(93, 81, 72, 0.65)';
    const toeInk = isDarkPaw
      ? this.customSkin?.armCreaseColor || 'rgba(220, 224, 232, 0.38)'
      : this.customSkin
        ? this.customSkin.pawOutlineColor || this.customSkin.outlineColor || 'rgba(92, 80, 70, 0.50)'
        : 'rgba(110, 96, 86, 0.50)';

    ctx.save();
    ctx.globalAlpha = alpha;
    for (const side of [-1, 1] as const) {
      const bob = Math.sin(this.elapsed * 2.4 + (side < 0 ? 0 : Math.PI)) * 1.1;
      const py = midY + (side < 0 ? -53 : 63) + bob;
      const anchorX = edgeX - dir * slide;

      ctx.save();
      ctx.translate(anchorX, py);
      ctx.scale(dir, 1);

      // Rounded paw wrapping flush around the vertical edge (x = -18 behind edge -> x = +17.5 gripping inward!)
      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.65;
      ctx.beginPath();
      ctx.moveTo(-18, -11.5);
      ctx.lineTo(5.5, -11.5);
      ctx.bezierCurveTo(14.5, -11.5, 17.5, -5.5, 17.5, 0);
      ctx.bezierCurveTo(17.5, 5.5, 14.5, 11.5, 5.5, 11.5);
      ctx.lineTo(-18, 11.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Two cute inward-facing toe cleft lines gripping the edge
      ctx.strokeStyle = toeInk;
      ctx.lineWidth = 1.3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(15.6, -4.2);
      ctx.lineTo(10.6, -3.5);
      ctx.moveTo(15.6, 4.2);
      ctx.lineTo(10.6, 3.5);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  private drawKeyBubbles(ctx: CanvasRenderingContext2D): void {
    const now = performance.now();

    for (const b of this.bubbles) {
      const age = now - b.createdAt;
      const t = Math.min(1, age / b.lifetime);

      let scale = 1;
      if (t < 0.11) {
        const p = t / 0.11;
        scale = 0.62 + Math.sin(p * Math.PI * 0.65) * 0.44;
      } else if (t > 0.76) {
        scale = 1 - ((t - 0.76) / 0.24) * 0.1;
      }
      const alpha = t < 0.72 ? 1 : Math.max(0, 1 - (t - 0.72) / 0.28);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.scale(scale, scale);

      ctx.font = '700 12px "Segoe UI", system-ui, sans-serif';
      const textW = ctx.measureText(b.label).width;
      const boxW = b.isSpace ? 40 : Math.max(24, textW + 13);
      const boxH = 24;
      const bx = -boxW / 2;
      const by = -boxH / 2;

      if (!this.chromaKeyBg) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
        ctx.shadowBlur = 0; /* perf: no per-frame blur */
        ctx.shadowOffsetY = 2;
      }

      ctx.fillStyle = '#c8cac6';
      this.roundRect(ctx, bx, by + 2.2, boxW, boxH, 5.5);
      ctx.fill();

      ctx.shadowBlur =0; /* perf: no per-frame blur */
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(38, 40, 46, 0.42)';
      ctx.lineWidth = 1.05;
      this.roundRect(ctx, bx, by, boxW, boxH - 1.3, 5.5);
      ctx.fill();
      ctx.stroke();

      if (b.isSpace) {
        ctx.strokeStyle = '#222429';
        ctx.lineWidth = 1.55;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(-9, -1);
        ctx.lineTo(-9, 2.0);
        ctx.lineTo(9, 2.0);
        ctx.lineTo(9, -1);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#1e2025';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(b.label, 0, -0.5);
      }

      ctx.restore();
    }
  }

  private drawBadgeKeycap(
    ctx: CanvasRenderingContext2D,
    label: string,
    accent: string,
    x: number,
    y: number,
    alpha: number,
    scale: number,
    rot: number,
  ): void {
    if (alpha <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(scale, scale);

    ctx.font = `700 ${label.length > 2 ? 10 : 11.5}px "Segoe UI", system-ui, sans-serif`;
    const textW = ctx.measureText(label).width;
    const boxW = Math.max(27, textW + 15);
    const boxH = 22;
    const bx = -boxW / 2;
    const by = -boxH / 2;

    ctx.shadowColor = 'rgba(0, 0, 0, 0.24)';
    ctx.shadowBlur = 5;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = accent;
    this.roundRect(ctx, bx, by + 2.2, boxW, boxH, 5.5);
    ctx.fill();

    ctx.shadowBlur = 0;
    const face = ctx.createLinearGradient(0, by, 0, by + boxH);
    face.addColorStop(0, '#ffffff');
    face.addColorStop(1, '#f2f3f1');
    ctx.fillStyle = face;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.05;
    this.roundRect(ctx, bx, by, boxW, boxH - 1.3, 5.5);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = accent;
    this.roundRect(ctx, bx + 4.5, by + 2.4, boxW - 9, 2.2, 1.1);
    ctx.fill();

    ctx.fillStyle = '#1e2025';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, 1.1);
    ctx.restore();
  }

  private drawPadBubbles(ctx: CanvasRenderingContext2D): void {
    const now = performance.now();
    for (const b of this.padBubbles) {
      const t = Math.min(1, (now - b.createdAt) / b.lifetime);
      const pop = t < 0.13 ? 0.7 + Math.sin((t / 0.13) * Math.PI * 0.55) * 0.38 : 1;
      const fade = t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.3);
      const rise = 30 * (1 - (1 - t) * (1 - t));
      this.drawBadgeKeycap(
        ctx,
        b.label,
        b.accent,
        b.x + b.driftX * t,
        b.y - rise,
        fade,
        pop,
        b.rot,
      );
    }
  }

  private drawTabletBadges(ctx: CanvasRenderingContext2D): void {
    const now = performance.now();
    for (const b of this.penBadges) {
      const t = Math.min(1, (now - b.createdAt) / b.lifetime);
      const pop = t < 0.14 ? 0.68 + Math.sin((t / 0.14) * Math.PI * 0.55) * 0.4 : 1;
      const fade = t < 0.68 ? 1 : Math.max(0, 1 - (t - 0.68) / 0.32);
      this.drawBadgeKeycap(ctx, b.label, b.accent, b.x, b.y - 22 * t, fade, pop, -0.03);
    }
    for (const b of this.tabletKeyBadges) {
      const t = Math.min(1, (now - b.createdAt) / b.lifetime);
      const pop = t < 0.14 ? 0.68 + Math.sin((t / 0.14) * Math.PI * 0.55) * 0.4 : 1;
      const fade = t < 0.68 ? 1 : Math.max(0, 1 - (t - 0.68) / 0.32);
      this.drawBadgeKeycap(ctx, b.label, b.accent, b.x, b.y - 24 * t, fade, pop, 0.02);
    }
  }

  private drawMouseBadges(ctx: CanvasRenderingContext2D): void {
    const now = performance.now();
    for (let i = 0; i < this.mouseBadges.length; i++) {
      const b = this.mouseBadges[i];
      const t = Math.min(1, (now - b.createdAt) / b.lifetime);
      let scale = 1;
      if (t < 0.14) {
        scale = 0.65 + Math.sin((t / 0.14) * Math.PI * 0.65) * 0.42;
      } else if (t > 0.72) {
        scale = 1 - ((t - 0.72) / 0.28) * 0.12;
      }
      const alpha = t < 0.68 ? 1 : Math.max(0, 1 - (t - 0.68) / 0.32);
      const liftY = t * 14 + (this.mouseBadges.length - 1 - i) * 18;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(b.x, b.y - liftY);
      ctx.scale(scale, scale);

      const boxW = 34;
      const boxH = 19;
      const bx = -boxW / 2;
      const by = -boxH / 2;

      if (!this.chromaKeyBg) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.24)';
        ctx.shadowBlur = 0; /* perf: no per-frame blur */
        ctx.shadowOffsetY = 1.5;
      }

      ctx.fillStyle = '#22242a';
      this.roundRect(ctx, bx, by + 1.6, boxW, boxH, 5);
      ctx.fill();

      ctx.shadowBlur =0; /* perf: no per-frame blur */
      ctx.fillStyle = b.color;
      ctx.strokeStyle = 'rgba(20, 22, 28, 0.45)';
      ctx.lineWidth = 1.0;
      this.roundRect(ctx, bx, by, boxW, boxH - 1.0, 5);
      ctx.fill();
      ctx.stroke();

      ctx.font = '800 9.5px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = b.label === 'RMB' && b.color === '#ff7b3b' ? '#ffffff' : '#14161a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.label, 0, -0.3);

      ctx.restore();
    }
  }

  // ---- Stylus / ink / gamepad device visuals ----

  private drawDeskDevice(ctx: CanvasRenderingContext2D): void {
    if (this.deviceMode === 'gamepad') {
      this.drawGamepadModel(ctx);
    } else if (this.deviceMode === 'tablet') {
      this.drawTablet(ctx);
    } else {
      this.drawMiniMouse(ctx);
      this.drawKeyboard(ctx);
    }
  }

  private drawTablet(ctx: CanvasRenderingContext2D): void {
    const layout = this.getTabletLayout();
    const { cx, cy, w, h } = layout;
    const halfH = h / 2;
    const topHalfW = w * 0.465;
    const botHalfW = w * 0.515;
    const colors = this.getMouseButtonColors();
    const pen = this.getTabletPenPoint(performance.now());
    const pressure = this.forcedDevice === 'tablet' || this.penVisible > 0.04
      ? pen.pressure
      : this.penPressure;

    ctx.save();
    ctx.translate(cx, cy);

    // Cable peeking out from the top edge.
    ctx.save();
    ctx.strokeStyle = '#14161a';
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(w * 0.18, -halfH - 1);
    ctx.bezierCurveTo(w * 0.31, -halfH - 10, w * 0.46, -halfH - 9, w * 0.57, -halfH + 2);
    ctx.stroke();
    ctx.restore();

    // Slab shadow and graphite body.
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.36)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = '#101216';
    this.trapezoidPath(ctx, topHalfW + 2, botHalfW + 2, -halfH + 3, halfH + 4, 9);
    ctx.fill();
    ctx.restore();

    const bodyGrad = ctx.createLinearGradient(0, -halfH, 0, halfH);
    bodyGrad.addColorStop(0, '#2e323a');
    bodyGrad.addColorStop(0.55, '#20242a');
    bodyGrad.addColorStop(1, '#15181d');
    ctx.fillStyle = bodyGrad;
    ctx.strokeStyle = '#3c4048';
    ctx.lineWidth = 1.1;
    this.trapezoidPath(ctx, topHalfW, botHalfW, -halfH, halfH, 8);
    ctx.fill();
    ctx.stroke();

    // Soft top sheen.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-topHalfW * 0.62, -halfH + 4);
    ctx.quadraticCurveTo(0, -halfH + 1.5, topHalfW * 0.62, -halfH + 4);
    ctx.stroke();

    // Drawing surface.
    const sx = layout.surfaceCx - cx;
    const sy = layout.surfaceCy - cy;
    const sw = layout.surfaceW;
    const sh = layout.surfaceH;
    const surfaceGrad = ctx.createLinearGradient(0, sy - sh / 2, 0, sy + sh / 2);
    surfaceGrad.addColorStop(0, '#3a3e46');
    surfaceGrad.addColorStop(1, '#292d34');
    ctx.fillStyle = surfaceGrad;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.13)';
    ctx.lineWidth = 1;
    this.roundRect(ctx, sx - sw / 2, sy - sh / 2, sw, sh, 6);
    ctx.fill();
    ctx.stroke();

    // Express keys on the left bezel.
    const keyX = -w * 0.425;
    for (let i = 0; i < 4; i++) {
      const keyY = -halfH * 0.48 + i * (h * 0.125);
      ctx.fillStyle = this.tabletPhysicalKeys[i]
        ? colors.left
        : this.tabletTailKeys[i]
          ? '#ff9d4d'
          : '#3a3f48';
      this.roundRect(ctx, keyX, keyY, Math.max(3.5, w * 0.028), h * 0.09, 1.6);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.font = '600 4.4px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('KURO', keyX + w * 0.014, halfH - 9);

    // Pressure meter on the lower right bezel.
    const meterX = sx + sw * 0.24;
    const meterY = halfH - 8;
    ctx.fillStyle = '#16191d';
    this.roundRect(ctx, meterX, meterY, sw * 0.24, 4, 2);
    ctx.fill();
    if (pressure > 0.02) {
      ctx.fillStyle = colors.left;
      this.roundRect(ctx, meterX, meterY, sw * 0.24 * Math.min(1, pressure), 4, 2);
      ctx.fill();
    }

    // USB-C port and DEMO badge.
    ctx.fillStyle = '#0e1013';
    this.roundRect(ctx, -7, -halfH + 1.5, 14, 3.2, 1.6);
    ctx.fill();
    if (this.forcedDevice === 'tablet') {
      ctx.strokeStyle = colors.left;
      ctx.fillStyle = 'rgba(20, 22, 26, 0.72)';
      ctx.lineWidth = 0.8;
      this.roundRect(ctx, topHalfW - 34, -halfH + 4, 30, 9, 4.5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = colors.left;
      ctx.font = '700 5.4px "Segoe UI", system-ui, sans-serif';
      ctx.fillText('DEMO', topHalfW - 19, -halfH + 8.6);
    }

    ctx.restore();
    this.drawTabletInk(ctx, layout);
  }

  private drawTabletInk(
    ctx: CanvasRenderingContext2D,
    layout: ReturnType<KuroCatEngine['getTabletLayout']>,
  ): void {
    const colors = this.getMouseButtonColors();
    const left = layout.surfaceCx - layout.surfaceW / 2;
    const top = layout.surfaceCy - layout.surfaceH / 2;

    ctx.save();
    this.roundRect(ctx, left, top, layout.surfaceW, layout.surfaceH, 6);
    ctx.clip();

    // Faint dot grid makes the tablet surface read as a drawing area.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.055)';
    for (let x = left + 8; x < left + layout.surfaceW - 4; x += 13) {
      for (let y = top + 7; y < top + layout.surfaceH - 4; y += 11) {
        ctx.fillRect(x, y, 0.8, 0.8);
      }
    }

    const now = performance.now();
    const demoActive = this.forcedDevice === 'tablet' && now - this.penLastAt > 3000;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = colors.left;

    if (demoActive) {
      const t = this.elapsed;
      const demo: Array<{ x: number; y: number; p: number; a: number }> = [];
      for (let i = 62; i >= 0; i--) {
        const sample = t - i * 0.022;
        const u = 0.5 + 0.34 * Math.sin(sample * 0.95 + 0.4);
        const v = 0.5 + 0.27 * Math.sin(sample * 1.37 + 1.15);
        demo.push({
          x: layout.surfaceCx + (u - 0.5) * layout.surfaceW * 0.9,
          y: layout.surfaceCy + (v - 0.5) * layout.surfaceH * 0.78,
          p: 0.38 + 0.42 * (0.5 + 0.5 * Math.sin(sample * 2.2)),
          a: 1 - i / 63,
        });
      }
      this.strokeInkTrail(ctx, demo, 3.2, 0.9);
    } else if (this.penTrail.length > 1) {
      this.strokeInkTrail(ctx, this.penTrail, 5, 0.92);
    }

    ctx.restore();
  }

  /**
   * Strokes the ink trail in a handful of batches.
   *
   * Every segment used to be stroked on its own. A full trail holds 140
   * points, so that was 139 canvas calls per frame and the renderer lost
   * 20-40 ms per frame on it - the cat visibly stuttered while the user was
   * drawing. The segments are grouped by alpha instead, which keeps the fade
   * but turns the whole trail into a couple of strokes.
   */
  private strokeInkTrail(
    ctx: CanvasRenderingContext2D,
    points: Array<{ x: number; y: number; p: number; a: number }>,
    widthScale: number,
    alphaScale: number,
  ): void {
    const BUCKETS = 8;
    if (points.length < 2) return;
    if (this.inkBuckets.length !== BUCKETS) {
      this.inkBuckets.length = 0;
      this.inkBucketAlpha.length = 0;
      for (let i = 0; i < BUCKETS; i++) {
        this.inkBuckets.push([]);
        this.inkBucketAlpha.push(0);
      }
    } else {
      for (const bucket of this.inkBuckets) bucket.length = 0;
      for (let i = 0; i < BUCKETS; i++) this.inkBucketAlpha[i] = 0;
    }

    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const alpha = Math.min(a.a, b.a);
      if (alpha <= 0.02) continue;
      const bucket = Math.min(BUCKETS - 1, Math.floor(alpha * BUCKETS));
      this.inkBuckets[bucket].push(i);
      this.inkBucketAlpha[bucket] += alpha;
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let bucket = 0; bucket < BUCKETS; bucket++) {
      const indices = this.inkBuckets[bucket];
      if (indices.length === 0) continue;
      let width = 0;
      let previousIndex = -2;
      ctx.beginPath();
      for (const index of indices) {
        const a = points[index - 1];
        const b = points[index];
        // Segments that follow each other become one continuous polyline, so
        // a whole bucket needs a single moveTo instead of one per segment.
        if (index !== previousIndex + 1) ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        previousIndex = index;
        width += 1 + ((a.p + b.p) * 0.5) * widthScale;
      }
      ctx.globalAlpha = Math.min(1, this.inkBucketAlpha[bucket] / indices.length) * alphaScale;
      ctx.lineWidth = width / indices.length;
      ctx.stroke();
    }
  }

  private drawTabletPen(ctx: CanvasRenderingContext2D): void {
    const layout = this.getTabletLayout();
    const colors = this.getMouseButtonColors();
    const now = performance.now();
    const active = this.forcedDevice === 'tablet' || this.penVisible > 0.03;

    if (!active) {
      // Pen resting along the top-right bezel when idle.
      ctx.save();
      ctx.translate(layout.surfaceCx + layout.surfaceW * 0.3, layout.cy - layout.h * 0.33);
      ctx.rotate(-0.1);
      ctx.globalAlpha = 0.78;
      ctx.fillStyle = '#252932';
      this.roundRect(ctx, 0, -2.2, 44, 4.4, 2.2);
      ctx.fill();
      ctx.fillStyle = colors.right;
      this.roundRect(ctx, 31, -2.6, 7, 5.2, 2.2);
      ctx.fill();
      ctx.fillStyle = '#e7e9ee';
      ctx.beginPath();
      ctx.moveTo(-5, 0);
      ctx.lineTo(0, -1.7);
      ctx.lineTo(0, 1.7);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      return;
    }

    const pen = this.getTabletPenPoint(now);
    const grip = this.getPenGrip(pen.x, pen.y);
    const dx = grip.x - pen.x;
    const dy = grip.y - pen.y;
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length;
    const uy = dy / length;
    const px = -uy;
    const py = ux;
    const capX = grip.x + ux * 12;
    const capY = grip.y + uy * 12;
    const alpha = this.forcedDevice === 'tablet' ? 1 : Math.max(0, this.penVisible);
    const pressure = pen.pressure;

    ctx.save();
    ctx.globalAlpha = alpha;

    if (pressure > 0.02) {
      const glow = ctx.createRadialGradient(pen.x, pen.y, 0, pen.x, pen.y, 9 + pressure * 9);
      glow.addColorStop(0, colors.left);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = alpha * (0.3 + pressure * 0.45);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(pen.x, pen.y, 9 + pressure * 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = alpha;
    }

    // Dark tapered barrel with a slim accent ring near the grip.
    ctx.beginPath();
    ctx.moveTo(pen.x + px * 1.8, pen.y + py * 1.8);
    ctx.lineTo(capX + px * 4.4, capY + py * 4.4);
    ctx.lineTo(capX - px * 4.4, capY - py * 4.4);
    ctx.lineTo(pen.x - px * 1.8, pen.y - py * 1.8);
    ctx.closePath();
    const barrel = ctx.createLinearGradient(pen.x, pen.y, capX, capY);
    barrel.addColorStop(0, '#3c414b');
    barrel.addColorStop(1, '#1e2127');
    ctx.fillStyle = barrel;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 0.8;
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = colors.right;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(grip.x + px * 4.2, grip.y + py * 4.2);
    ctx.lineTo(grip.x - px * 4.2, grip.y - py * 4.2);
    ctx.stroke();

    // Real pen barrel buttons sit just below the grip ring.
    const drawPenButton = (inset: number, pressed: boolean, color: string) => {
      const bx = grip.x - ux * inset + px * 4.0;
      const by = grip.y - uy * inset + py * 4.0;
      ctx.fillStyle = pressed ? color : '#111318';
      ctx.strokeStyle = pressed ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.22)';
      ctx.lineWidth = pressed ? 1 : 0.7;
      ctx.beginPath();
      ctx.arc(bx, by, 2.25, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    };
    drawPenButton(7, this.penBarrel, colors.right);
    drawPenButton(16, this.penSecondBarrel, '#7ac7ff');

    // Cap and metal nib; the eraser end mirrors the real inverted pen state.
    ctx.fillStyle = this.penEraser ? '#ff7bb0' : '#2b2f37';
    ctx.beginPath();
    ctx.arc(capX, capY, 4.2, 0, Math.PI * 2);
    ctx.fill();
    if (this.penEraser) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.lineWidth = 0.9;
      ctx.stroke();
    }
    ctx.fillStyle = this.penEraser ? '#ffd0e0' : '#e7e9ee';
    ctx.beginPath();
    ctx.arc(pen.x, pen.y, 1.7 + pressure * 1.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  private drawGamepadModel(ctx: CanvasRenderingContext2D): void {
    const pad = this.getActiveGamepad();
    if (!pad || pad.visible < 0.03) return;
    const layout = this.getGamepadLayout();
    const colors = this.getMouseButtonColors();
    const scale = layout.scale;
    const intensity = Math.max(
      0,
      ...pad.buttons.slice(0, 17),
      pad.triggers[0] ?? 0,
      pad.triggers[2] ?? 0,
      Math.abs(pad.axes[0] ?? 0),
      Math.abs(pad.axes[1] ?? 0),
      Math.abs(pad.axes[2] ?? 0),
      Math.abs(pad.axes[3] ?? 0),
    );
    const rumbleX = intensity > 0.35 ? Math.sin(this.elapsed * 46) * intensity * 0.7 : 0;
    const rumbleY = intensity > 0.35 ? Math.cos(this.elapsed * 39) * intensity * 0.45 : 0;

    const bodyPath = () => {
      ctx.beginPath();
      ctx.moveTo(-52, -30);
      ctx.quadraticCurveTo(0, -40, 52, -30);
      ctx.bezierCurveTo(86, -30, 112, -22, 126, 0);
      ctx.bezierCurveTo(142, 26, 140, 48, 118, 49);
      ctx.bezierCurveTo(96, 50, 80, 34, 64, 30);
      ctx.bezierCurveTo(40, 36, -40, 36, -64, 30);
      ctx.bezierCurveTo(-80, 34, -96, 50, -118, 49);
      ctx.bezierCurveTo(-140, 48, -142, 26, -126, 0);
      ctx.bezierCurveTo(-112, -22, -86, -30, -52, -30);
      ctx.closePath();
    };

    ctx.save();
    ctx.globalAlpha = Math.min(1, pad.visible);
    ctx.translate(layout.cx + rumbleX, layout.cy + rumbleY);
    ctx.rotate(-0.012);
    ctx.scale(scale, -scale);

    const fillUprightText = (text: string, x: number, y: number) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, -1);
      ctx.fillText(text, 0, 0);
      ctx.restore();
    };

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.42)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 5;
    ctx.fillStyle = '#0d0f12';
    ctx.save();
    ctx.translate(0, 2);
    bodyPath();
    ctx.fill();
    ctx.restore();
    ctx.restore();

    // Triggers peek out behind the body.
    const drawTrigger = (x: number, level: number, label: string) => {
      ctx.fillStyle = '#171a1f';
      this.roundRect(ctx, x, -43, 30, 13, 4.5);
      ctx.fill();
      if (level > 0.02) {
        ctx.fillStyle = colors.left;
        this.roundRect(ctx, x + 1.2, -41.8, 27.6 * Math.min(1, level), 10.6, 3.6);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(255, 255, 255, 0.62)';
      ctx.font = '700 5px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      fillUprightText(label, x + 15, -36.2);
    };
    drawTrigger(-98, Math.max(pad.buttons[4] ?? 0, pad.triggers[0] ?? 0), 'LT');
    drawTrigger(68, Math.max(pad.buttons[6] ?? 0, pad.triggers[2] ?? 0), 'RT');

    const shell = ctx.createLinearGradient(0, -40, 0, 50);
    shell.addColorStop(0, '#3a3f49');
    shell.addColorStop(0.35, '#2a2e36');
    shell.addColorStop(1, '#16191e');
    bodyPath();
    ctx.fillStyle = shell;
    ctx.strokeStyle = '#4c515c';
    ctx.lineWidth = 1.2;
    ctx.fill();
    ctx.stroke();

    // Top edge sheen.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-46, -31);
    ctx.quadraticCurveTo(0, -39, 46, -31);
    ctx.stroke();

    // Bumpers sit on the top edge.
    const drawBumper = (x: number, level: number, label: string) => {
      ctx.fillStyle = level > 0.1 ? colors.left : '#23272e';
      this.roundRect(ctx, x, -32, 40, 9, 4);
      ctx.fill();
      ctx.fillStyle = level > 0.1 ? '#12151a' : 'rgba(255, 255, 255, 0.46)';
      ctx.font = '700 5.4px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      fillUprightText(label, x + 20, -27.2);
    };
    drawBumper(-94, pad.buttons[5] ?? 0, 'LB');
    drawBumper(54, pad.buttons[7] ?? 0, 'RB');

    const drawStick = (
      baseX: number,
      baseY: number,
      axisX: number,
      axisY: number,
      pressed: boolean,
    ) => {
      const x = baseX + axisX * 5;
      const y = baseY + axisY * 5;
      ctx.fillStyle = '#111318';
      ctx.beginPath();
      ctx.arc(baseX, baseY, 15.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.11)';
      ctx.lineWidth = 1;
      ctx.stroke();

      const knob = ctx.createRadialGradient(x - 2.5, y - 3.5, 1, x, y, 11);
      knob.addColorStop(0, '#555b66');
      knob.addColorStop(1, '#2a2e36');
      ctx.fillStyle = knob;
      ctx.beginPath();
      ctx.arc(x, y, 10.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = pressed ? colors.left : '#4b505a';
      ctx.lineWidth = pressed ? 1.8 : 1;
      ctx.stroke();

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.lineWidth = 0.9;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.arc(x, y, 6.8, -0.8 + i * 0.85, 0.35 + i * 0.85);
        ctx.stroke();
      }
    };
    drawStick(-26, 8, pad.axes[0] ?? 0, pad.axes[1] ?? 0, (pad.buttons[11] ?? 0) > 0.1);
    drawStick(64, 8, pad.axes[2] ?? 0, pad.axes[3] ?? 0, (pad.buttons[12] ?? 0) > 0.1);

    // D-pad.
    const dpadX = 30;
    const dpadY = 8;
    const dpadLevels = [13, 14, 15, 16].map((id) => pad.buttons[id] ?? 0);
    ctx.fillStyle = '#191c21';
    this.roundRect(ctx, dpadX - 19, dpadY - 6.5, 38, 13, 3);
    ctx.fill();
    this.roundRect(ctx, dpadX - 6.5, dpadY - 19, 13, 38, 3);
    ctx.fill();
    const dpadArm = (x: number, y: number, w: number, h: number, level: number) => {
      ctx.fillStyle = level > 0.1 ? colors.left : '#353a43';
      this.roundRect(ctx, x, y, w, h, 2);
      ctx.fill();
    };
    dpadArm(dpadX - 5, dpadY + 8.5, 10, 10, dpadLevels[0]);
    dpadArm(dpadX - 5, dpadY - 18.5, 10, 10, dpadLevels[1]);
    dpadArm(dpadX - 18.5, dpadY - 5, 10, 10, dpadLevels[2]);
    dpadArm(dpadX + 8.5, dpadY - 5, 10, 10, dpadLevels[3]);

    // Face buttons.
    const face = [
      { id: 2, x: -68, y: -12, color: '#ffd34d', label: 'Y' },
      { id: 1, x: -82, y: 2, color: '#ff6b6b', label: 'B' },
      { id: 0, x: -68, y: 16, color: '#66d17a', label: 'A' },
      { id: 3, x: -54, y: 2, color: '#5aa9ff', label: 'X' },
    ];
    for (const button of face) {
      const level = pad.buttons[button.id] ?? 0;
      ctx.beginPath();
      ctx.arc(button.x, button.y, 8.2, 0, Math.PI * 2);
      ctx.fillStyle = level > 0.1 ? button.color : '#252930';
      ctx.fill();
      ctx.strokeStyle = level > 0.1 ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.13)';
      ctx.lineWidth = level > 0.1 ? 1.4 : 0.8;
      ctx.stroke();
      ctx.fillStyle = level > 0.1 ? '#12151a' : 'rgba(255, 255, 255, 0.52)';
      ctx.font = '800 7px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      fillUprightText(button.label, button.x, button.y + 0.2);
    }

    // Center menu buttons and paw logo.
    const menu = [
      { id: 8, x: 14 },
      { id: 9, x: 0 },
      { id: 17, x: -14 },
    ];
    for (const item of menu) {
      const level = pad.buttons[item.id] ?? 0;
      ctx.fillStyle = level > 0.1 ? colors.right : '#3a3f48';
      this.roundRect(ctx, item.x - 1.8, -22, 3.6, 6, 1.5);
      ctx.fill();
    }

    ctx.strokeStyle = colors.left;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(0, -3, 7.2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = colors.left;
    for (const [toeX, toeY, radius] of [
      [-3.2, -6.2, 1.5],
      [0, -7.1, 1.7],
      [3.2, -6.2, 1.5],
    ]) {
      ctx.beginPath();
      ctx.arc(toeX, toeY, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.ellipse(0, -1.5, 4.2, 3.2, 0, 0, Math.PI * 2);
    ctx.fill();

    // Connection LED and player badge.
    const ledPulse = 0.55 + 0.45 * Math.sin(this.elapsed * 4.2);
    ctx.fillStyle = `rgba(120, 235, 150, ${ledPulse.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(-118, -23, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.font = '700 5.4px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'left';
    fillUprightText(pad === this.demoPad ? 'DEMO' : `PAD ${pad.name.slice(0, 14)}`, -112, -58);

    if (pad === this.demoPad) {
      ctx.strokeStyle = colors.left;
      ctx.fillStyle = 'rgba(18, 20, 24, 0.7)';
      ctx.lineWidth = 0.8;
      this.roundRect(ctx, -76, -53, 32, 10, 5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = colors.left;
      ctx.font = '700 5.4px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      fillUprightText('DEMO', -60, -48.5);
    }

    ctx.restore();
  }

  private drawGamepadStickRings(ctx: CanvasRenderingContext2D): void {
    if (this.deviceMode !== 'gamepad') return;
    const pad = this.getActiveGamepad();
    if (!pad || pad.visible < 0.03) return;
    const layout = this.getGamepadLayout();
    const colors = this.getMouseButtonColors();
    const sticks = [
      { x: -26, y: 8, accent: (pad.buttons[11] ?? 0) > 0.1 },
      { x: 64, y: 8, accent: (pad.buttons[12] ?? 0) > 0.1 },
    ];

    ctx.save();
    ctx.globalAlpha = Math.min(1, pad.visible) * 0.9;
    for (const stick of sticks) {
      const sx = layout.cx + stick.x * layout.scale;
      const sy = layout.cy - stick.y * layout.scale;
      const radius = 12.4 * layout.scale;
      ctx.strokeStyle = stick.accent ? colors.left : 'rgba(205, 213, 226, 0.52)';
      ctx.lineWidth = stick.accent ? 2.2 : 1.5;
      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.34)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(sx, sy, radius - 1.4, Math.PI * 1.05, Math.PI * 1.42);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawCustomCatBody(
    ctx: CanvasRenderingContext2D,
    s: ResolvedSkin,
    breath: number,
    purrShift: number,
  ): void {
    const leftPts: Vec2[] = [];
    const rightPts: Vec2[] = [];
    const scruffSlim = Math.min(1, this.scruffAmount) * 0.14;
    const bellySwell = 1 + this.typingHunch * 0.04 + this.sleepAmount * 0.085 - scruffSlim;
    const headCenter = this.spinePoint(0.24, breath);
    const hcx = headCenter.x + purrShift;
    const hcy = headCenter.y;

    const contour = s.contour;
    const hwScale = contour.headWidth;
    const jawSq = contour.jawSquareness;
    const chubby = contour.bodyChubbiness;
    const isFox = contour.faceShape === 'fox';
    const isOval = contour.faceShape === 'oval';

    for (const slice of BODY_SLICES) {
      const sp = this.spinePoint(slice.t, breath);
      let mult = 1.0;
      if (slice.t <= 0.14) {
        // Forehead / temples (keep slightly narrower than cheeks so square face has soft rounded top corners, not horns)
        mult = hwScale * (1 + jawSq * 0.08) * (isOval ? 0.94 : 1.0);
      } else if (slice.t <= 0.24) {
        // Eye line
        mult = hwScale * (1 + jawSq * 0.10) * (isOval ? 0.96 : 1.0);
      } else if (slice.t <= 0.33) {
        // Cheeks / jaw (widest & flattest on square Tibetan fox face)
        mult = hwScale * (1 + jawSq * 0.11) * (isFox ? 0.88 : 1.0);
      } else if (slice.t <= 0.40) {
        // Neck transition
        mult = (hwScale * 0.48 + chubby * 0.52) * (1 + jawSq * 0.08) * (isFox ? 0.90 : 1.0);
      } else {
        mult = chubby * (slice.t > 0.45 ? bellySwell : 1);
      }
      const hw = slice.hw * mult;

      if (slice.t <= 0.38) {
        const tiltW = slice.t <= 0.30 ? 1.0 : (0.42 - slice.t) / 0.12;
        const ang = this.headTilt * tiltW;
        const cosA = Math.cos(ang);
        const sinA = Math.sin(ang);
        const relY = sp.y - hcy;
        const lx0 = sp.x + purrShift - hw - hcx;
        const rx0 = sp.x + purrShift + hw - hcx;
        leftPts.push({ x: hcx + lx0 * cosA - relY * sinA, y: hcy + lx0 * sinA + relY * cosA });
        rightPts.push({ x: hcx + rx0 * cosA - relY * sinA, y: hcy + rx0 * sinA + relY * cosA });
      } else {
        leftPts.push({ x: sp.x + purrShift - hw, y: sp.y });
        rightPts.push({ x: sp.x + purrShift + hw, y: sp.y });
      }
    }

    const crownRelY =
      this.spinePoint(0.11, breath).y - hcy - jawSq * 1.5 - (isOval ? 6.0 : 0);
    const crownPt = {
      x: hcx - crownRelY * Math.sin(this.headTilt),
      y: hcy + crownRelY * Math.cos(this.headTilt),
    };
    const basePt = this.spinePoint(1.0, breath);

    ctx.save();
    if (!this.chromaKeyBg) {
      ctx.shadowColor = s.isDarkBase ? 'rgba(18, 17, 18, 0.42)' : 'rgba(30, 32, 42, 0.22)';
      ctx.shadowBlur = 0; /* perf: no per-frame blur */
      if (!s.isDarkBase) ctx.shadowOffsetY = 2;
    }

    // 1) Grounded hind paws always rendered in seated posture (dangle gently when scruffed!)
    ctx.fillStyle = s.pawColor;
    ctx.strokeStyle = s.pawOutlineColor || s.outlineColor || 'transparent';
    ctx.lineWidth = 1.85;
    const scruffFootDrop = Math.min(1, this.scruffAmount) * 12.0;
    const scruffFootSway = Math.min(1, this.scruffAmount) * this.scruffSwing * 14;
    const scruffFootRot = Math.min(1, this.scruffAmount) * this.scruffSwing * 0.24;
    const scruffFootScaleX = 1 - Math.min(1, this.scruffAmount) * 0.14;
    const scruffFootScaleY = 1 + Math.min(1, this.scruffAmount) * 0.24;
    for (const [fx, fy, rx, ry] of [
      [basePt.x - 42 + scruffFootSway, basePt.y - 3 + scruffFootDrop, 14.5 * scruffFootScaleX, 11.5 * scruffFootScaleY],
      [basePt.x + 32 + scruffFootSway, basePt.y - 1 + scruffFootDrop, 15.0 * scruffFootScaleX, 11.5 * scruffFootScaleY],
    ]) {
      ctx.beginPath();
      ctx.ellipse(fx, fy, rx, ry, scruffFootRot, 0, Math.PI * 2);
      ctx.fill();
      if (s.pawOutlineColor || s.outlineColor) {
        ctx.save();
        ctx.shadowBlur =0; /* perf: no per-frame blur */
        ctx.shadowOffsetY = 0;
        ctx.stroke();
        ctx.restore();
      }
    }

    // 2) Unified flexible body path (supports round, square Tibetan fox, wide tiger, fox & oval silhouettes)
    const traceBodyPath = () => {
      ctx.beginPath();
      const crownCos = Math.cos(this.headTilt);
      const crownSin = Math.sin(this.headTilt);
      const shoulderInset = 14 * (1 - jawSq * 0.35);
      const shoulderLift = 6 * (1 - jawSq * 0.30) + (isOval ? 3 : 0);
      const crownArch = -2 + jawSq * 1.4 - (isOval ? 4 : 0);
      ctx.moveTo(
        leftPts[0].x + shoulderInset * crownCos + shoulderLift * crownSin,
        leftPts[0].y + shoulderInset * crownSin - shoulderLift * crownCos,
      );
      ctx.quadraticCurveTo(
        crownPt.x,
        crownPt.y + crownArch,
        rightPts[0].x - shoulderInset * crownCos + shoulderLift * crownSin,
        rightPts[0].y - shoulderInset * crownSin - shoulderLift * crownCos,
      );
      ctx.lineTo(rightPts[0].x, rightPts[0].y);
      for (let i = 0; i < rightPts.length - 1; i++) {
        const p0 = rightPts[i];
        const p1 = rightPts[i + 1];
        if (jawSq > 0.35 && i <= 2) {
          // Crisp straighter box-cheek side for square face (e.g. Tibetan fox)
          const k = 0.5 + jawSq * 0.36;
          ctx.quadraticCurveTo(p0.x, p0.y, p0.x + (p1.x - p0.x) * k, p0.y + (p1.y - p0.y) * k);
        } else {
          ctx.quadraticCurveTo(p0.x, p0.y, (p0.x + p1.x) * 0.5, (p0.y + p1.y) * 0.5);
        }
      }
      ctx.lineTo(rightPts[rightPts.length - 1].x, rightPts[rightPts.length - 1].y);
      ctx.quadraticCurveTo(basePt.x + purrShift, basePt.y + 6, leftPts[leftPts.length - 1].x, leftPts[leftPts.length - 1].y);
      for (let i = leftPts.length - 1; i > 0; i--) {
        const p0 = leftPts[i];
        const p1 = leftPts[i - 1];
        if (jawSq > 0.35 && i <= 3) {
          const k = 0.5 + jawSq * 0.36;
          ctx.quadraticCurveTo(p0.x, p0.y, p0.x + (p1.x - p0.x) * k, p0.y + (p1.y - p0.y) * k);
        } else {
          ctx.quadraticCurveTo(p0.x, p0.y, (p0.x + p1.x) * 0.5, (p0.y + p1.y) * 0.5);
        }
      }
      ctx.lineTo(leftPts[0].x, leftPts[0].y);
      ctx.closePath();
    };

    traceBodyPath();
    const furGrad = ctx.createRadialGradient(hcx, hcy + 65, 18, basePt.x, basePt.y - 60, 150);
    furGrad.addColorStop(0.0, s.furColor);
    furGrad.addColorStop(1.0, s.furSecondaryColor);
    ctx.fillStyle = furGrad;
    ctx.fill();

    // 3) Clipped coat pattern markings & custom spots
    ctx.save();
    ctx.shadowBlur =0; /* perf: no per-frame blur */
    ctx.shadowOffsetY = 0;
    ctx.clip();

    const midTorso = this.spinePoint(0.70, breath);
    const chestSp = this.spinePoint(0.56, breath);

    if (s.flankColor) {
      for (const sgn of [-1, 1]) {
        ctx.save();
        ctx.globalAlpha = 0.62;
        ctx.fillStyle = s.flankColor;
        ctx.shadowColor = s.flankColor;
        ctx.shadowBlur = 0; /* perf: no per-frame blur */
        ctx.beginPath();
        ctx.ellipse(midTorso.x + purrShift + sgn * 62, midTorso.y + 6, 48, 82, sgn * -0.14, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    if (s.bellyBibColor) {
      ctx.fillStyle = s.bellyBibColor;
      ctx.beginPath();
      ctx.ellipse(chestSp.x + purrShift, chestSp.y + 38, 36, 62, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    if (s.pattern === 'tabby' && s.stripeColor) {
      ctx.strokeStyle = s.stripeColor;
      ctx.lineCap = 'round';
      ctx.lineWidth = 4.6;
      ctx.globalAlpha = 0.65;
      for (const sgn of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          const ty = midTorso.y - 26 + i * 20;
          ctx.beginPath();
          ctx.moveTo(midTorso.x + purrShift + sgn * 74, ty);
          ctx.quadraticCurveTo(midTorso.x + purrShift + sgn * 56, ty + 3, midTorso.x + purrShift + sgn * 42, ty + 7);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    if (s.pattern === 'calico') {
      const orangePatch = s.maskColor || '#ea9446';
      const darkPatch = s.calicoPatchColor || '#3c3634';
      ctx.save();
      ctx.shadowBlur = 0; /* perf: no per-frame blur */
      ctx.shadowColor = orangePatch;
      ctx.fillStyle = orangePatch;
      ctx.beginPath();
      ctx.ellipse(midTorso.x + purrShift - 54, midTorso.y + 10, 38, 52, -0.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.shadowColor = darkPatch;
      ctx.fillStyle = darkPatch;
      ctx.beginPath();
      ctx.ellipse(midTorso.x + purrShift + 56, midTorso.y - 4, 36, 56, 0.18, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Body custom spots
    for (const spot of s.spots) {
      if (spot.part !== 'body') continue;
      ctx.save();
      ctx.globalAlpha = spot.opacity ?? 0.85;
      ctx.fillStyle = spot.color;
      ctx.beginPath();
      ctx.ellipse(
        midTorso.x + purrShift + spot.x * 65,
        midTorso.y + spot.y * 65,
        Math.max(2, spot.rx),
        Math.max(2, spot.ry),
        spot.rotation || 0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.restore();
    }

    // Head-space patterns (rotate seamlessly with headTilt!)
    ctx.save();
    ctx.translate(hcx, hcy);
    ctx.rotate(this.headTilt);
    const maskShift = this.faceTurnX * 0.72;

    if (s.pattern === 'bicolor' && s.maskColor) {
      ctx.save();
      ctx.fillStyle = s.maskColor;
      ctx.shadowColor = s.maskColor;
      ctx.shadowBlur = 0; /* perf: no per-frame blur */
      ctx.beginPath();
      ctx.moveTo(-74, -44);
      ctx.lineTo(74, -44);
      ctx.lineTo(70, 20);
      ctx.quadraticCurveTo(maskShift + 42, 18, maskShift + 26, 9);
      ctx.quadraticCurveTo(maskShift + 17, 0, maskShift + 13.5, -13);
      ctx.quadraticCurveTo(maskShift + 7, -21.5, maskShift, -22.5);
      ctx.quadraticCurveTo(maskShift - 7, -21.5, maskShift - 13.5, -13);
      ctx.quadraticCurveTo(maskShift - 17, 0, maskShift - 26, 9);
      ctx.quadraticCurveTo(maskShift - 42, 18, -70, 20);
      ctx.closePath();
      ctx.fill();
      if (s.foreheadBridgeColor) {
        ctx.fillStyle = s.foreheadBridgeColor;
        ctx.shadowBlur = 0; /* perf: no per-frame blur */
        ctx.beginPath();
        ctx.ellipse(maskShift, -32, 18, 9, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    } else if (s.pattern === 'tuxedo' && s.bellyBibColor) {
      ctx.fillStyle = s.bellyBibColor;
      ctx.beginPath();
      ctx.ellipse(maskShift, 22, 26, 15, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (s.pattern === 'siamese' && s.maskColor) {
      ctx.save();
      ctx.fillStyle = s.maskColor;
      ctx.shadowColor = s.maskColor;
      ctx.shadowBlur = 0; /* perf: no per-frame blur */
      ctx.beginPath();
      ctx.ellipse(maskShift, 3, 42, 27, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (s.pattern === 'calico') {
      const orangePatch = s.maskColor || '#ea9446';
      const darkPatch = s.calicoPatchColor || '#3c3634';
      ctx.save();
      ctx.shadowBlur = 0; /* perf: no per-frame blur */
      ctx.fillStyle = orangePatch;
      ctx.shadowColor = orangePatch;
      ctx.beginPath();
      ctx.ellipse(-34 + maskShift * 0.4, -18, 34, 28, -0.25, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = darkPatch;
      ctx.shadowColor = darkPatch;
      ctx.beginPath();
      ctx.ellipse(36 + maskShift * 0.4, -16, 32, 26, 0.25, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (s.pattern === 'tabby' && s.stripeColor) {
      // Iconic tabby forehead "M" & cheek stripes!
      ctx.strokeStyle = s.stripeColor;
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.78;
      // Center M stripes on forehead
      ctx.beginPath();
      ctx.moveTo(maskShift - 11, -30);
      ctx.lineTo(maskShift - 8, -19);
      ctx.moveTo(maskShift, -32);
      ctx.lineTo(maskShift, -18);
      ctx.moveTo(maskShift + 11, -30);
      ctx.lineTo(maskShift + 8, -19);
      ctx.stroke();
      // Cheek tiger stripes
      ctx.lineWidth = 2.8;
      for (const sgn of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(sgn * 58, 6);
        ctx.lineTo(sgn * 42, 9);
        ctx.moveTo(sgn * 56, 14);
        ctx.lineTo(sgn * 41, 16);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Head custom spots
    for (const spot of s.spots) {
      if (spot.part !== 'head') continue;
      ctx.save();
      ctx.globalAlpha = spot.opacity ?? 0.85;
      ctx.fillStyle = spot.color;
      ctx.beginPath();
      ctx.ellipse(
        maskShift + spot.x * 52,
        spot.y * 36,
        Math.max(2, spot.rx),
        Math.max(2, spot.ry),
        spot.rotation || 0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.restore();
    }

    ctx.restore(); // end head-space patterns
    ctx.restore(); // end body clip

    if (s.outlineColor) {
      ctx.save();
      ctx.shadowBlur =0; /* perf: no per-frame blur */
      ctx.shadowOffsetY = 0;
      traceBodyPath();
      ctx.strokeStyle = s.outlineColor;
      ctx.lineWidth = 1.8;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
    }

    // 4) Ears, face features & eyes in head-space
    ctx.save();
    ctx.translate(hcx, hcy);
    ctx.rotate(this.headTilt);

    const nowEar = performance.now();
    const earAct = this.idleAct;
    const earActU = earAct && earAct.kind === 'ear' ? Math.max(0, Math.min(1, (nowEar - earAct.t0) / earAct.dur)) : 0;
    const lFlick = earAct && earAct.kind === 'ear' && earAct.side === -1 ? Math.sin(earActU * Math.PI * 3) * 0.24 * (1 - earActU) : 0;
    const rFlick = earAct && earAct.kind === 'ear' && earAct.side === 1 ? Math.sin(earActU * Math.PI * 3) * 0.24 * (1 - earActU) : 0;
    const lTwitch = Math.sin(this.earTwitchLeft * Math.PI) * 0.12 + lFlick + this.groomEarPressLeft * 0.44;
    const rTwitch = Math.sin(this.earTwitchRight * Math.PI) * 0.12 + rFlick + this.groomEarPressRight * 0.44;
    const earPerk = this.earPerkSpring.x;
    const airplaneDrop = Math.max(0, -earPerk) * 11;
    const airplaneSpread = Math.max(0, -earPerk) * 6;

    const earShape = contour.earShape;
    const earScale = contour.earScale;
    const earMountX =
      (33 * (0.45 + 0.55 * hwScale) +
        jawSq * 5.0 +
        (earShape === 'floppy' ? 6.5 : earShape === 'folded' ? 3.5 : 0)) *
      contour.earSpacing;
    const earMountY =
      -28 -
      jawSq * 2.5 -
      (isOval ? 3.5 : 0) +
      (earShape === 'floppy' ? 11.5 : earShape === 'folded' ? 5.5 : 0);

    const drawCustomEar = (sideSign: -1 | 1, twitch: number) => {
      ctx.save();
      ctx.translate(sideSign * (earMountX + airplaneSpread) + this.faceTurnX * 0.18, earMountY + airplaneDrop);
      const baseEarRot =
        earShape === 'wide' ? 0.28 : earShape === 'folded' ? 0.34 : earShape === 'floppy' ? 0.14 : 0.08;
      ctx.rotate(sideSign * (baseEarRot + contour.earTilt - earPerk + twitch));
      ctx.scale(earScale, earScale);

      const earPath = (strokeOnly = false) => {
        ctx.beginPath();
        if (earShape === 'round') {
          // Tiger / bear / panda rounded semicircular ear
          const r = 17.5;
          ctx.arc(sideSign * 1, -2, r, Math.PI * 0.92, Math.PI * 2.08);
          if (!strokeOnly) ctx.closePath();
        } else if (earShape === 'tall') {
          // Fox / bunny / corgi tall alert pointed ear
          ctx.moveTo(sideSign * 16, 18);
          ctx.bezierCurveTo(sideSign * 18, -12, sideSign * 11, -38, sideSign * 2, -37);
          ctx.bezierCurveTo(sideSign * -8, -34, sideSign * -15, -14, sideSign * -17, 10);
          if (!strokeOnly) ctx.closePath();
        } else if (earShape === 'small') {
          // Compact low-profile ear (Tibetan fox / sea otter)
          ctx.moveTo(sideSign * 14, 12);
          ctx.bezierCurveTo(sideSign * 14, -4, sideSign * 9, -15, sideSign * 2, -14);
          ctx.bezierCurveTo(sideSign * -6, -13, sideSign * -12, -3, sideSign * -14, 8);
          if (!strokeOnly) ctx.closePath();
        } else if (earShape === 'wide') {
          // Flared wide fennec / caracal ear
          ctx.moveTo(sideSign * 24, 20);
          ctx.bezierCurveTo(sideSign * 28, -8, sideSign * 20, -28, sideSign * 7, -27);
          ctx.bezierCurveTo(sideSign * -8, -23, sideSign * -18, -8, sideSign * -22, 10);
          if (!strokeOnly) ctx.closePath();
        } else if (earShape === 'folded') {
          // Scottish Fold cute downward-bent rounded ear cap
          ctx.moveTo(sideSign * -15, 7);
          ctx.bezierCurveTo(sideSign * -12, -8, sideSign * 2, -15, sideSign * 14, -6);
          ctx.bezierCurveTo(sideSign * 23, 1, sideSign * 24, 15, sideSign * 13, 19);
          ctx.bezierCurveTo(sideSign * 4, 21, sideSign * -7, 15, sideSign * -15, 7);
          if (!strokeOnly) ctx.closePath();
        } else if (earShape === 'floppy') {
          // Puppy / lop-bunny soft plush drooping side ear
          ctx.moveTo(sideSign * -10, -4);
          ctx.bezierCurveTo(sideSign * 2, -12, sideSign * 16, -6, sideSign * 20, 10);
          ctx.bezierCurveTo(sideSign * 25, 29, sideSign * 18, 46, sideSign * 7, 45);
          ctx.bezierCurveTo(sideSign * -5, 44, sideSign * -12, 26, sideSign * -11, 8);
          if (!strokeOnly) ctx.closePath();
        } else {
          ctx.moveTo(sideSign * 19, strokeOnly ? 17 : 20);
          ctx.bezierCurveTo(sideSign * 19, -8, sideSign * 12, -23, sideSign * 3, -21);
          ctx.bezierCurveTo(sideSign * -8, -18, sideSign * -16, -6, sideSign * (strokeOnly ? -19 : -21), strokeOnly ? 5 : 8);
          if (!strokeOnly) ctx.closePath();
        }
      };

      const baseEarCol =
        s.pattern === 'calico' && sideSign === -1
          ? s.maskColor || s.earOuterColor
          : s.earOuterColor;
      const earGrad = ctx.createLinearGradient(
        0,
        earShape === 'tall' ? -37 : earShape === 'floppy' ? -10 : -23,
        0,
        earShape === 'floppy' ? 46 : 18,
      );
      earGrad.addColorStop(0.0, s.earTipColor || baseEarCol);
      earGrad.addColorStop(1.0, baseEarCol);
      ctx.fillStyle = earGrad;
      earPath(false);
      ctx.fill();

      ctx.shadowBlur =0; /* perf: no per-frame blur */
      ctx.shadowOffsetY = 0;

      if (s.outlineColor) {
        ctx.strokeStyle = s.outlineColor;
        ctx.lineWidth = 1.85 / Math.max(0.7, earScale);
        ctx.lineCap = 'round';
        earPath(true);
        ctx.stroke();
      }

      if (earShape === 'folded') {
        // Subtle fold crease shadow so folded ear reads unmistakably as bent forward
        ctx.strokeStyle = s.outlineColor || 'rgba(0, 0, 0, 0.24)';
        ctx.lineWidth = 1.4 / Math.max(0.7, earScale);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(sideSign * -8, 1);
        ctx.quadraticCurveTo(sideSign * 4, -3, sideSign * 14, 5);
        ctx.stroke();
      } else if (s.earInnerColor) {
        ctx.fillStyle = s.earInnerColor;
        ctx.beginPath();
        if (earShape === 'round') {
          ctx.arc(sideSign * 1, -1, 10.2, Math.PI * 0.95, Math.PI * 2.05);
        } else if (earShape === 'tall') {
          ctx.moveTo(sideSign * 9, 9);
          ctx.bezierCurveTo(sideSign * 10, -8, sideSign * 6, -24, sideSign * 1.5, -23);
          ctx.bezierCurveTo(sideSign * -4, -20, sideSign * -8, -6, sideSign * -9, 7);
        } else if (earShape === 'small') {
          ctx.moveTo(sideSign * 8, 6);
          ctx.bezierCurveTo(sideSign * 8, -2, sideSign * 5, -9, sideSign * 1, -8);
          ctx.bezierCurveTo(sideSign * -3, -7, sideSign * -7, -1, sideSign * -7, 5);
        } else if (earShape === 'floppy') {
          ctx.ellipse(sideSign * 4, 22, 6.2, 13.5, sideSign * -0.1, 0, Math.PI * 2);
        } else {
          ctx.moveTo(sideSign * 11, 10);
          ctx.bezierCurveTo(sideSign * 11, -3, sideSign * 7, -13, sideSign * 2, -11);
          ctx.bezierCurveTo(sideSign * -4, -9, sideSign * -9, -1, sideSign * -10, 8);
        }
        ctx.closePath();
        ctx.fill();
      }

      if (s.earTuftColor && earShape !== 'folded' && earShape !== 'floppy') {
        ctx.strokeStyle = s.earTuftColor;
        ctx.lineWidth = 1.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(sideSign * -6, 6);
        ctx.quadraticCurveTo(sideSign * -1, 3, sideSign * 5, 6);
        ctx.moveTo(sideSign * -3, 10);
        ctx.quadraticCurveTo(sideSign * 2, 7.5, sideSign * 7, 10);
        ctx.stroke();
      }
      ctx.restore();
    };

    this.drawHeadphonesBack(ctx);
    drawCustomEar(-1, lTwitch);
    drawCustomEar(1, rTwitch);

    ctx.shadowBlur =0; /* perf: no per-frame blur */
    ctx.shadowOffsetY = 0;
    const wShift = this.faceTurnX * 0.72;

    // Blush on petting / chin scratch / kneading (or permanent soft blush when blushAlways is true)
    const blushFloor = contour.blushAlways ? 0.62 : 0;
    const customBlushAmt = Math.max(blushFloor, this.squintAmount, this.chinAmount * 1.15, this.kneadAmount * 0.85);
    const blushX = 30 * (0.55 + 0.45 * contour.eyeSpacing);
    const blushY = 13 + contour.eyeOffsetY * 6.0;
    const bScale = contour.blushScale;
    if (s.blushColor && customBlushAmt > 0.12) {
      ctx.save();
      ctx.globalAlpha = 0.42 * Math.min(1.15, customBlushAmt);
      ctx.fillStyle = s.blushColor;
      ctx.beginPath();
      ctx.ellipse(wShift - blushX, blushY, 8.5 * bScale, 4.6 * bScale, -0.08, 0, Math.PI * 2);
      ctx.ellipse(wShift + blushX, blushY, 8.5 * bScale, 4.6 * bScale, 0.08, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (this.chinAmount > 0.2 || contour.blushAlways) {
      ctx.save();
      ctx.globalAlpha = Math.max(contour.blushAlways ? 0.28 : 0, 0.24 * this.chinAmount);
      ctx.fillStyle = '#ffa8ba';
      ctx.beginPath();
      ctx.ellipse(wShift - blushX, blushY + 1, 7.5 * bScale, 4.0 * bScale, -0.08, 0, Math.PI * 2);
      ctx.ellipse(wShift + blushX, blushY + 1, 7.5 * bScale, 4.0 * bScale, 0.08, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Nose (supports cat / round / wide / small / none + noseScale + noseOffsetY)
    const customNoseWiggleY = -1.4 * this.boopCrossEye - 1.3 * this.yawnAmount;
    const noseBaseY = 11.4 + contour.noseOffsetY * 7.0 + customNoseWiggleY;
    const nScale = contour.noseScale;
    if (s.noseColor && contour.noseShape !== 'none') {
      ctx.save();
      ctx.translate(wShift, noseBaseY);
      ctx.scale(nScale, nScale);
      ctx.fillStyle = s.noseColor;
      ctx.beginPath();
      if (contour.noseShape === 'round') {
        ctx.ellipse(0, 0, 4.3, 3.3, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.32)';
        ctx.beginPath();
        ctx.ellipse(-1.2, -1.0, 1.3, 0.8, -0.2, 0, Math.PI * 2);
        ctx.fill();
      } else if (contour.noseShape === 'wide') {
        ctx.moveTo(-6.2, -1.8);
        ctx.quadraticCurveTo(0, -3.2, 6.2, -1.8);
        ctx.quadraticCurveTo(5.2, 2.8, 0, 3.4);
        ctx.quadraticCurveTo(-5.2, 2.8, -6.2, -1.8);
        ctx.closePath();
        ctx.fill();
      } else if (contour.noseShape === 'small') {
        ctx.ellipse(0, 0, 2.6, 2.0, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.moveTo(-4.1, -1.8);
        ctx.quadraticCurveTo(0, -2.9, 4.1, -1.8);
        ctx.quadraticCurveTo(3.2, 2.4, 0, 2.9);
        ctx.quadraticCurveTo(-3.2, 2.4, -4.1, -1.8);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    // Mouth (supports w / smile / flat / open / blep / none + mouthScale + mouthOffsetY)
    const mouthBaseY = 16.6 + contour.mouthOffsetY * 7.0;
    const mScale = contour.mouthScale;
    if (s.mouthColor && contour.mouthShape !== 'none' && this.yawnAmount < 0.25) {
      ctx.save();
      ctx.globalAlpha = 1 - this.yawnAmount / 0.25;
      ctx.translate(wShift, mouthBaseY);
      ctx.scale(mScale, mScale);
      ctx.strokeStyle = s.mouthColor;
      ctx.lineWidth = 1.35 / Math.max(0.75, Math.sqrt(mScale));
      ctx.lineCap = 'round';
      if (contour.mouthShape === 'smile') {
        ctx.beginPath();
        ctx.moveTo(-6.2, -0.5);
        ctx.quadraticCurveTo(0, 4.6, 6.2, -0.5);
        ctx.stroke();
      } else if (contour.mouthShape === 'flat') {
        ctx.beginPath();
        ctx.moveTo(-5.8, 0.6);
        ctx.quadraticCurveTo(0, 0.2, 5.8, 0.6);
        ctx.stroke();
      } else if (contour.mouthShape === 'open') {
        ctx.fillStyle = '#c85b6f';
        ctx.beginPath();
        ctx.ellipse(0, 1.5, 3.2, 3.8, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else {
        // Classic 'w' or 'blep' (blep adds adorable tiny pink sticking-out tongue below center!)
        if (contour.mouthShape === 'blep') {
          ctx.fillStyle = '#f489a0';
          ctx.beginPath();
          ctx.moveTo(-2.7, 0.6);
          ctx.bezierCurveTo(-3.0, 5.6, 3.0, 5.6, 2.7, 0.6);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = '#d4667e';
          ctx.lineWidth = 0.9;
          ctx.stroke();
          ctx.strokeStyle = s.mouthColor;
          ctx.lineWidth = 1.35 / Math.max(0.75, Math.sqrt(mScale));
        }
        ctx.beginPath();
        ctx.moveTo(-5.8, 0.0);
        ctx.quadraticCurveTo(-2.9, 3.0, 0, -0.2);
        ctx.quadraticCurveTo(2.9, 3.0, 5.8, 0.0);
        ctx.stroke();
      }
      ctx.restore();
    }
    this.drawYawnOrLickMouth(ctx, wShift, s.mouthColor || s.outlineColor || '#3a232b');

    // Whiskers (whiskerLength = 0 cleanly hides whiskers for non-cat animals!)
    if (contour.whiskerLength > 0.01) {
      const whiskerAnchorX = 34 * (0.55 + 0.45 * hwScale);
      ctx.strokeStyle = s.whiskerColor;
      ctx.lineWidth = 1.1;
      ctx.lineCap = 'round';
      const leftLen = Math.max(8, 12 - this.faceTurnX * 0.55) * contour.whiskerLength;
      const rightLen = Math.max(8, 12 + this.faceTurnX * 0.55) * contour.whiskerLength;
      for (let i = 0; i < 3; i++) {
        const wy = 16 + i * 5.0;
        const slant = (2.0 + i * 1.1) * Math.min(1.25, contour.whiskerLength);
        ctx.beginPath();
        ctx.moveTo(-whiskerAnchorX + wShift, wy);
        ctx.lineTo(-whiskerAnchorX + wShift - leftLen, wy + slant);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(whiskerAnchorX + wShift, wy);
        ctx.lineTo(whiskerAnchorX + wShift + rightLen, wy + slant);
        ctx.stroke();
      }
    }

    this.drawCustomEyes(ctx, s, wShift, -1 + contour.eyeOffsetY * 11.0);
    this.drawHeadphonesFront(ctx);

    ctx.restore();
    ctx.restore();
  }

  private drawCustomEyes(ctx: CanvasRenderingContext2D, s: ResolvedSkin, cx: number, eyeY: number): void {
    const nowEye = performance.now();
    const slowBlinkVal =
      this.idleAct && this.idleAct.kind === 'slowBlink'
        ? 0.92 * Math.sin(Math.max(0, Math.min(1, (nowEye - this.idleAct.t0) / this.idleAct.dur)) * Math.PI)
        : 0;
    const blinkVal = Math.max(this.isBlinking ? 1 - Math.abs(this.blinkProgress - 1) : 0, slowBlinkVal);
    const yawnClose = Math.min(1, this.yawnAmount * 1.45);
    const stretchClose = Math.min(1, this.stretchAmount * 1.25);
    const groomClose = Math.min(0.85, this.groomAmount * 0.95);
    const closedness = Math.max(
      blinkVal,
      this.squintAmount * 0.85,
      this.privacyClose,
      this.sleepAmount,
      this.dozeLidClose,
      yawnClose,
      stretchClose,
      groomClose,
    );
    const curious = Math.min(1, this.curiousAmount);
    const scruff = Math.min(1, this.scruffAmount);
    const cross = this.crossAmount;
    const contour = s.contour;
    const eScale = contour.eyeScale;
    const eAspect = contour.eyeAspect;
    const eyeXs = [cx - 23.0 * contour.eyeSpacing, cx + 23.0 * contour.eyeSpacing];
    const rx = (14.8 * eScale + this.typingHunch * 1.0) * (1 + curious * 0.06 + scruff * 0.09);
    const ry = (13.4 * eScale * eAspect - this.typingHunch * 0.5) * (1 + curious * 0.09 + scruff * 0.13);

    for (let idx = 0; idx < 2; idx++) {
      const side: -1 | 1 = idx === 0 ? -1 : 1;
      ctx.save();
      ctx.translate(eyeXs[idx], eyeY);

      if (this.privacyClose > 0.45 || this.sleepAmount > 0.52) {
        ctx.strokeStyle = s.squintColor;
        ctx.lineWidth = 2.9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-13.5 * eScale, -0.5);
        ctx.quadraticCurveTo(0, 5.2 * eScale, 13.5 * eScale, -0.5);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      if (yawnClose > 0.48 || stretchClose > 0.52 || (this.chinAmount > 0.36 && blinkVal < 0.3)) {
        ctx.strokeStyle = s.squintColor;
        ctx.lineWidth = 2.9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-12.5 * eScale, 2.2);
        ctx.quadraticCurveTo(0, -4.8 * eScale, 12.5 * eScale, 2.2);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      if ((this.squintAmount > 0.38 || groomClose > 0.48) && blinkVal < 0.3) {
        if (s.squintGlowColor) {
          ctx.strokeStyle = s.squintGlowColor;
          ctx.lineWidth = 4.4;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(-12.5 * eScale, 0.2);
          ctx.quadraticCurveTo(0, 2.2 * eScale, 12.5 * eScale, 1.8);
          ctx.stroke();
        }
        ctx.strokeStyle = s.squintColor;
        ctx.lineWidth = 2.8;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-13.5 * eScale, -0.5);
        ctx.quadraticCurveTo(0, 1.4 * eScale, 13.5 * eScale, 1.2);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      const openRy = Math.max(1.2, ry * (1 - closedness));
      const curiousTilt = (idx === 0 ? -0.1 : 0.1) * (0.25 + this.typingHunch * 0.75) * (1 - scruff * 0.8);
      ctx.rotate(curiousTilt - side * contour.eyeTilt);

      const restSquint = contour.eyeSquint;
      const lidEff = Math.max(cross, this.tailGlanceAmount * 0.45);
      const hasLid = lidEff > 0.04 || restSquint > 0.02;
      const restDrop = -openRy + openRy * 1.12 * restSquint;
      const innerDrop = Math.max(restDrop, -openRy + openRy * 0.90 * lidEff);
      const outerDrop = Math.max(restDrop, -openRy + openRy * 0.56 * lidEff);
      const leftDrop = idx === 0 ? outerDrop : innerDrop;
      const rightDrop = idx === 0 ? innerDrop : outerDrop;

      // Clip the eye cleanly below the upper eyelid (grumpy anger or Tibetan-fox half-lidded restSquint)
      ctx.save();
      if (hasLid) {
        ctx.beginPath();
        ctx.moveTo(-rx - 4, leftDrop);
        ctx.lineTo(rx + 4, rightDrop);
        ctx.lineTo(rx + 4, openRy + 4);
        ctx.lineTo(-rx - 4, openRy + 4);
        ctx.closePath();
        ctx.clip();
      }

      const eyeTopCol = idx === 1 ? s.rightEyeColorTop : s.eyeColorTop;
      const eyeBotCol = idx === 1 ? s.rightEyeColorBottom : s.eyeColorBottom;
      const irisGrad = ctx.createLinearGradient(0, -openRy, 0, openRy);
      irisGrad.addColorStop(0.0, eyeTopCol);
      irisGrad.addColorStop(1.0, eyeBotCol);
      ctx.fillStyle = irisGrad;
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, openRy, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.clip();
      if (openRy > 3.2) {
        const boopShrink = 1 - this.boopCrossEye * 0.22;
        const pMul = contour.pupilScale * eScale;
        const pShape = contour.pupilShape;
        let pupilRx: number;
        let pupilRy: number;
        if (pShape === 'round') {
          const rP = (7.4 + curious * 3.4 + scruff * 2.8 + this.typingEnergy * 0.6) * pMul * (1 - cross * 0.24) * boopShrink;
          pupilRx = Math.min(rx - 2.2, rP);
          pupilRy = Math.min(openRy - 1.4, rP);
        } else if (pShape === 'slit') {
          pupilRx = Math.min(
            rx - 2.4,
            (2.8 + curious * 4.6 + scruff * 3.8 + this.typingEnergy * 0.4) * pMul * (1 - cross * 0.35) * boopShrink,
          );
          pupilRy = Math.min(
            openRy - 1.0,
            (9.8 + curious * 1.4 + scruff * 1.6) * pMul * eAspect * boopShrink,
          );
        } else if (pShape === 'dot') {
          const rDot = (4.0 + curious * 1.8 + scruff * 1.6) * pMul * boopShrink;
          pupilRx = Math.min(rx - 2.4, rDot);
          pupilRy = Math.min(openRy - 1.4, rDot);
        } else {
          pupilRx = Math.min(
            rx - 2.4,
            (6.2 + curious * 4.2 + scruff * 3.4 + this.typingEnergy * 0.8) * pMul * (1 - cross * 0.34) * boopShrink,
          );
          pupilRy = Math.min(
            openRy - 1.4,
            (8.8 + curious * 1.9 + scruff * 2.2) * pMul * eAspect * (1 - cross * 0.08) * boopShrink,
          );
        }
        const maxTravelX = Math.max(2.0, rx - pupilRx - 1.0);
        const maxTravelY = Math.max(1.8, openRy - pupilRy - 0.6);
        const crossEyeDir = idx === 0 ? 1 : -1;
        const gazeXEff =
          this.eyeLookX * (1 - this.boopCrossEye) + crossEyeDir * 0.94 * this.boopCrossEye;
        const gazeYEff =
          this.eyeLookY * (1 - this.boopCrossEye) + 0.42 * this.boopCrossEye;
        const px = Math.max(-maxTravelX, Math.min(maxTravelX, gazeXEff * maxTravelX));
        const py = Math.max(-maxTravelY, Math.min(maxTravelY, gazeYEff * maxTravelY));
        ctx.fillStyle = s.pupilColor;
        ctx.beginPath();
        if (pShape === 'slit') {
          ctx.moveTo(px, py - pupilRy);
          ctx.quadraticCurveTo(px + pupilRx * 1.35, py, px, py + pupilRy);
          ctx.quadraticCurveTo(px - pupilRx * 1.35, py, px, py - pupilRy);
          ctx.closePath();
        } else {
          ctx.ellipse(px, py, pupilRx, pupilRy, 0, 0, Math.PI * 2);
        }
        ctx.fill();

        if (pShape === 'star') {
          const sr = Math.max(2.6, Math.min(pupilRx, pupilRy) * 0.82);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
          ctx.beginPath();
          for (let k = 0; k < 8; k++) {
            const ang = (k / 8) * Math.PI * 2 - Math.PI / 2;
            const rad = k % 2 === 0 ? sr : sr * 0.32;
            const sx = px + Math.cos(ang) * rad;
            const sy = py + Math.sin(ang) * rad;
            if (k === 0) ctx.moveTo(sx, sy);
            else ctx.lineTo(sx, sy);
          }
          ctx.closePath();
          ctx.fill();
        }

        const sparkleBoost = Math.max(curious, scruff * 0.75, this.boopCrossEye * 0.65);
        if (s.eyeCatchlight || sparkleBoost > 0.25) {
          const ca = s.eyeCatchlight ? 0.94 : Math.min(0.92, sparkleBoost * 0.95);
          ctx.fillStyle = `rgba(255, 255, 255, ${ca.toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(
            px - (3.6 + sparkleBoost * 0.8) * eScale,
            py - (4.0 + sparkleBoost * 0.5) * eScale,
            (2.5 + sparkleBoost * 0.7) * Math.max(0.7, eScale),
            0,
            Math.PI * 2,
          );
          ctx.fill();
          ctx.fillStyle = `rgba(255, 255, 255, ${(ca * 0.76).toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(px + 3.2 * eScale, py + 3.2 * eScale, (1.2 + sparkleBoost * 0.4) * Math.max(0.7, eScale), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();

      if (s.eyeRimColor && openRy > 2.2) {
        ctx.strokeStyle = s.eyeRimColor;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, openRy, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore(); // end grumpy eyelid clip

      if (hasLid && openRy > 2.2) {
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(0, 0, rx + 0.9, openRy + 0.9, 0, 0, Math.PI * 2);
        ctx.clip();
        ctx.strokeStyle = s.eyeRimColor || s.outlineColor || '#262426';
        ctx.lineWidth = 1.9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-rx - 2, leftDrop);
        ctx.lineTo(rx + 2, rightDrop);
        ctx.stroke();
        ctx.restore();
      }

      ctx.restore();

      // Optional sculpted eyebrows (soft / thick Shiba dots / angry / worried)
      if (contour.eyebrowStyle !== 'none') {
        ctx.save();
        const browY = eyeY - ry - 5.5;
        ctx.translate(eyeXs[idx], browY);
        ctx.fillStyle = s.eyebrowColor;
        ctx.strokeStyle = s.eyebrowColor;
        ctx.lineCap = 'round';
        if (contour.eyebrowStyle === 'thick') {
          ctx.beginPath();
          ctx.ellipse(side * -1.5, 0, 5.4 * eScale, 3.3 * eScale, side * -0.18, 0, Math.PI * 2);
          ctx.fill();
        } else if (contour.eyebrowStyle === 'angry') {
          ctx.lineWidth = 2.6;
          ctx.beginPath();
          ctx.moveTo(side * -9.5 * eScale, 2.8);
          ctx.lineTo(side * 9.5 * eScale, -3.0);
          ctx.stroke();
        } else if (contour.eyebrowStyle === 'worried') {
          ctx.lineWidth = 2.3;
          ctx.beginPath();
          ctx.moveTo(side * -9.0 * eScale, -2.6);
          ctx.quadraticCurveTo(0, -1.0, side * 9.5 * eScale, 2.8);
          ctx.stroke();
        } else {
          ctx.lineWidth = 2.0;
          ctx.beginPath();
          ctx.moveTo(side * -9.5 * eScale, 1.2);
          ctx.quadraticCurveTo(0, -3.4, side * 9.5 * eScale, 1.4);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }

  private drawCustomPlumpArm(
    ctx: CanvasRenderingContext2D,
    s: ResolvedSkin,
    side: 'left' | 'right',
    sx: number,
    sy: number,
    px: number,
    py: number,
    squash: number,
    withCrease: boolean,
    isSmear = false,
  ): void {
    // Keep dark-coat tuxedo shoulders cleanly outside the white chest bib
    if (s.isDarkBase && s.bellyBibColor) {
      sx += side === 'left' ? -5 : 5;
    }

    const dx = px - sx;
    const dy = py - sy;
    const len = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    const wristDist = Math.max(6, len - 8);
    const wx = sx + ux * wristDist;
    const wy = sy + uy * wristDist;
    const rShoulder = s.isDarkBase && s.bellyBibColor ? 13.8 : 15.2;
    const rWrist = 10.8;
    const pawRx = 14.8 * (1 + squash * 0.14);
    const pawRy = 12.0 * (1 - squash * 0.12);

    // Subtle organic plush kitten-arm bow (eliminates stiff straight-stick look!)
    const bowSide = side === 'left' ? -1 : 1;
    const bowAmp = Math.min(7.5, len * 0.052);
    const midX = (sx + wx) * 0.5 + bowSide * bowAmp * Math.abs(uy);
    const midY = (sy + wy) * 0.5 + bowAmp * 0.45 * Math.abs(ux);

    ctx.save();
    const traceArmPath = () => {
      ctx.beginPath();
      ctx.moveTo(sx + nx * rShoulder, sy + ny * rShoulder);
      ctx.quadraticCurveTo(
        midX + nx * (rShoulder * 0.86),
        midY + ny * (rShoulder * 0.86),
        wx + nx * rWrist,
        wy + ny * rWrist,
      );
      ctx.lineTo(wx - nx * rWrist, wy - ny * rWrist);
      ctx.quadraticCurveTo(
        midX - nx * (rShoulder * 0.86),
        midY - ny * (rShoulder * 0.86),
        sx - nx * rShoulder,
        sy - ny * rShoulder,
      );
      ctx.closePath();
    };

    // Match the true rendered flank coat tone (toasted beige on Siamese; orange/charcoal flank patches on Calico!)
    const calicoPatchTone =
      s.pattern === 'calico'
        ? side === 'left'
          ? (s.maskColor || '#ea9446')
          : (s.calicoPatchColor || '#3c3634')
        : null;
    const flankTone = calicoPatchTone
      ? calicoPatchTone
      : s.flankColor
        ? blendHex(s.furSecondaryColor, s.flankColor, 0.45)
        : s.furColor;
    const contrastingArm = s.armColor.toLowerCase() !== s.furColor.toLowerCase();
    const armGrad = ctx.createLinearGradient(sx, sy, px, py);
    if (isSmear) {
      // Soft motion trail ONLY behind moving lower forearm & paw — never a ghost stick on the chest!
      armGrad.addColorStop(0.0, colorWithAlpha(s.armColor, 0.0));
      armGrad.addColorStop(0.45, colorWithAlpha(s.armColor, 0.0));
      armGrad.addColorStop(0.75, colorWithAlpha(s.armColor, 0.56));
      armGrad.addColorStop(1.0, colorWithAlpha(s.pawColor, 0.84));
    } else if (calicoPatchTone) {
      // Calico: upper shoulder flows seamlessly out of the side patch (orange left / charcoal right) into cute white kitten mittens!
      armGrad.addColorStop(0.0, colorWithAlpha(calicoPatchTone, 0.0));
      armGrad.addColorStop(0.09, colorWithAlpha(calicoPatchTone, 1.0));
      armGrad.addColorStop(0.28, colorWithAlpha(calicoPatchTone, 1.0));
      armGrad.addColorStop(0.46, colorWithAlpha(s.armColor, 1.0));
      armGrad.addColorStop(1.0, colorWithAlpha(s.armColor, 1.0));
    } else if (contrastingArm) {
      // Authentic colourpoint transition (e.g. Siamese): melts invisibly out of toasted flank into smooth espresso stockings & chocolate paws!
      const midMocha = blendHex(flankTone, s.armColor, 0.55);
      armGrad.addColorStop(0.0, colorWithAlpha(flankTone, 0.0));
      armGrad.addColorStop(0.11, colorWithAlpha(flankTone, 1.0));
      armGrad.addColorStop(0.24, colorWithAlpha(flankTone, 1.0));
      armGrad.addColorStop(0.56, colorWithAlpha(midMocha, 1.0));
      armGrad.addColorStop(0.84, colorWithAlpha(s.armColor, 1.0));
      armGrad.addColorStop(1.0, colorWithAlpha(s.pawColor, 1.0));
    } else if (s.isDarkBase) {
      // Dark-coat skins (e.g. Tuxedo): crisp clean shoulder on black flank without soft grey feathering onto white bib!
      armGrad.addColorStop(0.0, colorWithAlpha(s.armColor, 0.0));
      armGrad.addColorStop(0.04, colorWithAlpha(s.armColor, 1.0));
      armGrad.addColorStop(1.0, colorWithAlpha(s.armColor, 1.0));
    } else {
      // Same-coat light skins (Orange Tabby, solid): brisk seamless shoulder merge with ZERO body-outline bleed!
      armGrad.addColorStop(0.0, colorWithAlpha(s.armColor, 0.0));
      armGrad.addColorStop(0.10, colorWithAlpha(s.armColor, 1.0));
      armGrad.addColorStop(1.0, colorWithAlpha(s.armColor, 1.0));
    }

    ctx.fillStyle = armGrad;
    traceArmPath();
    ctx.fill();

    // Custom arm spots
    const armPart = side === 'left' ? 'leftArm' : 'rightArm';
    const armSpots = isSmear ? [] : s.spots.filter((sp) => sp.part === armPart);
    if (armSpots.length > 0 && len > 24) {
      const armAng = Math.atan2(dy, dx);
      ctx.save();
      traceArmPath();
      ctx.clip();
      for (const sp of armSpots) {
        const frac = Math.max(0.1, Math.min(0.9, sp.x));
        ctx.fillStyle = colorWithAlpha(sp.color, sp.opacity ?? 0.85);
        ctx.beginPath();
        ctx.ellipse(
          sx + ux * (len * frac) + nx * sp.y,
          sy + uy * (len * frac) + ny * sp.y,
          Math.max(2, sp.rx),
          Math.max(2, sp.ry),
          armAng + (sp.rotation || 0),
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.restore();
    }

    // Mitten paw ball
    ctx.save();
    if (!isSmear && !s.isDarkBase && !this.chromaKeyBg) {
      ctx.shadowColor = 'rgba(36, 32, 30, 0.22)';
      ctx.shadowBlur = 0; /* perf: no per-frame blur */
      ctx.shadowOffsetY = 1.5;
    }
    ctx.fillStyle = s.pawColor;
    ctx.beginPath();
    ctx.ellipse(px, py, pawRx, pawRy, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const edgeColor = s.pawOutlineColor || s.outlineColor;
    if (!isSmear && edgeColor) {
      ctx.lineWidth = 1.65;
      ctx.lineCap = 'round';
      const startFrac = withCrease ? 0.22 : 0.16;
      for (const sgn of [-1, 1]) {
        // Exact de Casteljau subdivision of bowed quadratic arm contour from startFrac..1.0
        const p0x = sx + nx * sgn * rShoulder;
        const p0y = sy + ny * sgn * rShoulder;
        const p1x = midX + nx * sgn * (rShoulder * 0.86);
        const p1y = midY + ny * sgn * (rShoulder * 0.86);
        const p2x = wx + nx * sgn * rWrist;
        const p2y = wy + ny * sgn * rWrist;

        const q0x = p0x + (p1x - p0x) * startFrac;
        const q0y = p0y + (p1y - p0y) * startFrac;
        const q1x = p1x + (p2x - p1x) * startFrac;
        const q1y = p1y + (p2y - p1y) * startFrac;
        const esx = q0x + (q1x - q0x) * startFrac;
        const esy = q0y + (q1y - q0y) * startFrac;

        const edgeGrad = ctx.createLinearGradient(esx, esy, p2x, p2y);
        edgeGrad.addColorStop(0.0, colorWithAlpha(edgeColor, 0.0));
        edgeGrad.addColorStop(0.28, colorWithAlpha(edgeColor, 0.74));
        edgeGrad.addColorStop(1.0, colorWithAlpha(edgeColor, 0.90));

        ctx.strokeStyle = edgeGrad;
        ctx.beginPath();
        ctx.moveTo(esx, esy);
        ctx.quadraticCurveTo(q1x, q1y, p2x, p2y);
        ctx.stroke();
      }
      const pawAng = Math.atan2(dy, dx);
      ctx.strokeStyle = colorWithAlpha(edgeColor, 0.92);
      ctx.beginPath();
      ctx.ellipse(px, py, pawRx, pawRy, 0, pawAng - Math.PI * 0.62, pawAng + Math.PI * 0.62);
      ctx.stroke();
    } else if (!isSmear && s.armCreaseColor && withCrease && len > 28) {
      for (const sgn of [-1, 1]) {
        const csx = sx + ux * (len * 0.20) + nx * sgn * (rShoulder * 0.86);
        const csy = sy + uy * (len * 0.20) + ny * sgn * (rShoulder * 0.86);
        const cex = sx + ux * (len * 0.78) + nx * sgn * (rWrist * 1.02);
        const cey = sy + uy * (len * 0.78) + ny * sgn * (rWrist * 1.02);
        const creaseGrad = ctx.createLinearGradient(csx, csy, cex, cey);
        creaseGrad.addColorStop(0.0, colorWithAlpha(s.armCreaseColor, 0.0));
        creaseGrad.addColorStop(0.26, colorWithAlpha(s.armCreaseColor, 0.85));
        creaseGrad.addColorStop(0.84, colorWithAlpha(s.armCreaseColor, 0.72));
        creaseGrad.addColorStop(1.0, colorWithAlpha(s.armCreaseColor, 0.0));
        ctx.strokeStyle = creaseGrad;
        ctx.lineWidth = 1.3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(csx, csy);
        ctx.lineTo(cex, cey);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  private drawCustomBentArm(
    ctx: CanvasRenderingContext2D,
    s: ResolvedSkin,
    paw: PawState,
    breath: number,
    alpha: number,
  ): void {
    const sh = this.getLiveShoulder(paw, breath);
    const cp = this.getLiveCurledPawPos(paw, breath);
    const sign = paw.side === 'left' ? -1 : 1;
    const elbowX = sh.x + sign * 8;
    const elbowY = cp.y + 8;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const calicoPatchTone =
      s.pattern === 'calico'
        ? paw.side === 'left'
          ? (s.maskColor || '#ea9446')
          : (s.calicoPatchColor || '#3c3634')
        : null;
    const flankTone = calicoPatchTone
      ? calicoPatchTone
      : s.flankColor
        ? blendHex(s.furSecondaryColor, s.flankColor, 0.45)
        : s.furColor;
    const contrastingArm = s.armColor.toLowerCase() !== s.furColor.toLowerCase();
    const bentGrad = ctx.createLinearGradient(sh.x, sh.y, cp.x, cp.y);
    if (calicoPatchTone) {
      bentGrad.addColorStop(0.0, colorWithAlpha(calicoPatchTone, 0.0));
      bentGrad.addColorStop(0.16, colorWithAlpha(calicoPatchTone, 1.0));
      bentGrad.addColorStop(0.45, colorWithAlpha(s.armColor, 1.0));
      bentGrad.addColorStop(1.0, colorWithAlpha(s.armColor, 1.0));
    } else if (contrastingArm) {
      const midMocha = blendHex(flankTone, s.armColor, 0.55);
      bentGrad.addColorStop(0.0, colorWithAlpha(flankTone, 0.0));
      bentGrad.addColorStop(0.18, colorWithAlpha(flankTone, 1.0));
      bentGrad.addColorStop(0.56, colorWithAlpha(midMocha, 1.0));
      bentGrad.addColorStop(0.86, colorWithAlpha(s.armColor, 1.0));
      bentGrad.addColorStop(1.0, colorWithAlpha(s.pawColor, 1.0));
    } else {
      bentGrad.addColorStop(0.0, colorWithAlpha(s.armColor, 0.0));
      bentGrad.addColorStop(0.16, colorWithAlpha(s.armColor, 1.0));
      bentGrad.addColorStop(1.0, colorWithAlpha(s.armColor, 1.0));
    }

    ctx.strokeStyle = bentGrad;
    ctx.lineWidth = 21;
    ctx.beginPath();
    ctx.moveTo(sh.x, sh.y);
    ctx.quadraticCurveTo(elbowX, elbowY, cp.x, cp.y);
    ctx.stroke();

    const armPart = paw.side === 'left' ? 'leftArm' : 'rightArm';
    for (const sp of s.spots) {
      if (sp.part !== armPart) continue;
      ctx.save();
      ctx.fillStyle = colorWithAlpha(sp.color, sp.opacity ?? 0.82);
      ctx.beginPath();
      ctx.ellipse((elbowX + cp.x) * 0.5, (elbowY + cp.y) * 0.5, Math.min(8, sp.rx), Math.min(6, sp.ry), -0.3 * sign, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.fillStyle = s.pawColor;
    ctx.beginPath();
    ctx.ellipse(cp.x, cp.y, 12.8, 11.2, sign * 0.2, 0, Math.PI * 2);
    ctx.fill();

    const outlineCol = s.pawOutlineColor || s.legLineColor;
    const outlineGrad = ctx.createLinearGradient(elbowX, elbowY - 12, cp.x, cp.y + 12);
    outlineGrad.addColorStop(0.0, colorWithAlpha(outlineCol, 0.0));
    outlineGrad.addColorStop(0.28, colorWithAlpha(outlineCol, 0.68));
    outlineGrad.addColorStop(0.86, colorWithAlpha(outlineCol, 0.78));
    outlineGrad.addColorStop(1.0, colorWithAlpha(outlineCol, 0.35));

    ctx.strokeStyle = outlineGrad;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(elbowX + sign * 8, elbowY - 16);
    ctx.quadraticCurveTo(elbowX + sign * 4, elbowY + 12, cp.x + sign * 2, cp.y + 10);
    ctx.quadraticCurveTo(cp.x - sign * 11, cp.y + 8, cp.x - sign * 12, cp.y - 4);
    ctx.stroke();
    ctx.restore();
  }

  private drawCustomIdleLegDetails(
    ctx: CanvasRenderingContext2D,
    s: ResolvedSkin,
    paw: PawState,
    topSp: Vec2,
    midSp: Vec2,
    botSp: Vec2,
    sign: -1 | 1,
    outerTopX: number,
    outerBotX: number,
    innerTopX: number,
    innerBotX: number,
  ): void {
    const armPart = paw.side === 'left' ? 'leftArm' : 'rightArm';
    for (const sp of s.spots) {
      if (sp.part !== armPart) continue;
      ctx.save();
      ctx.globalAlpha = sp.opacity ?? 0.82;
      ctx.fillStyle = sp.color;
      ctx.beginPath();
      ctx.ellipse(midSp.x + sign * 21, midSp.y + (sp.x - 0.5) * 28, Math.max(3, sp.rx * 0.8), Math.max(3, sp.ry * 1.1), 0.2 * sign, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Optional cute white mittens at the bottom of idle seated legs when pawColor differs from furColor!
    if (s.pawColor !== s.furColor) {
      ctx.save();
      ctx.fillStyle = s.pawColor;
      ctx.beginPath();
      ctx.ellipse(botSp.x + sign * 22, botSp.y - 4, 13.5, 9.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.strokeStyle = s.legLineColor;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(outerTopX, topSp.y);
    ctx.quadraticCurveTo(midSp.x + sign * 41, midSp.y, outerBotX, botSp.y - 1);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(innerTopX, topSp.y + 10);
    ctx.lineTo(innerBotX, botSp.y - 1);
    ctx.stroke();
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  private trapezoidPath(
    ctx: CanvasRenderingContext2D,
    topHalfW: number,
    botHalfW: number,
    topY: number,
    botY: number,
    r: number,
  ): void {
    ctx.beginPath();
    ctx.moveTo(-topHalfW + r, topY);
    ctx.lineTo(topHalfW - r, topY);
    ctx.quadraticCurveTo(topHalfW, topY, topHalfW + 1, topY + r);
    ctx.lineTo(botHalfW, botY - r);
    ctx.quadraticCurveTo(botHalfW, botY, botHalfW - r, botY);
    ctx.lineTo(-botHalfW + r, botY);
    ctx.quadraticCurveTo(-botHalfW, botY, -botHalfW, botY - r);
    ctx.lineTo(-topHalfW - 1, topY + r);
    ctx.quadraticCurveTo(-topHalfW, topY, -topHalfW + r, topY);
    ctx.closePath();
  }
}
