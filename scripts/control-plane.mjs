#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export const REGISTRY_SCHEMA_VERSION = 3;

function runGit(args, cwd, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if (allowFail) return '';
    throw error;
  }
}

export function gitCommonRoot(projectRoot = '.') {
  const root = resolve(projectRoot);
  try {
    const raw = runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
    const commonDir = isAbsolute(raw) ? raw : resolve(root, raw);
    return dirname(commonDir);
  } catch {
    return root;
  }
}

function ancestors(path) {
  const result = [];
  let current = resolve(path);
  while (!result.includes(current)) {
    result.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}

function registryFile(root) {
  return join(root, 'registry.json');
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

function candidateControlRoots(projectRoot, env = process.env) {
  const roots = [];
  if (env.CHISEL_CONTROL_ROOT) roots.push(resolve(env.CHISEL_CONTROL_ROOT));
  const project = resolve(projectRoot);
  for (const ancestor of ancestors(project)) roots.push(join(ancestor, '.chisel'));
  const common = gitCommonRoot(project);
  for (const ancestor of ancestors(common)) roots.push(join(ancestor, '.chisel'));
  return [...new Set(roots)];
}

/** Locate an existing registry without deriving its location from cwd alone. */
export function locateRegistry(projectRoot = '.', env = process.env) {
  const project = resolve(projectRoot);
  const candidates = [];
  for (const root of candidateControlRoots(projectRoot, env)) {
    const registry = readJson(registryFile(root));
    if (registry && (registry.schema_version === REGISTRY_SCHEMA_VERSION || registry.schema_version === 2 || registry.schema_version === 1)) {
      candidates.push({ control_root: root, registry_file: registryFile(root), registry });
    }
  }
  const matchesProject = candidate => Object.values(candidate.registry?.ideas || {}).some(record => {
    const paths = [record.workspace_root, ...(Array.isArray(record.repos) ? record.repos.flatMap(repo => [repo?.repo_path || repo?.path, repo?.worktree_path]) : [])]
      .filter(path => typeof path === 'string' && path.length > 0).map(path => resolve(path));
    return paths.some(path => project === path || project.startsWith(`${path}/`) || path.startsWith(`${project}/`));
  });
  return candidates.find(matchesProject) || candidates[0] || null;
}

export function controlRoot(projectRoot = '.', env = process.env) {
  const located = locateRegistry(projectRoot, env);
  if (located) return located.control_root;
  if (env.CHISEL_CONTROL_ROOT) return resolve(env.CHISEL_CONTROL_ROOT);
  // A non-Git outer workspace naturally resolves to <workspace>/.chisel.
  return join(gitCommonRoot(projectRoot), '.chisel');
}

export function ensureControlPlaneIgnored(projectRoot = '.') {
  const project = resolve(projectRoot);
  const raw = runGit(['rev-parse', '--git-path', 'info/exclude'], project, { allowFail: true });
  if (!raw) return false;
  const excludeFile = isAbsolute(raw) ? raw : resolve(project, raw);
  const pattern = '/.chisel/';
  const current = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
  if (current.split('\n').map(line => line.trim()).includes(pattern)) return false;
  mkdirSync(dirname(excludeFile), { recursive: true });
  appendFileSync(excludeFile, `${current && !current.endsWith('\n') ? '\n' : ''}${pattern}\n`);
  return true;
}

function normalizeIdeaName(ideaName) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(ideaName || '')) throw new Error('idea-name must be kebab-case');
  return ideaName;
}

export function readControlRegistry(root) {
  return readJson(registryFile(resolve(root))) || { schema_version: REGISTRY_SCHEMA_VERSION, ideas: {} };
}

export function writeControlRegistry(root, registry) {
  const next = {
    schema_version: REGISTRY_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
    ideas: registry?.ideas && typeof registry.ideas === 'object' ? registry.ideas : {},
  };
  writeJson(registryFile(resolve(root)), next);
  return next;
}

export function registerIdea(projectRoot, ideaName, record, env = process.env) {
  const name = normalizeIdeaName(ideaName);
  ensureControlPlaneIgnored(projectRoot);
  const root = controlRoot(projectRoot, env);
  const registry = readControlRegistry(root);
  const existing = registry.ideas[name] || {};
  const ideaDir = record.idea_dir ? resolve(record.idea_dir) : join(root, name);
  const nextRecord = {
    ...existing,
    ...record,
    idea_name: name,
    idea_dir: ideaDir,
    workspace_root: record.workspace_root ? resolve(record.workspace_root) : (existing.workspace_root || resolve(projectRoot)),
    lifecycle: record.lifecycle || existing.lifecycle || 'active',
    updated_at: new Date().toISOString(),
  };
  registry.ideas[name] = nextRecord;
  writeControlRegistry(root, registry);
  writeJson(join(ideaDir, 'registry.json'), { schema_version: REGISTRY_SCHEMA_VERSION, ...nextRecord });
  return { control_root: root, idea_dir: ideaDir, record: nextRecord };
}

