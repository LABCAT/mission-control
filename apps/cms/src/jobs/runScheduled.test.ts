import { describe, expect, it, vi } from 'vitest'

import { runScheduled, SCHEDULED_QUEUES } from './runScheduled'

describe('runScheduled', () => {
  it('schedules each queue before running it, in order', async () => {
    const calls: string[] = []
    const jobs = {
      handleSchedules: vi.fn(async ({ queue }) => void calls.push(`schedule:${queue}`)),
      run: vi.fn(async ({ queue }) => void calls.push(`run:${queue}`)),
    }

    await runScheduled(jobs as never)

    expect(calls).toEqual(SCHEDULED_QUEUES.flatMap((q) => [`schedule:${q}`, `run:${q}`]))
  })

  it('stops if scheduling fails so a broken queue is not run half-scheduled', async () => {
    const jobs = {
      handleSchedules: vi.fn().mockRejectedValue(new Error('db down')),
      run: vi.fn(),
    }

    await expect(runScheduled(jobs as never)).rejects.toThrow('db down')
    expect(jobs.run).not.toHaveBeenCalled()
  })
})
