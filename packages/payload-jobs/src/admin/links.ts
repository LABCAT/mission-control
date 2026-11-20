/** Admin URLs for the dashboard's links, built from the host's own admin route. */
export const adminCollectionPath = (
  adminRoute: string,
  slug: string,
  id?: number | string,
): string => {
  const base = `/${adminRoute.replace(/^\/+|\/+$/g, '')}/collections/${slug}`

  return id === undefined ? base : `${base}/${encodeURIComponent(String(id))}`
}
