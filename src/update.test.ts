import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('node:https', () => ({
  get: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('./output.js', () => ({
  printInfo: vi.fn(),
  printError: vi.fn(),
}));

const fsMock = await import('node:fs') as unknown as {
  existsSync: ReturnType<typeof vi.fn>;
  readFileSync: ReturnType<typeof vi.fn>;
  writeFileSync: ReturnType<typeof vi.fn>;
  mkdirSync: ReturnType<typeof vi.fn>;
};

const httpsMock = await import('node:https') as unknown as {
  get: ReturnType<typeof vi.fn>;
};

const cpMock = await import('node:child_process') as unknown as {
  execSync: ReturnType<typeof vi.fn>;
};

const outputMock = await import('./output.js') as unknown as {
  printInfo: ReturnType<typeof vi.fn>;
  printError: ReturnType<typeof vi.fn>;
};

import { compareSemver, getLocalVersion, fetchLatestVersion, checkForUpdate, applyUpdate, interactiveUpdate, startupUpdateCheck } from './update.js';

describe('compareSemver', () => {
  it('detects newer version', () => {
    expect(compareSemver('1.2.0', '1.1.0')).toBeGreaterThan(0);
  });

  it('detects same version', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('detects older version', () => {
    expect(compareSemver('1.0.0', '1.2.0')).toBeLessThan(0);
  });

  it('handles major version difference', () => {
    expect(compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0);
  });

  it('handles patch version difference', () => {
    expect(compareSemver('1.0.1', '1.0.0')).toBeGreaterThan(0);
  });
});

describe('getLocalVersion', () => {
  beforeEach(() => {
    fsMock.readFileSync.mockReset();
  });

  it('reads version from package.json', () => {
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ version: '1.2.3' }));
    expect(getLocalVersion()).toBe('1.2.3');
  });

  it('returns 0.0.0 on error', () => {
    fsMock.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(getLocalVersion()).toBe('0.0.0');
  });
});

function mockHttpsGet(responseBody: string, statusCode = 200) {
  httpsMock.get.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
    const res = {
      statusCode,
      on: vi.fn((event: string, handler: (data?: unknown) => void) => {
        if (event === 'data') handler(Buffer.from(responseBody));
        if (event === 'end') handler();
        return res;
      }),
    };
    cb(res);
    return { on: vi.fn(), destroy: vi.fn() };
  });
}

describe('checkForUpdate', () => {
  beforeEach(() => {
    fsMock.readFileSync.mockReset();
    fsMock.writeFileSync.mockReset();
    fsMock.existsSync.mockReturnValue(true);
    fsMock.mkdirSync.mockReturnValue(undefined);
    httpsMock.get.mockReset();
  });

  it('returns cached result when cache is fresh', async () => {
    const cache = {
      lastCheck: new Date().toISOString(),
      latestVersion: '2.0.0',
      currentVersion: '1.0.0',
    };
    // First call: package.json, second call: cache
    let callCount = 0;
    fsMock.readFileSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return JSON.stringify({ version: '1.0.0' });
      return JSON.stringify(cache);
    });

    const result = await checkForUpdate();
    expect(result.cached).toBe(true);
    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe('2.0.0');
    expect(httpsMock.get).not.toHaveBeenCalled();
  });

  it('fetches from registry when cache is stale', async () => {
    const staleCache = {
      lastCheck: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      latestVersion: '1.0.0',
      currentVersion: '1.0.0',
    };
    let callCount = 0;
    fsMock.readFileSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return JSON.stringify({ version: '1.0.0' });
      if (callCount === 2) return JSON.stringify(staleCache);
      throw new Error('ENOENT');
    });

    mockHttpsGet(JSON.stringify({ version: '2.0.0' }));

    const result = await checkForUpdate();
    expect(result.cached).toBe(false);
    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe('2.0.0');
  });

  it('force bypasses cache', async () => {
    const cache = {
      lastCheck: new Date().toISOString(),
      latestVersion: '1.0.0',
      currentVersion: '1.0.0',
    };
    let callCount = 0;
    fsMock.readFileSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return JSON.stringify({ version: '1.0.0' });
      return JSON.stringify(cache);
    });

    mockHttpsGet(JSON.stringify({ version: '2.0.0' }));

    const result = await checkForUpdate(true);
    expect(result.cached).toBe(false);
    expect(httpsMock.get).toHaveBeenCalled();
  });

  it('returns updateAvailable false when on latest', async () => {
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ version: '2.0.0' }));
    mockHttpsGet(JSON.stringify({ version: '2.0.0' }));

    const result = await checkForUpdate(true);
    expect(result.updateAvailable).toBe(false);
  });
});

