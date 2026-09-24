// Account server: accounts, billing, the cloud compute queue, hosted shares, Discord (CLAUDE.md D14, D15). Answers /api/v1/* only.
// NO SIMULATION HERE: sims run in the browser or on compute workers; this process only queues, meters and proxies.
// Credentials come from the process environment, never argv, logs or the webroot. Startup prints NAMES ONLY. Binds to loopback.
// Always run bundled (npm run account:build): the modules below are TypeScript with extensionless imports.

import { createServer } from 'node:http';
import { envReport, loadConfig } from './account/config';
import { connectDb } from './account/db';
import { connectRedis } from './account/redis';
import { migrate } from './account/migrate';
import { createR2 } from './account/r2';
import { createApp, TASKS } from './account/app';
import { errorSummary, nodeHandler } from './account/http';
import { startTasks } from './account/scheduler';

const log = (line) => console.log(line);

// Node's default crash print includes error properties such as ERR_INVALID_URL's `input`, which can be a DATABASE_URL with its password.
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (err) => {
    console.error(`FATAL: ${errorSummary(err)}`);
    process.exit(1);
  });
}

/** The client libraries parse their URL up front; report which variable is bad, never the value. */
function connect(name, open) {
  try {
    return open();
  } catch {
    console.error(`  FATAL: ${name} is not a valid URL`);
    process.exit(1);
  }
}

const config = loadConfig(process.env);
const { present, missing } = envReport(process.env);
log(`frostsim account server: features ${[...config.features].join(', ') || '(none)'}`);
log(`  env present: ${present.join(', ') || '(none)'} (names only, values never printed)`);
log(`  env missing: ${missing.join(', ') || '(none)'}`);
if (config.problems.length) {
  for (const problem of config.problems) console.error(`  FATAL: ${problem}`);
  process.exit(1);
}

// With every feature off the process is inert: no database, no cache, health only.
const active = config.features.size > 0;
const sql = active ? connect('DATABASE_URL', () => connectDb(config.env.DATABASE_URL)) : null;
const redis = active && config.env.REDIS_URL ? connect('REDIS_URL', () => connectRedis(config.env.REDIS_URL, log)) : null;
if (sql) {
  try {
    // Same relative path in dist-server/ and in the deploy stage: server/account/migrations/ beside this file's bundle.
    const applied = await migrate(sql, new URL('./account/migrations/', import.meta.url));
    log(`  migrations: ${applied.length ? `applied ${applied.join(', ')}` : 'up to date'}`);
  } catch (err) {
    console.error(`  FATAL: migrations failed (${errorSummary(err)})`);
    process.exit(1);
  }
}

const deps = { config, sql, redis, r2: createR2(config, fetch), fetch, now: () => new Date(), log };
const server = createServer(nodeHandler(config.publicOrigin, createApp(deps), log));
const stopTasks = sql ? startTasks(TASKS, { ...deps, sql }) : () => {};

server.listen(config.port, config.host, () => log(`frostsim account server on http://${config.host}:${config.port}`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopTasks();
    server.close(async () => {
      await sql?.end({ timeout: 5 });
      redis?.disconnect();
      process.exit(0);
    });
    // A hung upstream call must not hold the unit through a restart.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
