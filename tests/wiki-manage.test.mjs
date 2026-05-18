import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readAuditLog } from '../scripts/audit-log.mjs';
import { addLink, detectCandidateConflicts, initWiki, listEntries, mergeCandidate, queryWiki, readCandidate, setCandidateStatus } from '../scripts/wiki-manage.mjs';

const TEST_DIR = join(import.meta.dirname, '.tmp-test-wiki');
const PROJECT_NAME = 'test-project';

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function writeWiki(rel, content) {
  const path = join(TEST_DIR, '.chisel/wiki', PROJECT_NAME, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function writeFile(rel, content) {
  const path = join(TEST_DIR, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function candidate(overrides = {}) {
  return {
    id: 'fz-001',
    category: 'forbidden_zone',
    status: 'proposed',
    confirmed: false,
    source_step: 'understand:confirm',
    created_at: '2026-05-17T00:00:00.000Z',
    quality_score: 0.8,
    keywords: ['旧接口响应', 'legacy response'],
    evidence: [{ file: 'clarifications.md', line_start: 12, line_end: 12, note: '用户确认旧接口响应字段不能改' }],
    content: {
      '范围': 'src/user.ts 的旧接口响应结构',
      '原因': '旧客户端依赖当前响应字段',
      '建议': '只增加校验，不修改响应字段'
    },
    decision: null,
    merge: null,
    ...overrides
  };
}

function writeCandidate(doc = candidate(), rel = 'knowledge-candidates/fz-001.json') {
  writeFile(rel, `${JSON.stringify(doc, null, 2)}\n`);
  return join(TEST_DIR, rel);
}

describe('wiki lifecycle', () => {
  it('initializes wiki files', () => {
    initWiki(TEST_DIR, '', PROJECT_NAME);

    assert.equal(existsSync(join(TEST_DIR, `.chisel/wiki/${PROJECT_NAME}/index.md`)), true);
    assert.equal(existsSync(join(TEST_DIR, `.chisel/wiki/${PROJECT_NAME}/forbidden-zones.md`)), true);
    assert.equal(existsSync(join(TEST_DIR, `.chisel/wiki/${PROJECT_NAME}/modules`)), true);
  });

  it('updates candidate decision status with audit log', () => {
    const candidateFile = writeCandidate();
    const updated = setCandidateStatus(TEST_DIR, candidateFile, 'confirmed', '用户确认这是长期禁区');

    assert.equal(updated.status, 'confirmed');
    assert.equal(updated.confirmed, true);
    assert.equal(updated.decision.reason, '用户确认这是长期禁区');
    assert.equal(readCandidate(candidateFile).status, 'confirmed');
    const audit = readAuditLog(TEST_DIR);
    assert.equal(audit.at(-1).type, 'knowledge_candidate_decision');
    assert.equal(audit.at(-1).to, 'confirmed');
  });

  it('rejects candidate status changes without reason', () => {
    const candidateFile = writeCandidate();

    assert.throws(() => setCandidateStatus(TEST_DIR, candidateFile, 'confirmed', ''), /requires --reason/);
  });

  it('does not allow terminal candidates to transition', () => {
    const candidateFile = writeCandidate(candidate({ status: 'rejected', decision: { by: 'user', at: '2026-05-17T00:00:00.000Z', reason: '不收录' } }));

    assert.throws(() => setCandidateStatus(TEST_DIR, candidateFile, 'confirmed', '重新确认'), /invalid candidate transition/);
  });

  it('refuses to merge unconfirmed candidates', () => {
    initWiki(TEST_DIR, '', PROJECT_NAME);
    const candidateFile = writeCandidate();

    assert.throws(() => mergeCandidate(TEST_DIR, candidateFile, PROJECT_NAME), /must be confirmed/);
  });

  it('detects conflicts with existing wiki entries', () => {
    initWiki(TEST_DIR, '', PROJECT_NAME);
    writeWiki('forbidden-zones.md', '# Forbidden Zones\n\n### FZ-001\n\n**范围：** src/user.ts 的旧接口响应结构\n\n**原因：** 旧客户端依赖当前响应字段\n');
    const conflict = detectCandidateConflicts(TEST_DIR, candidate(), PROJECT_NAME);

    assert.equal(conflict.conflicts.length, 1);
    assert.equal(conflict.conflicts[0].entry_id, 'FZ-001');
  });

  it('refuses to merge conflicting candidates without override reason', () => {
    initWiki(TEST_DIR, '', PROJECT_NAME);
    writeWiki('forbidden-zones.md', '# Forbidden Zones\n\n### FZ-001\n\n**范围：** src/user.ts 的旧接口响应结构\n\n**原因：** 旧客户端依赖当前响应字段\n');
    const candidateFile = writeCandidate(candidate({ status: 'confirmed', confirmed: true, decision: { by: 'user', at: '2026-05-17T00:00:00.000Z', reason: '长期禁区' } }));

    assert.throws(() => mergeCandidate(TEST_DIR, candidateFile, PROJECT_NAME), /conflicts/);
  });

  it('allows conflicting candidates with override reason', () => {
    initWiki(TEST_DIR, '', PROJECT_NAME);
    writeWiki('forbidden-zones.md', '# Forbidden Zones\n\n### FZ-001\n\n**范围：** src/user.ts 的旧接口响应结构\n\n**原因：** 旧客户端依赖当前响应字段\n');
    const candidateFile = writeCandidate(candidate({ status: 'confirmed', confirmed: true, decision: { by: 'user', at: '2026-05-17T00:00:00.000Z', reason: '长期禁区', override_conflict_reason: '用户确认需要拆成单独条目' } }));

    const result = mergeCandidate(TEST_DIR, candidateFile, PROJECT_NAME);

    assert.equal(result.status, 'merged');
  });

  it('merges confirmed candidates and writes merge metadata', () => {
    initWiki(TEST_DIR, '', PROJECT_NAME);
    const candidateFile = writeCandidate(candidate({ status: 'confirmed', confirmed: true, decision: { by: 'user', at: '2026-05-17T00:00:00.000Z', reason: '长期禁区' } }));
    const result = mergeCandidate(TEST_DIR, candidateFile, PROJECT_NAME);

    assert.equal(result.status, 'merged');
    assert.equal(result.file, 'forbidden-zones.md');
    assert.equal(result.entry_id, 'FZ-001');
    const updated = readCandidate(candidateFile);
    assert.equal(updated.status, 'merged');
    assert.equal(updated.merge.wiki_file, 'forbidden-zones.md');
    assert.equal(updated.merge.entry_id, 'FZ-001');
    const wiki = readFileSync(join(TEST_DIR, `.chisel/wiki/${PROJECT_NAME}/forbidden-zones.md`), 'utf8');
    assert.match(wiki, /src\/user\.ts/);
    const audit = readAuditLog(TEST_DIR);
    assert.equal(audit.at(-1).type, 'knowledge_candidate_merged');
  });

  it('lists entries and adds links', () => {
    writeWiki('forbidden-zones.md', '# Forbidden Zones\n\n### FZ-001\n\nBody\n\n## 关联关系\n\n| 关联条目 | 关系类型 | 说明 |\n|---------|---------|------|\n');
    const entries = listEntries(TEST_DIR, PROJECT_NAME);
    addLink(TEST_DIR, 'forbidden-zones.md', 'FZ-001', 'glossary.md', 'TERM-001', 'defines', PROJECT_NAME);

    assert.deepEqual(entries, [{ id: 'FZ-001', file: 'forbidden-zones.md' }]);
    const wiki = readFileSync(join(TEST_DIR, `.chisel/wiki/${PROJECT_NAME}/forbidden-zones.md`), 'utf8');
    assert.match(wiki, /glossary\.md#TERM-001/);
  });
});

describe('wiki query', () => {
  it('returns empty matches when wiki is missing', () => {
    const result = queryWiki(TEST_DIR, { text: 'order status', limit: 10, projectName: PROJECT_NAME });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.matches, []);
  });

  it('returns empty matches when no entry matches', () => {
    writeWiki('glossary.md', '# Glossary\n');
    const result = queryWiki(TEST_DIR, { text: '完全不存在的业务词', limit: 10, projectName: PROJECT_NAME });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.matches, []);
  });

  it('matches forbidden zone by path and term', () => {
    writeWiki('forbidden-zones.md', `# Forbidden Zones

### FZ-001: 旧订单状态机

**范围：** src/order/status-machine.ts

**原因：** 老客户依赖 order status 行为。
`);

    const result = queryWiki(TEST_DIR, { text: '修改 src/order/status-machine.ts order status', limit: 10, projectName: PROJECT_NAME });
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].id, 'FZ-001');
    assert.equal(result.matches[0].file, 'forbidden-zones.md');
    assert.ok(result.matches[0].score > 0);
    assert.ok(result.matches[0].matched_terms.includes('src/order/status-machine.ts'));
  });

  it('matches glossary entries by term', () => {
    writeWiki('glossary.md', `# Glossary

### TERM-001: Entitlement

**定义：** Entitlement 表示客户权益，不等同于订阅。
`);

    const result = queryWiki(TEST_DIR, { text: 'Entitlement 校验逻辑', limit: 10, projectName: PROJECT_NAME });
    assert.equal(result.matches[0].id, 'TERM-001');
    assert.equal(result.matches[0].file, 'glossary.md');
  });

  it('filters by category and min score', () => {
    writeWiki('forbidden-zones.md', `# Forbidden Zones

### FZ-001: 用户响应结构

**范围：** src/user.ts

**原因：** 用户响应结构被旧客户端依赖。
`);
    writeWiki('glossary.md', `# Glossary

### TERM-001: 用户

**定义：** 用户领域对象。
`);

    const result = queryWiki(TEST_DIR, { text: '用户 src/user.ts', category: 'forbidden_zone', minScore: 2, limit: 10, projectName: PROJECT_NAME });

    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].category, 'forbidden_zone');
    assert.ok(result.matches[0].score >= 2);
  });

  it('returns load plan when requested', () => {
    writeWiki('forbidden-zones.md', `# Forbidden Zones

### FZ-001: 用户响应结构

**范围：** src/user.ts

**原因：** 用户响应结构被旧客户端依赖。
`);
    writeWiki('glossary.md', `# Glossary

### TERM-001: 用户

**定义：** 用户领域对象。
`);

    const result = queryWiki(TEST_DIR, { text: '用户 src/user.ts', minScore: 4, loadPlan: true, limit: 10, projectName: PROJECT_NAME });

    assert.ok(result.load_plan.must_load.some(item => item.id === 'FZ-001'));
    assert.ok(result.load_plan.optional_load.some(item => item.id === 'TERM-001'));
  });
});
