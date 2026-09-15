// Dies way worker with broken script does: uncaught error, one case DOM reports.
import { parentPort } from 'node:worker_threads'

parentPort.on('message', () => {
  throw new Error('/engine/simc.js did not define createSimc')
})
