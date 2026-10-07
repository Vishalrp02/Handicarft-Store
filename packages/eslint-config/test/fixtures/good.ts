import { readFile } from 'node:fs/promises'

export async function firstLine(path: string): Promise<string | undefined> {
  const text = await readFile(path, 'utf8')
  const lines = text.split('\n')
  return lines[0]
}
