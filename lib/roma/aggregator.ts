import { llmChat, type AIProvider } from '../llm-client'
import type { SubTask } from './types'

export async function aggregate(
  parentGoal: string,
  context: string,
  subtasks: SubTask[],
  provider: AIProvider,
): Promise<string> {
  const subtaskBlock = subtasks
    .map(t => `[${t.id}] ${t.goal}\n→ ${t.result ?? '(no result)'}`)
    .join('\n\n')

  return llmChat({
    provider,
    tier: 'smart',
    maxTokens: 1024,
    system: 'You are the ROMA Aggregator in a ROMA multi-agent trading system. Synthesize the subtask results into a comprehensive, coherent answer to the parent goal. Do not just summarize — integrate the findings and draw a unified conclusion.',
    prompt: `Parent goal: "${parentGoal}"

Market context:
${context}

Subtask results:
${subtaskBlock}

Synthesize these into a complete answer to the parent goal. Be specific about numbers, directional signals, and trading implications.`,
  })
}
