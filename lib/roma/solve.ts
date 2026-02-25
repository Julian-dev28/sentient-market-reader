/**
 * ROMA Solve Loop
 * ───────────────
 * Recursive Open Meta-Agent core:
 *
 *   solve(task):
 *     if atomizer says atomic → execute directly
 *     else:
 *       subtasks = planner.plan(task)
 *       results  = await Promise.all(subtasks.map(solve))   ← parallel
 *       return aggregator.aggregate(results)
 *
 * Max depth caps recursion at 2 levels for the trading use case.
 */
import { atomize } from './atomizer'
import { plan } from './planner'
import { execute } from './executor'
import { aggregate } from './aggregator'
import type { SolveResult, SubTask } from './types'

export async function solve(
  goal: string,
  context: string,
  depth = 0,
  maxDepth = 2
): Promise<SolveResult> {
  // At max depth — force atomic execution
  if (depth >= maxDepth) {
    const answer = await execute(goal, context)
    return { answer, subtasks: [], wasAtomic: true }
  }

  const isAtomic = await atomize(goal, context)

  if (isAtomic) {
    const answer = await execute(goal, context)
    return { answer, subtasks: [], wasAtomic: true }
  }

  // Decompose → execute all subtasks in parallel → aggregate
  const planned = await plan(goal, context)

  const resolvedSubtasks: SubTask[] = await Promise.all(
    planned.map(async task => {
      const result = await solve(task.goal, context, depth + 1, maxDepth)
      return { ...task, result: result.answer }
    })
  )

  const answer = await aggregate(goal, context, resolvedSubtasks)

  return { answer, subtasks: resolvedSubtasks, wasAtomic: false }
}
