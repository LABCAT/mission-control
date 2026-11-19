/**
 * Run a task when the browser is idle, so the viewed-jobs scripts never compete with rendering
 * or hydration. `requestIdleCallback` is missing in a few browsers (older Safari); a timeout
 * keeps the feature working there without blocking the main task.
 */
export const whenIdle = (task: () => void): void => {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(task)
    return
  }

  setTimeout(task, 1)
}
