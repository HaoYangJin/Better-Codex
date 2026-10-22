import { homedir } from 'node:os'
import { join } from 'node:path'
import { access, readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'

export interface CodexPaths {
  home: string
  sessionDirectories: string[]
  stateDatabase: string | null
  historyDatabase: string | null
  globalState: string
}

export async function discoverCodexPaths(): Promise<CodexPaths> {
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  const directories = [join(home, 'sessions'), join(home, 'archived_sessions')]
  const existingDirectories: string[] = []
  for (const directory of directories) {
    if (await exists(directory)) existingDirectories.push(directory)
  }

  return {
    home,
    sessionDirectories: existingDirectories,
    stateDatabase: await findVersionedDatabase(home, 'state_'),
    historyDatabase: await findVersionedDatabase(home, 'thread_history_'),
    globalState: join(home, '.codex-global-state.json')
  }
}

export async function listSessionFiles(paths: CodexPaths): Promise<string[]> {
  const result: string[] = []
  for (const directory of paths.sessionDirectories) {
    await walk(directory, result)
  }
  return result.filter((file) => file.endsWith('.jsonl')).sort()
}

async function findVersionedDatabase(home: string, prefix: string): Promise<string | null> {
  let entries: Dirent[]
  try {
    entries = await readdir(home, { withFileTypes: true })
  } catch {
    return null
  }

  const matches = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.sqlite'))
    .map((entry) => ({
      name: entry.name,
      version: Number(entry.name.slice(prefix.length, -'.sqlite'.length))
    }))
    .filter((entry) => Number.isFinite(entry.version))
    .sort((left, right) => right.version - left.version)

  return matches[0] ? join(home, matches[0].name) : null
}

async function walk(directory: string, output: string[]): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await walk(path, output)
    else if (entry.isFile()) output.push(path)
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
