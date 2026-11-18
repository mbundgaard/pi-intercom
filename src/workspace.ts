import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fail, requireWorkspace, type Agent } from './config.js';

const exec = promisify(execFile);
const CHECK_TIMEOUT_MS = 3000;
export interface WorkerWorkspace { worktree: string; branch: string }

/** Compare the loaded contract, not transport ports or optional workflow metadata. */
export function sameResponsibility(a: Agent, b: Agent): boolean {
  return a.sessionId === b.sessionId && a.coordinator === b.coordinator && a.name === b.name &&
    a.description === b.description && a.projectDirectory === b.projectDirectory &&
    a.worktree === b.worktree && a.branch === b.branch;
}

/** Read-only Git inspection. No shell, hooks, writes, retries, or inherited Git routing. */
export async function validateWorkerWorkspace(root: string, agent: Pick<Agent, 'worktree' | 'branch'>): Promise<WorkerWorkspace> {
  requireWorkspace(agent);
  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  const git = async (cwd: string, args: string[]): Promise<string> => {
    const timeout = deadline - Date.now();
    if (timeout <= 0) fail('worker workspace validation timed out');
    try {
      const result = await exec('git', ['-C', cwd, ...args], { env, timeout, maxBuffer: 16384, windowsHide: true, encoding: 'utf8' });
      return result.stdout.trimEnd();
    } catch { return fail('worker workspace Git check failed (Git unavailable, invalid repository, detached HEAD, or timeout)'); }
  };
  let base: string, worktree: string;
  try {
    [base, worktree] = await Promise.all([realpath(root), realpath(path.resolve(root, agent.worktree))]);
    if (!(await stat(worktree)).isDirectory()) fail('worker worktree is not a directory');
  } catch { return fail('worker worktree directory is missing or inaccessible'); }
  if (path.relative(base, worktree) === '') fail('worker worktree must be separate from the project root');
  const [rootCommon, metadata, ref] = await Promise.all([
    git(base, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    git(worktree, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']),
    git(worktree, ['symbolic-ref', '--quiet', 'HEAD']),
  ]);
  const parts = metadata.split(/\r?\n/);
  if (parts.length !== 2) fail('invalid worker worktree metadata');
  const [top, common, projectCommon] = await Promise.all([realpath(parts[0]), realpath(parts[1]), realpath(rootCommon)]);
  if (path.relative(top, worktree) !== '') fail('worker worktree must be the worktree root, not a subdirectory');
  if (path.relative(common, projectCommon) !== '') fail('worker worktree belongs to a different repository');
  if (ref !== `refs/heads/${agent.branch}`) fail('worker worktree is not on its configured branch');
  return { worktree, branch: agent.branch };
}
