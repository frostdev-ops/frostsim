// Catalog worker entry point. Bundled module worker unlike engine worker (D10); ESM form fine.

import { CATALOG_PROTOCOL_VERSION, handleRequest, newState, type CatalogRequest, type Envelope } from './protocol';

const state = newState();

self.onmessage = async (event: MessageEvent<Envelope<CatalogRequest>>) => {
  const { protocol, id, payload } = event.data ?? ({} as Envelope<CatalogRequest>);
  if (protocol !== CATALOG_PROTOCOL_VERSION) {
    self.postMessage({
      protocol: CATALOG_PROTOCOL_VERSION,
      id,
      payload: { ok: false, error: `unsupported catalog protocol ${protocol}; worker speaks ${CATALOG_PROTOCOL_VERSION}` },
    });
    return;
  }
  try {
    const response = await handleRequest(state, payload);
    self.postMessage({ protocol: CATALOG_PROTOCOL_VERSION, id, payload: { ok: true, response } });
  } catch (err) {
    self.postMessage({
      protocol: CATALOG_PROTOCOL_VERSION,
      id,
      payload: { ok: false, error: err instanceof Error ? err.message : String(err) },
    });
  }
};
