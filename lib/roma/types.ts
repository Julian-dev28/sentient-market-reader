export interface SubTask {
  id: string
  goal: string
  result?: string
}

export interface SolveResult {
  answer: string
  subtasks: SubTask[]
  wasAtomic: boolean
}
