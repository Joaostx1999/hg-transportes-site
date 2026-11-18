/* Tipos do mock (para os testes em TypeScript). */
import type { Server } from 'node:http';

export interface MockCommit {
  sha: string;
  tree: { sha: string } | null;
  parents: { sha: string }[];
  message: string;
  author: { name: string; email: string; date: string | null } | null;
  committer: { name: string; email: string; date: string | null } | null;
}

export function initRepo(o: {
  repoDir: string;
  sourceDir: string;
  reset?: boolean;
  log?: (s: string) => void;
}): 'criado' | 'existente';

export function createMock(o?: {
  repoDir?: string;
  owner?: string;
  repo?: string;
  branch?: string;
  token?: string;
  tokenExpiration?: string;
  log?: (s: string) => void;
}): { server: Server; repoDir: string; head: () => string; readCommit: (sha: string) => MockCommit };
