// Public guides are regular documents, separate from the cross-origin-isolated simulator.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default function adsense() {
  return {
    name: 'frostsim-guide-ads',
    apply: 'build',
    closeBundle() {
      const guides = join(process.cwd(), 'dist/guides');
      if (!existsSync(guides)) return;
      for (const name of readdirSync(guides).filter((file) => file.endsWith('.html') && file !== 'index.html')) {
        const file = join(guides, name);
        const html = readFileSync(file, 'utf8');
        if (html.includes('/ads/display.js')) continue;
        writeFileSync(file, html.replace('</head>', '<link rel="stylesheet" href="/ads/display.css" />\n<script data-cfasync="false" defer nonce="__FROSTSIM_AD_NONCE__" src="/ads/display.js"></script>\n</head>')
          .replace('</footer>', ' <a href="/legal/privacy.html">Privacy policy</a>.</footer>'));
      }
    },
  };
}
