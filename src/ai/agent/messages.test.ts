import { describe, expect, it } from 'vitest';
import { failedStepSummary, stepSummary } from './messages';

describe('agent step summaries never show tool ids', () => {
  it('describes a failed tool call by what it tried to do', () => {
    expect(failedStepSummary('zh-CN', 'read_file', 'index.html')).toBe('这一步没有成功（读取 index.html）');
    expect(failedStepSummary('en', 'read_file', 'index.html')).toBe('This step did not work (Read index.html)');
    expect(failedStepSummary('en', 'get_console', '')).toBe('This step did not work (Checked the preview console)');
    for (const locale of ['zh-CN', 'en'] as const) {
      expect(failedStepSummary(locale, 'read_file', 'a.html')).not.toContain('read_file');
      expect(failedStepSummary(locale, 'some_new_tool', 'a.html')).not.toContain('some_new_tool');
    }
    expect(failedStepSummary('zh-CN', 'some_new_tool', '')).toBe('这一步没有成功');
    expect(stepSummary('en', 'failed', '')).toBe('This step did not work');
  });
});
