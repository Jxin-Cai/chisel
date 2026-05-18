#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { appendAuditLog } from './audit-log.mjs';
import { atomicWriteFile, ensureDir, resolveProjectName } from './workflow-lib.mjs';

const WIKI_FILES = [
  'index.md',
  'project-overview.md',
  'system-map.md',
  'glossary.md',
  'forbidden-zones.md',
  'weird-but-intentional.md',
  'do-not-refactor-yet.md',
  'hotspot-register.md',
  'adr-index.md'
];

const QUERY_FILES = [
  'forbidden-zones.md',
  'weird-but-intentional.md',
  'do-not-refactor-yet.md',
  'glossary.md',
  'hotspot-register.md',
  'adr-index.md'
];

const WIKI_TO_CATEGORY = {
  'forbidden-zones.md': 'forbidden_zone',
  'weird-but-intentional.md': 'weird_but_intentional',
  'do-not-refactor-yet.md': 'smell',
  'glossary.md': 'glossary',
  'hotspot-register.md': 'hotspot',
  'adr-index.md': 'adr'
};

const CATEGORY_TO_WIKI = {
  forbidden_zone: 'forbidden-zones.md',
  weird_but_intentional: 'weird-but-intentional.md',
  smell: 'do-not-refactor-yet.md',
  glossary: 'glossary.md'
};

const CATEGORY_REQUIRED_CONTENT = {
  forbidden_zone: ['范围', '原因'],
  weird_but_intentional: ['现象', '原因'],
  smell: ['坏味道', '位置', '本次不处理原因'],
  glossary: ['术语', '定义']
};

const CANDIDATE_STATUSES = new Set(['proposed', 'confirmed', 'merged', 'rejected', 'deferred']);
const TERMINAL_CANDIDATE_STATUSES = new Set(['merged', 'rejected', 'deferred']);
const CANDIDATE_TRANSITIONS = new Set([
  'proposed:confirmed',
  'proposed:rejected',
  'proposed:deferred',
  'confirmed:rejected',
  'confirmed:deferred',
  'confirmed:merged'
]);

const RELATION_SECTION = `
## 关联关系

| 关联条目 | 关系类型 | 说明 |
|---------|---------|------|
`;

function wikiDir(projectRoot, projectName) {
  const name = projectName || resolveProjectName(projectRoot);
  const newPath = join(projectRoot, '.chisel', 'wiki', name);
  if (existsSync(newPath)) return newPath;
  const legacyPath = join(projectRoot, '.chisel', 'wiki');
  const legacyIndex = join(legacyPath, 'index.md');
  if (existsSync(legacyIndex) && !existsSync(join(legacyPath, name))) {
    process.stderr.write(`[chisel] wiki 使用旧路径 .chisel/wiki/，建议迁移: mv .chisel/wiki .chisel/wiki/${name}\n`);
    return legacyPath;
  }
  return newPath;
}

