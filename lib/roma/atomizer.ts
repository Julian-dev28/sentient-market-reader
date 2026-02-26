import { llmToolCall, type AIProvider } from '../llm-client'

export async function atomize(goal: string, context: string, provider: AIProvider): Promise<boolean> {
  const result = await llmToolCall<{ atomic: boolean; reasoning: string }>({
    provider,
    tier: 'fast',
    maxTokens: 256,
    toolName: 'atomizer_decision',
    toolDescription: 'Classify whether the task is atomic or needs decomposition',
    schema: {
      properties: {
        atomic:    { type: 'boolean', description: 'true = directly answerable in one step; false = requires multiple independent sub-analyses' },
        reasoning: { type: 'string' },
      },
      required: ['atomic', 'reasoning'],
    },
    prompt: `You are the ROMA Atomizer in a ROMA multi-agent trading system.

Market context:
${context}

Task to classify:
"${goal}"

Is this task directly answerable in a single focused analysis step (atomic), or does it require breaking into multiple independent analytical subtasks?`,
  })
  return result.atomic
}
