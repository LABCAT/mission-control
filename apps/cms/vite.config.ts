import { cloudflare } from '@cloudflare/vite-plugin'
import { withPayload } from '@payloadcms/tanstack-start'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import rsc from '@vitejs/plugin-rsc'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin, type UserConfig } from 'vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The Cloudflare plugin resolves Worker code with the `browser` condition, which maps
// `payload` to its client-safe `shared` export. Server environments resolve without it.
const serverConditionsWithoutBrowser: Plugin = {
  name: 'orbit:server-conditions-without-browser',
  enforce: 'post',
  configEnvironment(name, config) {
    if (name !== 'ssr' && name !== 'rsc') return
    const conditions = config.resolve?.conditions
    if (conditions) config.resolve!.conditions = conditions.filter((c) => c !== 'browser')
  },
}

function serverDefines(command: 'build' | 'serve'): Record<string, string> {
  return {
    // workerd's console.createTask throws ERR_METHOD_NOT_IMPLEMENTED, and React and the
    // RSC renderer call it whenever it exists.
    'console.createTask': 'undefined',
    // A bundled Worker has no import.meta.url, and payload/dist/index.js calls
    // fileURLToPath(import.meta.url) at load. Dev's module runner provides it.
    ...(command === 'build' ? { 'import.meta.url': JSON.stringify('file:///worker/index.js') } : {}),
  }
}

const payloadConfig = withPayload(
  ({ env, pluginOptions }) => ({
    plugins: [
      cloudflare({ viteEnvironment: { name: 'ssr', childEnvironments: ['rsc'] } }),
      serverConditionsWithoutBrowser,
      rsc(pluginOptions.rsc),
      tanstackStart(pluginOptions.tanstackStart),
      viteReact(pluginOptions.react),
    ],
    environments: {
      ssr: { define: serverDefines(env.command) },
      rsc: { define: serverDefines(env.command) },
    },
    resolve: {
      alias: {
        '@/': `${path.resolve(__dirname, 'src')}/`,
      },
    },
    server: {
      port: 8902,
      strictPort: true,
      warmup: {
        clientFiles: [
          './src/app/__root.tsx',
          './src/app/_payload.tsx',
          './src/app/_payload/admin.index.tsx',
          './src/app/_payload/admin.$.tsx',
        ],
      },
    },
  }),
  { payloadConfigPath: path.resolve(__dirname, 'src', 'payload.config.ts') },
)

// withPayload externalizes server packages so Node loads them from node_modules.
// A Worker has no node_modules at runtime, so the server environments bundle everything.
function bundleForWorkers(config: UserConfig): UserConfig {
  if (config.ssr) {
    delete config.ssr.external
    config.ssr.noExternal = true
  }
  for (const name of ['ssr', 'rsc']) {
    const env = config.environments?.[name]
    if (!env) continue
    if (env.resolve) {
      delete env.resolve.external
      env.resolve.noExternal = true
    }
    if (env.build?.rollupOptions) delete env.build.rollupOptions.external
  }
  return config
}

export default defineConfig((env) => bundleForWorkers(payloadConfig(env)))
