/**
 * ROMA Atomizer
 * ─────────────
 * Decides whether a task is directly executable (atomic)
 * or needs to be broken into subtasks.
 * Uses a fast model — this is a binary decision gate.
 */
import { getClaudeClient } from '../claude-client'

export async function atomize(goal: string, context: string): Promise<boolean> {
  const client = getClaudeClient()

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    tools: [
      {
        name: 'atomizer_decision',
        description: 'Classify whether the task is atomic or needs decomposition',
        input_schema: {
          type: 'object' as const,
          properties: {
            atomic: {
              type: 'boolean',
              description: 'true = directly answerable in one analysis step; false = requires multiple independent sub-analyses',
            },
            reasoning: { type: 'string' },
          },
          required: ['atomic', 'reasoning'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'atomizer_decision' },
    messages: [
      {
        role: 'user',
        content: `You are the ROMA Atomizer in a Sentient GRID multi-agent trading system.

Market context:
${context}

Task to classify:
"${goal}"

Is this task directly answerable in a single focused analysis step (atomic), or does it require breaking into multiple independent analytical subtasks to answer properly?`,
      },
    ],
  })

  const tool = response.content.find(b => b.type === 'tool_use')
  if (!tool || tool.type !== 'tool_use') return false
  return (tool.input as { atomic: boolean }).atomic
}
