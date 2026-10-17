/**
 * Messages of the S47 motion and detail work (M18 Track A). Kept in their own file and spread into zh-CN.ts / en.ts.
 */
export const motionZhCN = {
  // ── S47.2 AI 回答里的步骤折叠 ──
  'ai.chat.steps': 'AI 的操作步骤',
  'ai.chat.stepsHeld': '回答完成前步骤保持展开',
};

export const motionEn: Record<keyof typeof motionZhCN, string> = {
  'ai.chat.steps': 'What the AI did',
  'ai.chat.stepsHeld': 'The steps stay open until the answer is complete',
};
