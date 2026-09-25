// Renders the pixel battle (src/lib/ui/pixel) as one looping GIF per hero look, for the Discord bot's progress embed
// (server/account/discord.ts). node scripts/render-fight-gifs.mjs -> public/discord/fight/<look>.gif. The battle draws only
// with fillRect, so a small RGBA canvas stands in for the browser's; frames are scaled up by whole pixels, because Discord
// smooths images it enlarges.

import { mkdirSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import gifenc from 'gifenc';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const SCALE = 3;
const FRAMES = 48; // 4 s at the battle's 12 steps a second
const BACKGROUND = [11, 16, 32]; // the app's night sky, so the GIF reads on Discord's light and dark themes alike
const OUT = new URL('../public/discord/fight/', import.meta.url);

// The battle and its styles are TypeScript: bundle them in memory and import the result.
const bundled = await build({
  stdin: { contents: "export * from './battle'; export * from './style'", resolveDir: new URL('../src/lib/ui/pixel/', import.meta.url).pathname, loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'warning',
});
const { Battle, W, H, FIGHT_GIFS, heroStyle, encounterFor } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

function parse(color) {
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
  const stack = [];
  const ctx = {
    get fillStyle() { return state.fillStyle; }, set fillStyle(v) { state.fillStyle = v; },
    get globalAlpha() { return state.globalAlpha; }, set globalAlpha(v) { state.globalAlpha = v; },
    save() { stack.push({ ...state }); },
    restore() { Object.assign(state, stack.pop()); },
    translate(x, y) { state.dx += x; state.dy += y; },
    clearRect() { for (let i = 0; i < W * H; i++) px.set(BACKGROUND, i * 3); },
    fillRect(x, y, w, h) {
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
  return { ctx, px };
}

/** One frame as scaled RGBA. */
function rgba(px) {
  const out = new Uint8Array(W * SCALE * H * SCALE * 4);
  for (let y = 0; y < H * SCALE; y++) for (let x = 0; x < W * SCALE; x++) {
    const s = (Math.floor(y / SCALE) * W + Math.floor(x / SCALE)) * 3, d = (y * W * SCALE + x) * 4;
    out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = 255;
  }
  return out;
}

mkdirSync(OUT, { recursive: true });
for (const look of FIGHT_GIFS) {
  // A mid-run look: the boss half down, the estimate settling, damage numbers at a typical raid DPS.
  const input = { speed: 2400, dps: 250_000, progress: 0.5, samples: Array.from({ length: 80 }, (_, i) => ({ mean: 250_000 + 9000 / (i + 1), err: 2 / Math.sqrt(i + 1) })) };
  const battle = new Battle(heroStyle(look.className, look.spec), encounterFor('Patchwerk', 1, 'quick'), input);
  for (let i = 0; i < 36; i++) battle.step();
  const { ctx, px } = canvas();
  const frames = [];
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
  writeFileSync(new URL(`${look.name}.gif`, OUT), gif.bytes());
  console.log(`${look.name}.gif ${(gif.bytes().length / 1024).toFixed(0)} KB`);
}
