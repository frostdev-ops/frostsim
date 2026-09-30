import { readFileSync } from 'node:fs';

export function selectedChannel(argv = process.argv) {
  const i = argv.indexOf('--channel');
  const channel = i < 0 ? 'live' : argv[i + 1];
  if (!['live', 'ptr'].includes(channel)) throw Error('--channel must be live or ptr');
  return channel;
}

export function clientBuild(channel, root = 'vendor/simc/engine/dbc/generated') {
  const prefix = channel === 'ptr' ? 'PTR_' : '';
  const text = readFileSync(`${root}/client_data_version${channel === 'ptr' ? '_ptr' : ''}.inc`, 'utf8');
  const match = new RegExp(`#define\\s+${prefix}CLIENT_DATA_WOW_VERSION\\s+"([^"]+)"`).exec(text);
  if (!match) throw Error(`Missing ${channel} client build`);
  return match[1];
}

export const channelFile = (file, channel) => channel === 'ptr' ? file.replace(/\.inc$/, '_ptr.inc') : file;
export const channelDecl = (decl, channel) => channel === 'ptr' ? decl.replace(/^__/, '__ptr_') : decl;