function initWiki(projectRoot, pluginRoot, projectName) {
  const dir = wikiDir(projectRoot, projectName);
  ensureDir(dir);

  const templatePath = pluginRoot
    ? join(pluginRoot, 'skills/chisel-help/references/llm-wiki-index-template.md')
    : null;

  if (templatePath && existsSync(templatePath)) {
    const template = readFileSync(templatePath, 'utf8');
    atomicWriteFile(join(dir, 'index.md'), template);
  } else {
    atomicWriteFile(join(dir, 'index.md'), '# LLM Wiki Index\n\n请参考 llm-wiki-index-template.md 填充。\n');
  }

  for (const file of WIKI_FILES.slice(1)) {
    const filePath = join(dir, file);
    if (!existsSync(filePath)) {
      const title = file.replace('.md', '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      atomicWriteFile(filePath, `# ${title}\n${RELATION_SECTION}`);
    }
  }

  ensureDir(join(dir, 'modules'));
  return { status: 'initialized', path: dir };
}

function nextEntryId(content, prefix) {
  const regex = new RegExp(`### ${prefix}-(\\d+)`, 'g');
  let max = 0;
  let match;
  while ((match = regex.exec(content)) !== null) {
    max = Math.max(max, Number(match[1]));
  }
  return String(max + 1).padStart(3, '0');
}

function readCandidate(candidateFile) {
  if (!candidateFile || !existsSync(candidateFile)) throw new Error(`candidate file not found: ${candidateFile}`);
  return JSON.parse(readFileSync(candidateFile, 'utf8'));
}

function hasDecisionReason(candidate) {
  return Boolean(candidate.decision && typeof candidate.decision.reason === 'string' && candidate.decision.reason.trim());
}

function validCandidateEvidence(evidence) {
  if (typeof evidence === 'string') return /^[^\s:]+(?:\/[^\s:]+)*:\d+\b/.test(evidence.trim());
  return Boolean(evidence && typeof evidence.file === 'string' && Number.isInteger(evidence.line_start) && evidence.line_start > 0);
}

function validateCandidate(candidate, { requireConfirmed = false } = {}) {
  const missing = [];
  for (const field of ['id', 'category', 'status', 'source_step']) {
    if (!candidate?.[field]) missing.push(field);
  }
  if (typeof candidate?.confirmed !== 'boolean') missing.push('confirmed');
  if (!Array.isArray(candidate?.evidence) || candidate.evidence.length === 0) missing.push('evidence');
  if (!candidate?.content || typeof candidate.content !== 'object' || Array.isArray(candidate.content) || Object.keys(candidate.content).length === 0) missing.push('content');
  if (missing.length > 0) throw new Error(`candidate missing required fields: ${missing.join(', ')}`);
  if (!CATEGORY_TO_WIKI[candidate.category]) throw new Error(`unknown category: ${candidate.category}`);
  if (!CANDIDATE_STATUSES.has(candidate.status)) throw new Error(`unknown candidate status: ${candidate.status}`);
  if (!Number.isFinite(candidate.quality_score) || candidate.quality_score < 0.5) throw new Error('candidate quality_score must be >= 0.5');
  if (!Array.isArray(candidate.keywords) || candidate.keywords.filter(Boolean).length === 0) throw new Error('candidate keywords must not be empty');
  const invalidEvidenceIndex = candidate.evidence.findIndex(evidence => !validCandidateEvidence(evidence));
  if (invalidEvidenceIndex >= 0) throw new Error(`candidate evidence[${invalidEvidenceIndex}] must be structured file/line_start or legacy file:line string`);
  const missingContentKeys = (CATEGORY_REQUIRED_CONTENT[candidate.category] || []).filter(key => !String(candidate.content[key] || '').trim());
  if (missingContentKeys.length > 0) throw new Error(`candidate content missing required keys: ${missingContentKeys.join(', ')}`);
  if (TERMINAL_CANDIDATE_STATUSES.has(candidate.status) && requireConfirmed) throw new Error(`candidate is already terminal: ${candidate.status}`);
  if (requireConfirmed) {
    if (candidate.status !== 'confirmed') throw new Error('candidate must be confirmed before merge');
    if (candidate.confirmed !== true) throw new Error('candidate must set confirmed=true before merge');
    if (!hasDecisionReason(candidate)) throw new Error('confirmed candidate missing decision.reason');
  }
  return candidate;
}

function candidateIdeaDir(candidateFile) {
  const dir = dirname(candidateFile);
  return basename(dir) === 'knowledge-candidates' ? dirname(dir) : '';
}

function writeCandidate(candidateFile, candidate) {
  atomicWriteFile(candidateFile, `${JSON.stringify(candidate, null, 2)}\n`);
}

function setCandidateStatus(ideaDir, candidateFile, nextStatus, reason) {
  if (!['confirmed', 'rejected', 'deferred'].includes(nextStatus)) throw new Error(`unsupported candidate decision status: ${nextStatus}`);
  if (!reason || !String(reason).trim()) throw new Error('candidate status change requires --reason');
  const candidate = validateCandidate(readCandidate(candidateFile));
  const current = candidate.status;
  if (!CANDIDATE_TRANSITIONS.has(`${current}:${nextStatus}`)) throw new Error(`invalid candidate transition: ${current} -> ${nextStatus}`);
  candidate.status = nextStatus;
  candidate.confirmed = nextStatus === 'confirmed';
  candidate.decision = { by: 'user', at: new Date().toISOString(), reason: String(reason).trim() };
  writeCandidate(candidateFile, candidate);
  appendAuditLog(ideaDir, { type: 'knowledge_candidate_decision', candidate_id: candidate.id, from: current, to: nextStatus, reason: candidate.decision.reason });
  return candidate;
}

function listCandidates(ideaDir) {
  const dir = join(ideaDir, 'knowledge-candidates');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(file => file.endsWith('.json'))
    .map(file => {
      const candidate = readCandidate(join(dir, file));
      return { id: candidate.id, category: candidate.category, status: candidate.status, confirmed: candidate.confirmed, file: `knowledge-candidates/${file}` };
    });
}

function coreCandidateValues(candidate) {
  const keys = {
    forbidden_zone: ['范围'],
    weird_but_intentional: ['现象'],
    smell: ['坏味道', '位置'],
    glossary: ['术语']
  }[candidate.category] || [];
  return keys.flatMap(key => Array.isArray(candidate.content?.[key]) ? candidate.content[key] : [candidate.content?.[key]])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean);
}

