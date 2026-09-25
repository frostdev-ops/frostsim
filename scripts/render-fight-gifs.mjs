// Renders the pixel battle (src/lib/ui/pixel) as one looping GIF per hero look, for the Discord bot's progress embed
// (server/account/discord.ts). node scripts/render-fight-gifs.mjs -> public/discord/fight/<look>.gif. A party's GIF is
// rendered on request by the account server; both draw with server/account/fight-gif.ts.

import { mkdirSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const OUT = new URL('../public/discord/fight/', import.meta.url);

// The battle and its styles are TypeScript: bundle them in memory and import the result.
const bundled = await build({
  stdin: {
    contents: "export * from './server/account/fight-gif'; export { FIGHT_GIFS } from './src/lib/ui/pixel/style'",
    resolveDir: new URL('..', import.meta.url).pathname, loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'warning',
});
const { renderFightGif, FIGHT_GIFS } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

mkdirSync(OUT, { recursive: true });
for (const look of FIGHT_GIFS) {
  const gif = renderFightGif([look]);
  writeFileSync(new URL(`${look.name}.gif`, OUT), gif);
  console.log(`${look.name}.gif ${(gif.length / 1024).toFixed(0)} KB`);
}
