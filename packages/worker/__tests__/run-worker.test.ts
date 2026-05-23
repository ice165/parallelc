jest.mock('../src/mcp-client', () => ({
  spawnMcpWorker: jest.fn(),
  buildWorkerSystemPrompt: jest.fn(() => 'mock-prompt'),
}));

jest.mock('../src/startup', () => ({
  verifySnapshotVersion: jest.fn(() => ({
    versionMatch: true,
    contextMismatch: false,
    actualVersion: 'dag1-20260701T100000Z',
    warnings: [],
  })),
}));

const originalEnv = process.env;

describe('runWorker', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      WORKER_ID: 'worker-task-001',
      WORKER_WRITE_ROOT: '/tmp/w1-write',
      WORKER_READONLY_ROOT: '/tmp/w1-readonly',
      ANTHROPIC_API_KEY: 'sk-test',
      TASK_ID: 'task-001',
      SNAPSHOT_VERSION: 'dag1-20260701T100000Z',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  test('runWorker 调用 spawnMcpWorker 并传递正确参数', () => {
    const { runWorker } = require('../src/run-worker');
    const { spawnMcpWorker } = require('../src/mcp-client');

    runWorker();

    expect(spawnMcpWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-test',
        cwd: '/tmp/w1-write',
        readonlyRoot: '/tmp/w1-readonly',
      }),
      expect.objectContaining({
        taskId: 'task-001',
        snapshotVersion: 'dag1-20260701T100000Z',
      }),
    );
  });

  test('runWorker 校验 snapshot_version', () => {
    const { runWorker } = require('../src/run-worker');
    const { verifySnapshotVersion } = require('../src/startup');

    runWorker();

    expect(verifySnapshotVersion).toHaveBeenCalledWith({
      taskId: 'task-001',
      snapshotVersion: 'dag1-20260701T100000Z',
      projectContextPath: '/tmp/w1-readonly/.parallelc/project_context.md',
    });
  });

  test('缺少必要环境变量时退出码 12', () => {
    delete process.env.WORKER_WRITE_ROOT;
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const { runWorker } = require('../src/run-worker');
    runWorker();

    expect(mockExit).toHaveBeenCalledWith(12);
    mockExit.mockRestore();
  });
});
