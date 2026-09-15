// Shared by boundary-test worker stubs; validate is independent reimplementation of public/engine/sim-worker.js checks so boundary tests fail if controller sends refused message.

export const PROTOCOL = 1

const ALLOWED_PATHS = ['/profile.simc', '/out.json', '/out.html']

export function validate(data) {
  if (!data || typeof data !== 'object') return 'message is not an object'
  if (data.protocol !== PROTOCOL) return `worker protocol ${data.protocol} does not match this worker (${PROTOCOL})`
  if (typeof data.jobId !== 'string' || !data.jobId) return 'jobId must be a non-empty string'
  if (typeof data.profile !== 'string' || !data.profile) return 'profile must be a non-empty string'
  if (!ALLOWED_PATHS.includes(data.profilePath)) return `profilePath ${data.profilePath} is not allowed`
  if (!ALLOWED_PATHS.includes(data.reportPath)) return `reportPath ${data.reportPath} is not allowed`
  if (data.profilePath === data.reportPath) return 'profilePath and reportPath must differ'
  if (data.htmlPath !== undefined) {
    if (!ALLOWED_PATHS.includes(data.htmlPath)) return `htmlPath ${data.htmlPath} is not allowed`
    if (data.htmlPath === data.profilePath || data.htmlPath === data.reportPath) {
      return 'htmlPath must differ from profilePath and reportPath'
    }
  }
  if (!Array.isArray(data.args) || data.args.length === 0) return 'args must be a non-empty array'
  for (const arg of data.args) {
    if (typeof arg !== 'string' || !arg.length) return 'every arg must be a non-empty string'
    if (/[\0\n\r]/.test(arg)) return 'an arg contains a control character'
  }
  if (data.args[0] !== data.profilePath) return 'args[0] must be the profile path'
  if (data.engine !== undefined) {
    if (typeof data.engine.wasmUrl !== 'string' || !data.engine.wasmUrl.endsWith('.wasm')) {
      return 'engine.wasmUrl must be a .wasm'
    }
    if (data.engine.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(data.engine.sha256)) {
      return 'engine.sha256 must be a hex sha-256'
    }
  }
  return null
}

/** Trimmed from real json=...,version=2 report. */
export const report = {
  version: '1210-01',
  report_version: '2.0.0',
  git_revision: 'c015720',
  sim: {
    options: {
      iterations: 53,
      target_error: 0,
      threads: 4,
      max_time: 300,
      fight_style: 'Patchwerk',
      desired_targets: 1,
      single_actor_batch: false,
      fixed_time: true,
      confidence: 0.95,
      confidence_estimator: 1.9599639854088815,
      dbc: { Live: { wow_version: '12.1.0.69814', build_level: 69814 }, version_used: 'Live' },
    },
    players: [
      {
        name: 'MID2_Mage_Frost_Spellslinger',
        specialization: 'Frost Mage',
        role: 'spell',
        collected_data: {
          dps: {
            sum: 10974712.66754416,
            count: 49,
            mean: 223973.7279090645,
            min: 207574.46,
            max: 241781.63,
            median: 223416.11,
            variance: 58281843.96,
            std_dev: 7634.25,
            mean_variance: 1189425.39,
            mean_std_dev: 1090.6078061865887,
          },
        },
      },
    ],
    statistics: { elapsed_time_seconds: 0.171585536 },
  },
}
