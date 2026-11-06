/* THIS FILE WAS GENERATED AUTOMATICALLY BY PAYLOAD. MODIFY AT YOUR OWN RISK. */
import { payloadLayoutRoute } from '@payloadcms/tanstack-start/client'
import { createFileRoute } from '@tanstack/react-router'

import { getLayoutDataFn, serverFunctionHandler } from './_payload/server.functions.js'

export const Route = createFileRoute('/_payload')({
  // mission-control: no external font stylesheet. A render-blocking Google Fonts request
  // leaves the admin blank/spinning when fonts.googleapis.com is unreachable. Payload's CSS
  // falls back to the system sans-serif stack.
  ...payloadLayoutRoute({
    load: getLayoutDataFn,
    serverFunction: serverFunctionHandler,
  }),
})
