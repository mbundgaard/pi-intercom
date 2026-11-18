import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
export const workspaceFields = { worktree: '.worker', branch: 'work/test' };
// Unrelated lifecycle tests isolate Git; workspace.test and extension tests use real repositories.
export const fakeValidateWorkspace = async (root, agent) => ({ worktree: path.resolve(root, agent.worktree), branch: agent.branch });
export async function git(root, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return (await exec('git', ['-C', root, '-c', 'user.name=Intercom Tests', '-c', 'user.email=tests@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], { env, windowsHide: true })).stdout.trim();
}
export async function createGitWorkspace(root) {
  await git(root, 'init', '--initial-branch=main');
  await git(root, 'commit', '--allow-empty', '-m', 'fixture');
  await git(root, 'worktree', 'add', '-b', workspaceFields.branch, path.join(root, workspaceFields.worktree));
  return { ...workspaceFields };
}
