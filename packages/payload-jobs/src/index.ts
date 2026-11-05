import type { Config, Plugin } from 'payload'

export type PayloadJobsOptions = {
  /** Turn the plugin off without removing it from the config. Defaults to true. */
  enabled?: boolean
}

/**
 * Job board plugin for Mission Control. Collections, endpoints and jobs are added in later
 * tasks (PJ-15 onwards); for now it only registers itself so the wiring can be tested.
 */
export const payloadJobs =
  (options: PayloadJobsOptions = {}): Plugin =>
  (incoming: Config): Config => {
    if (options.enabled === false) return incoming

    return {
      ...incoming,
      custom: {
        ...incoming.custom,
        payloadJobs: { enabled: true },
      },
    }
  }
