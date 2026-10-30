import { performance } from 'node:perf_hooks';
import { validateAction } from './policy.mjs';

/** Runs a bounded batch. Any failed assertion terminates the sequence. */
export async function executeBatch(steps, executor, options = {}) {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > (options.maxSteps ?? 8)) {
    return { ok: false, error: 'invalid_batch_size', results: [] };
  }
  const results = [];
  const start = performance.now();
  for (const [index, step] of steps.entries()) {
    const deny = validateAction(step);
    if (deny) return { ok: false, error: deny, failedAt: index, results, durationMs: Math.round(performance.now() - start) };
    const t0 = performance.now();
    try {
      const result = await executor(step);
      const item = { index, type: step.type, ok: !!result.ok, durationMs: Math.round(performance.now() - t0) };
      if (step.expectUrlIncludes && !String(result.url ?? '').includes(step.expectUrlIncludes)) item.ok = false;
      if (step.expectTextIncludes && !String(result.tree ?? '').includes(step.expectTextIncludes)) item.ok = false;
      results.push(item);
      if (!item.ok) return { ok: false, error: 'postcondition_failed', failedAt: index, results, durationMs: Math.round(performance.now() - start) };
    } catch (e) {
      results.push({ index, type: step.type, ok: false, durationMs: Math.round(performance.now() - t0) });
      return { ok: false, error: 'step_failed', failedAt: index, results, durationMs: Math.round(performance.now() - start) };
    }
  }
  return { ok: true, results, durationMs: Math.round(performance.now() - start) };
}
