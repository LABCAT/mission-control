/**
 * Declarations for the asset imports the Worker build understands.
 *
 * `?inline` hands back a data URI and `?module` a `WebAssembly.Module`. Vite resolves both; the
 * TypeScript language service needs to be told, since these are not real module paths.
 */
declare module '*?inline' {
  const dataUri: string
  export default dataUri
}

declare module '*?module' {
  const module: WebAssembly.Module
  export default module
}
