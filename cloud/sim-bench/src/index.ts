// P0 bench Worker: bearer-gated pass-through to a named standard-4 container instance.
import { Container, getContainer } from '@cloudflare/containers';

export class SimBench extends Container {
  defaultPort = 8080;
  sleepAfter = '1m';
  enableInternet = false;
}

interface Env { SIM: DurableObjectNamespace<SimBench>; BENCH_TOKEN: string }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.BENCH_TOKEN || request.headers.get('authorization') !== `Bearer ${env.BENCH_TOKEN}`) {
      return new Response('unauthorized', { status: 401 });
    }
    const url = new URL(request.url);
    const started = Date.now();
    const instance = getContainer(env.SIM, url.searchParams.get('id') ?? 'default');
    // An instance holds a max_instances slot until it sleeps; a finished job frees it at once.
    if (request.method === 'DELETE') {
      await instance.destroy();
      return new Response(null, { status: 204 });
    }
    const res = await instance.fetch(new Request(`http://container${url.pathname}`, request));
    const out = new Response(res.body, res);
    out.headers.set('x-worker-ms', String(Date.now() - started));
    return out;
  },
};
