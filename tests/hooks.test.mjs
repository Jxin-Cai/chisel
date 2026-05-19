import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const HOOKS_DIR = join(import.meta.dirname, '..', 'hooks');
const TEST_DIR = join(import.meta.dirname, '.tmp-test-hooks');

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function runHook(scriptName, stdinJson, cwd) {
  const cmd = `echo '${JSON.stringify(stdinJson).replace(/'/g, "'\\''")}' | node ${join(HOOKS_DIR, scriptName)}`;
  try {
    return execSync(cmd, { cwd: cwd || TEST_DIR, encoding: 'utf8', timeout: 5000 });
  } catch (e) {
    return e.stdout || '';
  }
}

function setupIdeaDir(ideaName, currentStep) {
  const ideaDir = join(TEST_DIR, '.chisel', ideaName);
  mkdirSync(join(ideaDir, 'confirmations'), { recursive: true });
  writeFileSync(join(ideaDir, 'workflow-state.yaml'), [
    `idea: ${ideaName}`,
    `started_at: 2025-01-01T00:00:00Z`,
    `last_updated_at: 2025-01-01T00:00:00Z`,
    `current_step: ${currentStep}`,
    ''
  ].join('\n'));
  return ideaDir;
}

// --- workflow-snapshot.mjs ---

describe('workflow-snapshot.mjs', () => {
  it('outputs no-workflow when .chisel does not exist', () => {
    const out = execSync(`node ${join(HOOKS_DIR, 'workflow-snapshot.mjs')}`, { cwd: TEST_DIR, encoding: 'utf8' });
    assert.match(out, /无活跃工作流/);
  });

  it('shows active workflow with step', () => {
    setupIdeaDir('test-idea', 'implement:code');
    const out = execSync(`node ${join(HOOKS_DIR, 'workflow-snapshot.mjs')}`, { cwd: TEST_DIR, encoding: 'utf8' });
    assert.match(out, /test-idea/);
    assert.match(out, /implement:code/);
  });

  it('skips done workflows', () => {
    const ideaDir = setupIdeaDir('done-idea', 'done');
    writeFileSync(join(ideaDir, '.done'), '');
    const out = execSync(`node ${join(HOOKS_DIR, 'workflow-snapshot.mjs')}`, { cwd: TEST_DIR, encoding: 'utf8' });
    assert.match(out, /无活跃工作流/);
  });

  it('shows task summary when task-workflow-state exists', () => {
    setupIdeaDir('task-idea', 'review:cr');
    const ideaDir = join(TEST_DIR, '.chisel', 'task-idea');
    writeFileSync(join(ideaDir, 'task-workflow-state.yaml'), [
      'idea: task-idea',
      'tasks:',
      '  task-001:',
      '    status: approved',
      '  task-002:',
      '    status: coding',
      ''
    ].join('\n'));
    const out = execSync(`node ${join(HOOKS_DIR, 'workflow-snapshot.mjs')}`, { cwd: TEST_DIR, encoding: 'utf8' });
    assert.match(out, /approved=1/);
    assert.match(out, /coding=1/);
  });
});

// --- session-start.mjs ---

describe('session-start.mjs', () => {
  it('shows banner when no workflows exist', () => {
    const out = execSync(`node ${join(HOOKS_DIR, 'session-start.mjs')}`, { cwd: TEST_DIR, encoding: 'utf8' });
    assert.match(out, /chisel plugin is available/);
    assert.match(out, /\/chisel/);
  });

  it('shows iron rules reminder when workflow exists', () => {
    setupIdeaDir('active-idea', 'plan:strategy');
    const out = execSync(`node ${join(HOOKS_DIR, 'session-start.mjs')}`, { cwd: TEST_DIR, encoding: 'utf8' });
    assert.match(out, /chisel plugin is available/);
    assert.match(out, /active-idea/);
    assert.match(out, /IRON RULES REMINDER/);
    assert.match(out, /orchestration-status/);
  });
});

