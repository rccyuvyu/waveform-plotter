import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cwd = process.cwd();
const packageJsonPath = path.join(cwd, 'package.json');
const packageLockPath = path.join(cwd, 'package-lock.json');

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Unsupported version format: ${version}`);
  }
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number.parseInt(patch, 10) + 1}`;
}

function runOrThrow(command, args) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit'
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

const originalPackageJsonText = fs.readFileSync(packageJsonPath, 'utf8');
const originalPackageLockText = fs.existsSync(packageLockPath)
  ? fs.readFileSync(packageLockPath, 'utf8')
  : undefined;

const packageJson = JSON.parse(originalPackageJsonText);
const nextVersion = bumpPatch(packageJson.version);
packageJson.version = nextVersion;

let packageLock;
if (originalPackageLockText) {
  packageLock = JSON.parse(originalPackageLockText);
  packageLock.version = nextVersion;
  if (packageLock.packages && packageLock.packages['']) {
    packageLock.packages[''].version = nextVersion;
  }
}

try {
  writeJson(packageJsonPath, packageJson);
  if (packageLock) {
    writeJson(packageLockPath, packageLock);
  }

  console.log(`[package-vsix] version ${packageJson.version}`);
  runOrThrow('npm', ['run', 'compile']);

  const vsixName = `${packageJson.name}-${nextVersion}.vsix`;
  runOrThrow('npx', ['@vscode/vsce', 'package', '--out', vsixName]);
  console.log(`[package-vsix] created ${vsixName}`);
} catch (error) {
  fs.writeFileSync(packageJsonPath, originalPackageJsonText, 'utf8');
  if (originalPackageLockText !== undefined) {
    fs.writeFileSync(packageLockPath, originalPackageLockText, 'utf8');
  }
  throw error;
}