function detectCandidateConflicts(projectRoot, candidate, projectName) {
  validateCandidate(candidate);
  const wikiFile = CATEGORY_TO_WIKI[candidate.category];
  const filePath = join(wikiDir(projectRoot, projectName), wikiFile);
  const result = { candidate_id: candidate.id, conflicts: [] };
  if (!existsSync(filePath)) return result;

  const content = readFileSync(filePath, 'utf8');
  const keywords = (candidate.keywords || []).map(keyword => String(keyword).trim().toLowerCase()).filter(Boolean);
  const coreValues = coreCandidateValues(candidate);
  for (const entry of splitEntries(content, basename(wikiFile, '.md'))) {
    const entryText = `${entry.title}\n${entry.body.join('\n')}`.toLowerCase();
    const keyword_overlap = keywords.filter(keyword => entryText.includes(keyword));
    const scope_overlap = coreValues.filter(value => value && entryText.includes(value));
    if (keyword_overlap.length > 0 || scope_overlap.length > 0) {
      result.conflicts.push({
        entry_id: entryId(entry.title),
        file: wikiFile,
        keyword_overlap,
        scope_overlap,
        reason: keyword_overlap.length > 0 ? 'keyword overlap' : 'core scope/name overlap'
      });
    }
  }
  return result;
}

function mergeCandidate(projectRoot, candidateFile, projectName) {
  const candidate = validateCandidate(readCandidate(candidateFile), { requireConfirmed: true });
  const conflictResult = detectCandidateConflicts(projectRoot, candidate, projectName);
  if (conflictResult.conflicts.length > 0 && !candidate.decision?.override_conflict_reason) {
    throw new Error(`candidate conflicts with existing wiki entries: ${conflictResult.conflicts.map(conflict => `${conflict.file}#${conflict.entry_id}`).join(', ')}`);
  }
  const wikiFile = CATEGORY_TO_WIKI[candidate.category];

  const dir = wikiDir(projectRoot, projectName);
  const targetPath = join(dir, wikiFile);
  if (!existsSync(targetPath)) {
    process.stderr.write(`wiki file not found: ${targetPath}. Run --init first.\n`);
    process.exit(1);
  }

  let content = readFileSync(targetPath, 'utf8');
  const prefix = basename(wikiFile, '.md').toUpperCase().replace(/-/g, '_');
  const shortPrefix = { FORBIDDEN_ZONES: 'FZ', WEIRD_BUT_INTENTIONAL: 'WBI', DO_NOT_REFACTOR_YET: 'DNR', GLOSSARY: 'TERM' }[prefix] || prefix;
  const entryId = nextEntryId(content, shortPrefix);

  let entry = `\n### ${shortPrefix}-${entryId}\n\n`;
  if (candidate.content) {
    for (const [key, value] of Object.entries(candidate.content)) {
      entry += `**${key}：** ${Array.isArray(value) ? value.join(', ') : value}\n\n`;
    }
  }

  const relationMarker = '## 关联关系';
  if (content.includes(relationMarker)) {
    content = content.replace(relationMarker, entry + relationMarker);
  } else {
    content += entry + RELATION_SECTION;
  }

  const fullEntryId = `${shortPrefix}-${entryId}`;
  atomicWriteFile(targetPath, content);
  candidate.status = 'merged';
  candidate.confirmed = true;
  candidate.merge = { wiki_file: wikiFile, entry_id: fullEntryId, merged_at: new Date().toISOString() };
  writeCandidate(candidateFile, candidate);
  const ideaDir = candidateIdeaDir(candidateFile);
  if (ideaDir) {
    appendAuditLog(ideaDir, { type: 'knowledge_candidate_merged', candidate_id: candidate.id, category: candidate.category, wiki_file: wikiFile, entry_id: fullEntryId });
  }
  return { status: 'merged', file: wikiFile, entry_id: fullEntryId };
}

function listEntries(projectRoot, projectName) {
  const dir = wikiDir(projectRoot, projectName);
  if (!existsSync(dir)) return [];

  const entries = [];
  for (const [, wikiFile] of Object.entries(CATEGORY_TO_WIKI)) {
    const filePath = join(dir, wikiFile);
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, 'utf8');
    const regex = /### ([A-Z_]+-\d+|FZ-\d+|WBI-\d+|DNR-\d+|TERM-\d+)/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      entries.push({ id: match[1], file: wikiFile });
    }
  }
  return entries;
}

