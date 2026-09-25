// The pixel battle (src/lib/ui/pixel) as a looping GIF for the Discord bot's progress embed: one per hero look, pre-rendered by
// scripts/render-fight-gifs.mjs, and a party's rendered on request (discord.ts, a multi-character /compare). The battle draws only
// with fillRect, so a small RGB canvas stands in for the browser's; frames are scaled up by whole pixels, because Discord smooths
// images it enlarges.
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { Battle, H, W } from '../../src/lib/ui/pixel/battle';
import { encounterFor, heroStyle } from '../../src/lib/ui/pixel/style';

const SCALE = 3;
const FRAMES = 48; // 4 s at the battle's 12 steps a second
const BACKGROUND = [11, 16, 32]; // the app's night sky, so the GIF reads on Discord's light and dark themes alike

function parse(color: string): [number, number, number, number] {
  let m = /^#([0-9a-f]{6})$/i.exec(color);
  if (m) { const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255, 1]; }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+))?\s*\)$/.exec(color);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  throw new Error(`unknown colour ${color}`);
}

/** The slice of CanvasRenderingContext2D the battle uses, over an RGB buffer on the background colour. */
function canvas() {
  const px = new Float64Array(W * H * 3);
  const state = { fillStyle: '#000000', globalAlpha: 1, dx: 0, dy: 0 };
  const stack: (typeof state)[] = [];
  const ctx = {
    get fillStyle() { return state.fillStyle; }, set fillStyle(v: string) { state.fillStyle = v; },
    get globalAlpha() { return state.globalAlpha; }, set globalAlpha(v: number) { state.globalAlpha = v; },
    save() { stack.push({ ...state }); },
    restore() { Object.assign(state, stack.pop()); },
    translate(x: number, y: number) { state.dx += x; state.dy += y; },
    clearRect() { for (let i = 0; i < W * H; i++) px.set(BACKGROUND, i * 3); },
    fillRect(x: number, y: number, w: number, h: number) {
      const [r, g, b, a0] = parse(state.fillStyle);
      const a = a0 * state.globalAlpha;
      const x0 = Math.max(0, Math.round(x + state.dx)), y0 = Math.max(0, Math.round(y + state.dy));
      const x1 = Math.min(W, Math.round(x + state.dx + w)), y1 = Math.min(H, Math.round(y + state.dy + h));
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * W + xx) * 3;
        px[i] += (r - px[i]) * a; px[i + 1] += (g - px[i + 1]) * a; px[i + 2] += (b - px[i + 2]) * a;
      }
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, px };
}

/** One frame as scaled RGBA. */
function rgba(px: Float64Array): Uint8Array {
  const out = new Uint8Array(W * SCALE * H * SCALE * 4);
  for (let y = 0; y < H * SCALE; y++) for (let x = 0; x < W * SCALE; x++) {
    const s = (Math.floor(y / SCALE) * W + Math.floor(x / SCALE)) * 3, d = (y * W * SCALE + x) * 4;
    out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = 255;
  }
  return out;
}

/** A looping GIF of these heroes fighting together, one per character. */
export function renderFightGif(heroes: readonly { className: string; spec?: string }[]): Uint8Array {
  // A mid-run look: the boss half down, the estimate settling, damage numbers at a typical raid DPS.
  const input = { speed: 2400, dps: 250_000, progress: 0.5, samples: Array.from({ length: 80 }, (_, i) => ({ mean: 250_000 + 9000 / (i + 1), err: 2 / Math.sqrt(i + 1) })) };
  const battle = new Battle(heroes.map((h) => heroStyle(h.className, h.spec)), encounterFor('Patchwerk', 1, 'quick'), input);
  for (let i = 0; i < 36; i++) battle.step();
  const { ctx, px } = canvas();
  const frames: Uint8Array[] = [];
  for (let f = 0; f < FRAMES; f++) {
    battle.step();
    battle.draw(ctx);
    frames.push(rgba(px));
  }
  // One palette from every fourth frame, shared by all, keeps colours steady from frame to frame.
  const some = frames.filter((_, i) => i % 4 === 0);
  const sample = new Uint8Array(some.length * some[0].length);
  some.forEach((fr, i) => sample.set(fr, i * fr.length));
  const palette = quantize(sample, 256);
  const gif = GIFEncoder();
  for (const fr of frames) gif.writeFrame(applyPalette(fr, palette), W * SCALE, H * SCALE, { palette, delay: 83, repeat: 0 });
  gif.finish();
  return gif.bytes();
}
