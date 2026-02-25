import { llmToolCall, type AIProvider } from '../llm-client'
import type { SubTask } from './types'

export async function plan(goal: string, context: string, provider: AIProvider): Promise<SubTask[]> {
  const result = await llmToolCall<{ subtasks: SubTask[]; planningReasoning: string }>({
    provider,
    tier: 'smart',
    maxTokens: 1024,
    toolName: 'planner_output',
    toolDescription: 'Output the decomposed subtask plan',
    schema: {
      properties: {
        subtasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id:   { type: 'string', description: 'Short ID: t1, t2, t3...' },
              goal: { type: 'string', description: 'Specific, focused analytical question answerable from context' },
            },
            required: ['id', 'goal'],
          },
          description: '3 to 5 independent subtasks that collectively answer the parent goal',
        },
        planningReasoning: { type: 'string' },
      },
      required: ['subtasks', 'planningReasoning'],
    },
    prompt: `You are the ROMA Planner in a Sentient GRID multi-agent trading system.

Market context:
${context}

Parent goal to decompose:
"${goal}"

Break this into 3–5 independent analytical subtasks. Each subtask must be:
- A specific, focused question directly answerable from the market context
- Independent (no subtask depends on another's result)
- Together they fully cover the parent goal`,
  })
  return result.subtasks
}