function addLink(projectRoot, file, entryId, relatedFile, relatedId, relationType, projectName) {
  const dir = wikiDir(projectRoot, projectName);
  const filePath = join(dir, file);
  if (!existsSync(filePath)) {
    process.stderr.write(`file not found: ${filePath}\n`);
    process.exit(1);
  }

  let content = readFileSync(filePath, 'utf8');
  const newRow = `| ${relatedFile}#${relatedId} | ${relationType} | — |\n`;

  if (content.includes('## 关联关系')) {
    const lines = content.split('\n');
    const sectionIdx = lines.indexOf('## 关联关系');
    let insertIdx = lines.length;
    for (let i = sectionIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('|')) {
        insertIdx = i + 1;
      } else if (lines[i].trim() !== '' && !lines[i].startsWith('|')) {
        break;
      }
    }
    lines.splice(insertIdx, 0, newRow.trimEnd());
    content = lines.join('\n');
  } else {
    content += RELATION_SECTION + newRow;
  }

  atomicWriteFile(filePath, content);
  return { status: 'linked', file, entry: entryId, related: `${relatedFile}#${relatedId}` };
}

function queryFiles(dir) {
  const files = QUERY_FILES.map(file => ({ rel: file, path: join(dir, file) }));
  const modulesDir = join(dir, 'modules');
  if (existsSync(modulesDir)) {
    for (const file of readdirSync(modulesDir).filter(file => file.endsWith('.md'))) {
      files.push({ rel: `modules/${file}`, path: join(modulesDir, file) });
    }
  }
  return files.filter(file => existsSync(file.path));
}

function tokenize(text) {
  return [...new Set(String(text || '')
    .toLowerCase()
    .match(/[a-z0-9_./:-]{2,}|[\p{Script=Han}]{2,}/gu) || [])]
    .filter(token => !['the', 'and', 'with', 'from', 'null', 'undefined'].includes(token));
}

