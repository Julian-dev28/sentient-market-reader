import { atomize } from './atomizer'
import { plan } from './planner'
import { execute } from './executor'
import { aggregate } from './aggregator'
import type { SolveResult, SubTask } from './types'
import type { AIProvider } from '../llm-client'

export async function solve(
  goal: string,
  context: string,
  provider: AIProvider,
  depth = 0,
  maxDepth = 2,
): Promise<SolveResult> {
  if (depth >= maxDepth) {
    const answer = await execute(goal, context, provider)
    return { answer, subtasks: [], wasAtomic: true }
  }

  const isAtomic = await atomize(goal, context, provider)

  if (isAtomic) {
    const answer = await execute(goal, context, provider)
    return { answer, subtasks: [], wasAtomic: true }
  }

  const planned = await plan(goal, context, provider)

  const resolvedSubtasks: SubTask[] = await Promise.all(
    planned.map(async task => {
      const result = await solve(task.goal, context, provider, depth + 1, maxDepth)
      return { ...task, result: result.answer }
    })
  )

  const answer = await aggregate(goal, context, resolvedSubtasks, provider)
  return { answer, subtasks: resolvedSubtasks, wasAtomic: false }
}
