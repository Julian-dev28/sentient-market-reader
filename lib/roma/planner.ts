/**
 * ROMA Planner
 * ────────────
 * Decomposes a non-atomic goal into an ordered list of
 * independent analytical subtasks that can run in parallel.
 */
import { getClaudeClient } from '../claude-client'
import type { SubTask } from './types'

export async function plan(goal: string, context: string): Promise<SubTask[]> {
  const client = getClaudeClient()

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    tools: [
      {
        name: 'planner_output',
        description: 'Output the decomposed subtask plan',
        input_schema: {
          type: 'object' as const,
          properties: {
            subtasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id:   { type: 'string', description: 'Short ID: t1, t2, t3...' },
                  goal: { type: 'string', description: 'Specific, focused analytical question answerable directly from context' },
                },
                required: ['id', 'goal'],
              },
              description: '3 to 5 independent subtasks that collectively answer the parent goal',
            },
            planningReasoning: { type: 'string', description: 'Why these subtasks cover the parent goal' },
          },
          required: ['subtasks', 'planningReasoning'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'planner_output' },
    messages: [
      {
        role: 'user',
        content: `You are the ROMA Planner in a Sentient GRID multi-agent trading system.

Market context:
${context}

Parent goal to decompose:
"${goal}"

Break this into 3–5 independent analytical subtasks. Each subtask should be:
- A specific, focused question directly answerable from the market context
- Independent (no subtask depends on another's result)
- Together they fully cover the parent goal

Examples of good subtasks for a trading analysis:
- "What does the 1-hour BTC price change signal about short-term directional momentum?"
- "What does the Kalshi YES/NO pricing spread reveal about crowd expectations for this window?"
- "Given the current BTC position relative to strike and time remaining, how likely is BTC to stay above/below strike?"`,
      },
    ],
  })

  const tool = response.content.find(b => b.type === 'tool_use')
  if (!tool || tool.type !== 'tool_use') return []
  return (tool.input as { subtasks: SubTask[] }).subtasks
}