function splitEntries(content, fallbackTitle) {
  const lines = content.split('\n');
  const entries = [];
  let current = null;

  for (const line of lines) {
    const heading = line.match(/^###\s+(.+)$/);
    if (heading) {
      if (current) entries.push(current);
      current = { title: heading[1].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }

  if (current) entries.push(current);
  if (entries.length === 0 && content.trim()) entries.push({ title: fallbackTitle, body: content.split('\n') });
  return entries;
}

function entryId(title) {
  const match = title.match(/\b([A-Z_]+-\d+|FZ-\d+|WBI-\d+|DNR-\d+|TERM-\d+)\b/);
  return match ? match[1] : title.split(':')[0].trim();
}

function scoreEntry(entry, file, tokens) {
  const title = entry.title.toLowerCase();
  const body = entry.body.join('\n').toLowerCase();
  const scopeLines = entry.body.filter(line => /\*\*范围[：:]/.test(line) || /路径[：:]/.test(line)).join('\n').toLowerCase();
  const matchedTerms = [];
  let score = 0;

  for (const token of tokens) {
    if (title.includes(token)) {
      score += 3;
      matchedTerms.push(token);
      continue;
    }
    if (scopeLines.includes(token) || (token.includes('/') && body.includes(token))) {
      score += 2;
      matchedTerms.push(token);
      continue;
    }
    if (body.includes(token)) {
      score += 1;
      matchedTerms.push(token);
    }
  }

  if (file.includes('forbidden') && matchedTerms.some(term => term.includes('/') || term.includes('.'))) score += 1;
  return { score, matchedTerms: [...new Set(matchedTerms)] };
}

function snippetFor(entry, matchedTerms) {
  const lines = entry.body.map(line => line.trim()).filter(Boolean);
  const matched = lines.find(line => matchedTerms.some(term => line.toLowerCase().includes(term)));
  return (matched || lines[0] || entry.title).slice(0, 200);
}

function reasonFor(entry, matchedTerms) {
  const title = entry.title.toLowerCase();
  const body = entry.body.join('\n').toLowerCase();
  const reasons = [];
  if (matchedTerms.some(term => title.includes(term))) reasons.push('title');
  if (matchedTerms.some(term => /[/.]/.test(term) && body.includes(term))) reasons.push('path');
  if (matchedTerms.some(term => body.includes(term))) reasons.push('body');
  return `matched ${reasons.length ? [...new Set(reasons)].join('/') : 'terms'}`;
}

function buildLoadPlan(matches, minScore) {
  const plan = { must_load: [], optional_load: [], skip: [] };
  for (const match of matches) {
    const item = { id: match.id, file: match.file, score: match.score, reason: match.reason };
    if (match.score >= minScore) plan.must_load.push(item);
    else if (match.score > 0) plan.optional_load.push(item);
    else plan.skip.push(item);
  }
  return plan;
}

function queryWiki(projectRoot, { text = '', limit = 10, category = '', minScore = 1, loadPlan = false, projectName } = {}) {
  const dir = wikiDir(projectRoot, projectName);
  const tokens = tokenize(text);
  const result = { status: 'ok', query: { text, limit, category, min_score: minScore, load_plan: loadPlan }, matches: [], warnings: [] };
  if (loadPlan) result.load_plan = { must_load: [], optional_load: [], skip: [] };
  if (!existsSync(dir)) return result;
  if (tokens.length === 0) {
    result.warnings.push('empty query text');
    return result;
  }

  const matches = [];
  for (const file of queryFiles(dir)) {
    const fileCategory = WIKI_TO_CATEGORY[file.rel] || (file.rel.startsWith('modules/') ? 'module' : '');
    if (category && category !== fileCategory) continue;
    const content = readFileSync(file.path, 'utf8');
    for (const entry of splitEntries(content, basename(file.rel, '.md'))) {
      const { score, matchedTerms } = scoreEntry(entry, file.rel, tokens);
      if (score <= 0) continue;
      if (score < minScore && !loadPlan) continue;
      matches.push({
        id: entryId(entry.title),
        file: file.rel,
        category: fileCategory,
        title: entry.title,
        score,
        reason: reasonFor(entry, matchedTerms),
        matched_terms: matchedTerms,
        snippet: snippetFor(entry, matchedTerms),
        load_required: score >= minScore
      });
    }
  }

  const sorted = matches.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, limit);
  result.matches = sorted.filter(match => match.score >= minScore);
  if (loadPlan) result.load_plan = buildLoadPlan(sorted, minScore);
  return result;
}

function parseCandidateStatusArgs(args) {
  const ideaDir = args[1];
  const candidateFile = args[2];
  const nextStatus = args[3];
  let reason = '';
  for (let i = 4; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--reason') reason = args[++i] || '';
    else {
      process.stderr.write(`unknown candidate-status arg: ${arg}\n`);
      process.exit(1);
    }
  }
  if (!ideaDir || !candidateFile || !nextStatus) {
    process.stderr.write('用法: wiki-manage.mjs --candidate-status <idea-dir> <candidate-file> <confirmed|rejected|deferred> --reason <reason>\n');
    process.exit(1);
  }
  return { ideaDir, candidateFile, nextStatus, reason };
}

function parseDetectConflictsArgs(args) {
  const projectRoot = args[1] || '.';
  const candidateFile = args[2];
  if (!candidateFile) {
    process.stderr.write('用法: wiki-manage.mjs --detect-conflicts <project-root> <candidate-file.json>\n');
    process.exit(1);
  }
  return { projectRoot, candidateFile };
}

function parseQueryArgs(args) {
  const projectRoot = args[1] || '.';
  const options = { text: '', limit: 10, category: '', minScore: 1, loadPlan: false };
  for (let i = 2; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--text') options.text = args[++i] || '';
    else if (arg === '--limit') options.limit = Number(args[++i] || 10);
    else if (arg === '--category') options.category = args[++i] || '';
    else if (arg === '--min-score') options.minScore = Number(args[++i] || 1);
    else if (arg === '--load-plan') options.loadPlan = true;
    else if (arg === '--json') continue;
    else {
      process.stderr.write(`unknown query arg: ${arg}\n`);
      process.exit(1);
    }
  }
  return { projectRoot, options };
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    process.stderr.write('用法: wiki-manage.mjs <--init|--merge|--list|--link|--query|--candidate-status|--candidate-list> [args...]\n');
    process.exit(1);
  }

  switch (command) {
    case '--init': {
      const projectRoot = args[1] || '.';
      const pluginRoot = args[2] || process.env.CLAUDE_PLUGIN_ROOT || '';
      const projectFlag = args.indexOf('--project');
      const projectName = projectFlag >= 0 ? args[projectFlag + 1] : undefined;
      console.log(JSON.stringify(initWiki(projectRoot, pluginRoot, projectName)));
      break;
    }
    case '--merge': {
      const projectRoot = args[1] || '.';
      const candidateFile = args[2];
      if (!candidateFile) {
        process.stderr.write('用法: wiki-manage.mjs --merge <project-root> <candidate-file.json>\n');
        process.exit(1);
      }
      console.log(JSON.stringify(mergeCandidate(projectRoot, candidateFile)));
      break;
    }
    case '--list': {
      const projectRoot = args[1] || '.';
      console.log(JSON.stringify(listEntries(projectRoot), null, 2));
      break;
    }
    case '--link': {
      const [, projectRoot, file, entryId, relatedFile, relatedId, relationType] = args;
      if (!file || !entryId || !relatedFile || !relatedId || !relationType) {
        process.stderr.write('用法: wiki-manage.mjs --link <project-root> <file> <entry-id> <related-file> <related-id> <relation-type>\n');
        process.exit(1);
      }
      console.log(JSON.stringify(addLink(projectRoot, file, entryId, relatedFile, relatedId, relationType)));
      break;
    }
    case '--candidate-status': {
      const { ideaDir, candidateFile, nextStatus, reason } = parseCandidateStatusArgs(args);
      console.log(JSON.stringify(setCandidateStatus(ideaDir, candidateFile, nextStatus, reason), null, 2));
      break;
    }
    case '--candidate-list': {
      const ideaDir = args[1];
      if (!ideaDir) {
        process.stderr.write('用法: wiki-manage.mjs --candidate-list <idea-dir>\n');
        process.exit(1);
      }
      console.log(JSON.stringify(listCandidates(ideaDir), null, 2));
      break;
    }
    case '--detect-conflicts': {
      const { projectRoot, candidateFile } = parseDetectConflictsArgs(args);
      console.log(JSON.stringify(detectCandidateConflicts(projectRoot, readCandidate(candidateFile)), null, 2));
      break;
    }
    case '--query': {
      const { projectRoot, options } = parseQueryArgs(args);
      console.log(JSON.stringify(queryWiki(projectRoot, options), null, 2));
      break;
    }
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      process.exit(1);
  }
}

export { addLink, detectCandidateConflicts, initWiki, listCandidates, listEntries, mergeCandidate, queryWiki, readCandidate, setCandidateStatus, validateCandidate };

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
