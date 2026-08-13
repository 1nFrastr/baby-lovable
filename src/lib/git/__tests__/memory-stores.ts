import {
  setGitRepositoryStoreAdapterForTests,
  type GitRepositoryStoreAdapter,
} from "../repository-store";
import {
  setGitSyncTaskStoreAdapterForTests,
  type GitSyncTaskStoreAdapter,
} from "../sync-task-store";
import {
  emptyGitRepository,
  type SessionGitRepository,
  type SessionGitSyncTask,
} from "../types";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function installMemoryGitStores(): () => void {
  const repositories = new Map<string, SessionGitRepository>();
  const tasks = new Map<string, SessionGitSyncTask>();

  const repositoryAdapter: GitRepositoryStoreAdapter = {
    requiresUserId: false,
    async read(sessionId) {
      const repository = repositories.get(sessionId);
      return repository ? clone(repository) : null;
    },
    async ensure(sessionId) {
      const existing = repositories.get(sessionId);
      if (existing) {
        return clone(existing);
      }
      const repository = emptyGitRepository(sessionId);
      repository.revision = 1;
      repositories.set(sessionId, clone(repository));
      return repository;
    },
    async write(repository) {
      repositories.set(repository.sessionId, clone(repository));
    },
  };

  const syncTaskAdapter: GitSyncTaskStoreAdapter = {
    requiresUserId: false,
    async read(sessionId, runId) {
      const task = tasks.get(`${sessionId}:${runId}`);
      return task ? clone(task) : null;
    },
    async write(task) {
      tasks.set(`${task.sessionId}:${task.runId}`, clone(task));
    },
    async list(sessionId) {
      return [...tasks.values()]
        .filter((task) => task.sessionId === sessionId)
        .map(clone);
    },
  };

  setGitRepositoryStoreAdapterForTests(repositoryAdapter);
  setGitSyncTaskStoreAdapterForTests(syncTaskAdapter);

  return () => {
    setGitRepositoryStoreAdapterForTests(null);
    setGitSyncTaskStoreAdapterForTests(null);
  };
}