// --- pre-tool-write-guard.mjs ---

describe('pre-tool-write-guard.mjs', () => {
  it('allows writes to non-chisel paths silently', () => {
    const out = runHook('pre-tool-write-guard.mjs', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: 'src/main.js', content: '// code' },
      cwd: TEST_DIR
    });
    assert.equal(out.trim(), '');
  });

  it('denies direct write to task-workflow-state.yaml', () => {
    setupIdeaDir('guard-test', 'implement:code');
    const out = runHook('pre-tool-write-guard.mjs', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '.chisel/guard-test/task-workflow-state.yaml', content: 'hack' },
      cwd: TEST_DIR
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /workflow-status\.mjs/);
  });

  it('denies confirmation write during non-confirm step', () => {
    setupIdeaDir('guard-test2', 'implement:code');
    const out = runHook('pre-tool-write-guard.mjs', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '.chisel/guard-test2/confirmations/as-is.json', content: '{}' },
      cwd: TEST_DIR
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /confirm steps/);
  });

  it('allows confirmation write during confirm step', () => {
    setupIdeaDir('guard-test3', 'understand:confirm');
    const out = runHook('pre-tool-write-guard.mjs', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '.chisel/guard-test3/confirmations/as-is.json', content: '{}' },
      cwd: TEST_DIR
    });
    // Should either be empty (no output = allow) or explicit allow
    if (out.trim()) {
      const parsed = JSON.parse(out);
      assert.notEqual(parsed.hookSpecificOutput.permissionDecision, 'deny');
    }
  });

  it('allows and injects context for other chisel paths', () => {
    setupIdeaDir('guard-test4', 'understand:explore');
    const out = runHook('pre-tool-write-guard.mjs', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '.chisel/guard-test4/as-is/overview.md', content: '# Overview' },
      cwd: TEST_DIR
    });
    if (out.trim()) {
      const parsed = JSON.parse(out);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'allow');
      assert.ok(parsed.hookSpecificOutput.additionalContext);
    }
  });

  it('ignores wiki directory paths', () => {
    const out = runHook('pre-tool-write-guard.mjs', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '.chisel/wiki/project/glossary.md', content: '# Glossary' },
      cwd: TEST_DIR
    });
    assert.equal(out.trim(), '');
  });
});

// --- post-tool-write-reminder.mjs ---

describe('post-tool-write-reminder.mjs', () => {
  it('injects gate-check reminder for as-is deliverable', () => {
    setupIdeaDir('reminder-test', 'understand:explore');
    const out = runHook('post-tool-write-reminder.mjs', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '.chisel/reminder-test/as-is/overview.md' },
      tool_response: { success: true },
      cwd: TEST_DIR
    });
    const parsed = JSON.parse(out);
    assert.match(parsed.hookSpecificOutput.additionalContext, /gate-check/);
  });

  it('injects confirmation reminder for confirmations write', () => {
    setupIdeaDir('reminder-test2', 'understand:confirm');
    const out = runHook('post-tool-write-reminder.mjs', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '.chisel/reminder-test2/confirmations/as-is.json' },
      tool_response: { success: true },
      cwd: TEST_DIR
    });
    const parsed = JSON.parse(out);
    assert.match(parsed.hookSpecificOutput.additionalContext, /确认/);
  });

  it('does nothing for non-chisel paths', () => {
    const out = runHook('post-tool-write-reminder.mjs', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: 'src/main.js' },
      tool_response: { success: true },
      cwd: TEST_DIR
    });
    assert.equal(out.trim(), '');
  });

  it('injects reminder for task-reports', () => {
    setupIdeaDir('reminder-test3', 'implement:code');
    const out = runHook('post-tool-write-reminder.mjs', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '.chisel/reminder-test3/task-reports/task-001-report.md' },
      tool_response: { success: true },
      cwd: TEST_DIR
    });
    const parsed = JSON.parse(out);
    assert.match(parsed.hookSpecificOutput.additionalContext, /gate-check/);
  });
});