/**
 * Reserve a brand-new requirement directory without consulting or reusing the
 * contents of any existing requirement. A numeric suffix keeps repeated names
 * isolated while mkdir provides the collision boundary for concurrent starts.
 */
export function createIsolatedIdea(projectRoot, ideaName, env = process.env) {
  const requestedName = normalizeIdeaName(ideaName);
  ensureControlPlaneIgnored(projectRoot);
  const root = controlRoot(projectRoot, env);
  const registry = readControlRegistry(root);
  mkdirSync(root, { recursive: true });

  let sequence = 1;
  let allocatedName;
  let ideaDir;
  while (!allocatedName) {
    const candidate = sequence === 1 ? requestedName : `${requestedName}-${sequence}`;
    sequence += 1;
    if (registry.ideas[candidate]) continue;
    const candidateDir = join(root, candidate);
    try {
      mkdirSync(candidateDir);
      allocatedName = candidate;
      ideaDir = candidateDir;
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
  }

  const registered = registerIdea(projectRoot, allocatedName, {
    idea_dir: ideaDir,
    workspace_root: resolve(projectRoot),
    lifecycle: 'active',
    created_at: new Date().toISOString(),
  }, env);
  return {
    ...registered,
    requested_idea_name: requestedName,
    allocated_idea_name: allocatedName,
    reused: false,
  };
}

export function locateIdea(projectRoot, ideaName, env = process.env) {
  const name = normalizeIdeaName(ideaName);
  const roots = candidateControlRoots(projectRoot, env);
  const project = resolve(projectRoot);
  const candidates = [];
  for (const root of roots) {
    const registry = readJson(registryFile(root));
    const record = registry?.ideas?.[name];
    if (record) candidates.push({ control_root: root, registry_file: registryFile(root), idea_dir: resolve(record.idea_dir || join(root, name)), record, registry });
    const ideaRecord = readJson(join(root, name, 'registry.json'));
    if (ideaRecord) candidates.push({ control_root: root, registry_file: registryFile(root), idea_dir: resolve(ideaRecord.idea_dir || join(root, name)), record: ideaRecord, registry });
  }
  const matchesProject = candidate => {
    const record = candidate.record || {};
    const paths = [record.workspace_root, ...(Array.isArray(record.repos) ? record.repos.flatMap(repo => [repo?.repo_path || repo?.path, repo?.worktree_path]) : [])]
      .filter(path => typeof path === 'string' && path.length > 0).map(path => resolve(path));
    return paths.some(path => project === path || project.startsWith(`${path}/`) || path.startsWith(`${project}/`));
  };
  if (candidates.length) return candidates.find(matchesProject) || candidates[0];
  const fallbackRoot = controlRoot(projectRoot, env);
  const fallbackIdea = join(fallbackRoot, name);
  return { control_root: fallbackRoot, registry_file: registryFile(fallbackRoot), idea_dir: fallbackIdea, record: null, registry: readControlRegistry(fallbackRoot) };
}

export function ideaDirectory(projectRoot, ideaName, env = process.env) {
  return locateIdea(projectRoot, ideaName, env).idea_dir;
}

/**
 * Recover an existing idea directory from the registry when a caller copied a
 * stale or mistyped absolute parent path. Only the basename is reused, and only
 * when it is a valid idea name and the registry target actually exists.
 */
export function resolveExistingIdeaDirectory(input, projectRoot = '.', env = process.env) {
  const requested = resolve(input);
  if (existsSync(requested)) return requested;
  const ideaName = basename(requested);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(ideaName)) return requested;
  const located = locateIdea(projectRoot, ideaName, env);
  return existsSync(located.idea_dir) ? resolve(located.idea_dir) : requested;
}

function main() {
  const args = process.argv.slice(2);
  const projectIndex = args.indexOf('--project-root');
  const projectRoot = projectIndex >= 0 ? args[projectIndex + 1] : '.';
  const ideaIndex = args.indexOf('--idea');
  const ideaName = ideaIndex >= 0 ? args[ideaIndex + 1] : '';
  const mode = args.includes('--new') ? 'new' : args.includes('--locate') ? 'locate' : args.includes('--resume') ? 'resume' : args.includes('--status') ? 'status' : 'path';
  try {
    if (!ideaName) {
      console.log(mode === 'path' ? controlRoot(projectRoot) : JSON.stringify({ control_root: controlRoot(projectRoot), registry: locateRegistry(projectRoot)?.registry || null }, null, 2));
      return;
    }
    if (mode === 'path') ensureControlPlaneIgnored(projectRoot);
    if (mode === 'new') {
      console.log(JSON.stringify({ ...createIsolatedIdea(projectRoot, ideaName), action: mode }, null, 2));
      return;
    }
    const located = locateIdea(projectRoot, ideaName);
    if (mode === 'resume' && !located.record && !existsSync(located.idea_dir)) {
      throw new Error(`cannot resume unknown idea: ${ideaName}`);
    }
    if (mode === 'path') console.log(located.idea_dir);
    else console.log(JSON.stringify({ ...located, action: mode }, null, 2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