describe('fetchLatestVersion', () => {
  beforeEach(() => {
    httpsMock.get.mockReset();
  });

  it('rejects on non-200 status code', async () => {
    mockHttpsGet('Not Found', 404);
    await expect(fetchLatestVersion()).rejects.toThrow('Registry returned status 404');
  });

  it('rejects on invalid version format from registry', async () => {
    mockHttpsGet(JSON.stringify({ version: 'not-semver' }));
    await expect(fetchLatestVersion()).rejects.toThrow('No valid version field');
  });
});

describe('applyUpdate', () => {
  beforeEach(() => {
    cpMock.execSync.mockReset();
  });

  it('runs npm install -g with correct version', () => {
    cpMock.execSync.mockReturnValue(undefined);
    applyUpdate('2.0.0');
    expect(cpMock.execSync).toHaveBeenCalledWith(
      'npm install -g bernard-agent@2.0.0',
      { stdio: 'inherit' }
    );
  });

  it('throws on failure', () => {
    cpMock.execSync.mockImplementation(() => { throw new Error('npm failed'); });
    expect(() => applyUpdate('2.0.0')).toThrow('npm failed');
  });

  it('rejects invalid version format', () => {
    expect(() => applyUpdate('2.0.0; rm -rf /')).toThrow('Invalid version format');
    expect(() => applyUpdate('not-a-version')).toThrow('Invalid version format');
    expect(cpMock.execSync).not.toHaveBeenCalled();
  });
});

describe('interactiveUpdate', () => {
  beforeEach(() => {
    fsMock.readFileSync.mockReset();
    fsMock.writeFileSync.mockReset();
    fsMock.existsSync.mockReturnValue(true);
    fsMock.mkdirSync.mockReturnValue(undefined);
    httpsMock.get.mockReset();
    cpMock.execSync.mockReset();
    outputMock.printInfo.mockReset();
    outputMock.printError.mockReset();
  });

  it('prints already-latest message and auto-update tip', async () => {
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ version: '2.0.0' }));
    mockHttpsGet(JSON.stringify({ version: '2.0.0' }));

    await interactiveUpdate();

    expect(outputMock.printInfo).toHaveBeenCalledWith(expect.stringContaining('latest version'));
    expect(outputMock.printInfo).toHaveBeenCalledWith(expect.stringContaining('auto-update'));
  });

  it('applies update when available', async () => {
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ version: '1.0.0' }));
    mockHttpsGet(JSON.stringify({ version: '2.0.0' }));
    cpMock.execSync.mockReturnValue(undefined);

    await interactiveUpdate();

    expect(cpMock.execSync).toHaveBeenCalledWith(
      'npm install -g bernard-agent@2.0.0',
      { stdio: 'inherit' }
    );
    expect(outputMock.printInfo).toHaveBeenCalledWith(expect.stringContaining('Updated to v2.0.0'));
  });
});

describe('startupUpdateCheck', () => {
  beforeEach(() => {
    fsMock.readFileSync.mockReset();
    fsMock.writeFileSync.mockReset();
    fsMock.existsSync.mockReturnValue(true);
    fsMock.mkdirSync.mockReturnValue(undefined);
    httpsMock.get.mockReset();
    cpMock.execSync.mockReset();
    outputMock.printInfo.mockReset();
  });

  it('is silent when no update available', async () => {
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ version: '2.0.0' }));
    mockHttpsGet(JSON.stringify({ version: '2.0.0' }));

    startupUpdateCheck(false);
    // Wait for the promise chain to resolve
    await new Promise((r) => setTimeout(r, 50));

    expect(outputMock.printInfo).not.toHaveBeenCalled();
  });

  it('prints notification when update available and autoUpdate off', async () => {
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ version: '1.0.0' }));
    mockHttpsGet(JSON.stringify({ version: '2.0.0' }));

    startupUpdateCheck(false);
    await new Promise((r) => setTimeout(r, 50));

    expect(outputMock.printInfo).toHaveBeenCalledWith(expect.stringContaining('Update available'));
    expect(outputMock.printInfo).toHaveBeenCalledWith(expect.stringContaining('bernard update'));
  });

  it('applies update when autoUpdate is on', async () => {
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ version: '1.0.0' }));
    mockHttpsGet(JSON.stringify({ version: '2.0.0' }));
    cpMock.execSync.mockReturnValue(undefined);

    startupUpdateCheck(true);
    await new Promise((r) => setTimeout(r, 50));

    expect(cpMock.execSync).toHaveBeenCalledWith(
      'npm install -g bernard-agent@2.0.0',
      { stdio: 'inherit' }
    );
    expect(outputMock.printInfo).toHaveBeenCalledWith(expect.stringContaining('Updated bernard'));
  });
});
