import { test, expect, _electron } from '@playwright/test';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';

test.use({ trace: 'off' });

function componentProcesses(
  resources: string,
): Promise<{ ProcessId: number; Name: string; CommandLine: string }[]> {
  const script = `$root = '${resources.replaceAll("'", "''")}'; ConvertTo-Json -Compress -InputObject @(
    Get-CimInstance Win32_Process -Filter "Name = 'pwsh.exe' OR Name = 'sshd.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($root) } |
    Select-Object ProcessId,Name,CommandLine
  )`;
  return new Promise((accept, reject) => {
    execFile(
      'pwsh.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, encoding: 'utf8', timeout: 10000 },
      (error, stdout) => (error ? reject(error) : accept(JSON.parse(stdout))),
    );
  });
}

test('packaged exe runs without development dependencies and reclaims bundled remote components on close', async () => {
  test.skip(
    !process.env.WINDOWS_PACKAGE_EXE || process.platform !== 'win32',
    'Explicit opt-in: built Windows package.',
  );
  test.setTimeout(90000);
  const executablePath = resolve(process.env.WINDOWS_PACKAGE_EXE!);
  const resources = join(dirname(executablePath), 'resources');
  const smokeRoot = resolve('.local/package-smoke');
  mkdirSync(smokeRoot, { recursive: true });
  const directory = mkdtempSync(join(smokeRoot, 'run-'));
  const project = join(directory, '项目 fixture');
  mkdirSync(join(project, '.git'), { recursive: true });
  writeFileSync(join(project, '.git/HEAD'), 'ref: refs/heads/package-smoke\n');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        entry[0] !== 'ELECTRON_RUN_AS_NODE' &&
        !entry[0].startsWith('PROXY_') &&
        entry[0].toLowerCase() !== 'path',
    ),
  );
  env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
  const application = await _electron.launch({
    executablePath,
    args: ['--smoke-test', `--user-data-dir=${join(directory, 'profile')}`],
    cwd: directory,
    env,
  });
  const applicationProcess = application.process();
  const errors: string[] = [];
  try {
    const page = await application.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '连接代理服务', exact: true })).toBeVisible();
    await expect(page.getByLabel('服务证书指纹', { exact: true })).toBeVisible();
    expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    expect(await page.evaluate((path) => window.desktop!.gitBranch(path), project)).toBe(
      'package-smoke',
    );
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await new Promise<void>((accept, reject) => {
      execFile(
        executablePath,
        ['--smoke-test', `--user-data-dir=${join(directory, 'profile')}`],
        { env, windowsHide: true, timeout: 10000 },
        (error) => (error ? reject(error) : accept()),
      );
    });
    expect(
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    ).toBe(1);
    if (process.env.NATIVE_TEST_CONFIG) {
      const connection = JSON.parse(readFileSync(resolve(process.env.NATIVE_TEST_CONFIG), 'utf8'));
      await page.getByLabel('服务地址', { exact: true }).fill(connection.url);
      await page.getByLabel('服务证书指纹', { exact: true }).fill(connection.fingerprint ?? '');
      await page.getByLabel('服务凭据', { exact: true }).fill(connection.token);
      await page.getByRole('button', { name: '连接', exact: true }).click();
      await expect(page.locator('.connection-status')).toContainText('已连接', { timeout: 45000 });
      const components = await componentProcesses(resources);

      expect(components.some((row) => row.Name === 'sshd.exe')).toBe(true);
      expect(
        components.some(
          (row) => row.Name === 'pwsh.exe' && row.CommandLine.includes('vendor\\pwsh'),
        ),
      ).toBe(true);
      const host = components.find(
        (row) => row.Name === 'pwsh.exe' && row.CommandLine.includes('component-host.ps1'),
      )!;
      const runtime = host.CommandLine.match(
        /-Runtime\s+"?([^"]*?cc-desk-tunnel-ssh-[^\s"]+)/,
      )?.[1];
      expect(runtime && existsSync(runtime)).toBeTruthy();
      await page.getByRole('button', { name: '设置与账号', exact: true }).click();
      await page.getByRole('menuitem', { name: /^账号/ }).click();
      await expect(
        page.getByRole('region', { name: '账号信息' }).locator('.account-identity'),
      ).toContainText(/pro/i, { timeout: 25000 });
      await page.screenshot({ path: join(directory, 'packaged-account.png') });
      await application.close();
      await expect
        .poll(async () => (await componentProcesses(resources)).length, { timeout: 15000 })
        .toBe(0);
      expect(existsSync(runtime!)).toBe(false);
    } else {
      await page.screenshot({ path: join(directory, 'packaged-login.png') });
    }
    expect(errors).toEqual([]);
  } finally {
    if (applicationProcess.exitCode === null) await application.close();
  }
});
