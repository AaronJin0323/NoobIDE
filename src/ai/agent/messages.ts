import type { AiErrorCode } from '../../shared/ipc/ai-contract';

/**
 * Texts the agent loop sends to the workbench in `step` and `error` events (S34.1), in the request's UI locale. They
 * name files and tools only — never file contents, console output or model text.
 */
export type AgentLocale = 'zh-CN' | 'en';

const STEPS = {
  'zh-CN': {
    list_files: (t: string) => (t ? `查看文件夹 ${t}` : '查看项目里的文件'),
    read_file: (t: string) => `读取 ${t}`,
    search_text: (t: string) => `搜索 “${t}”`,
    get_problems: () => '查看预览里的问题',
    get_console: () => '查看预览的控制台',
    refresh_preview: () => '刷新预览',
    get_page_outline: () => '查看预览里的页面结构',
    get_page_screenshot: () => '给预览截图',
    refused: (t: string) => `没能提出修改（${t}）`,
    failed: (t: string) => `这一步没有成功（${t}）`,
  },
  en: {
    list_files: (t: string) => (t ? `Looked at folder ${t}` : 'Looked at the project files'),
    read_file: (t: string) => `Read ${t}`,
    search_text: (t: string) => `Searched for “${t}”`,
    get_problems: () => 'Checked the preview’s problems',
    get_console: () => 'Checked the preview console',
    refresh_preview: () => 'Refreshed the preview',
    get_page_outline: () => 'Looked at the page in the preview',
    get_page_screenshot: () => 'Took a screenshot of the preview',
    refused: (t: string) => `Could not propose a change (${t})`,
    failed: (t: string) => `This step did not work (${t})`,
  },
} as const;

export type StepKey = keyof (typeof STEPS)['en'];

export function stepSummary(locale: AgentLocale, key: StepKey, target: string): string {
  return STEPS[locale][key](target);
}

const ERRORS: Record<AgentLocale, Partial<Record<AiErrorCode, string>> & { fallback: string }> = {
  'zh-CN': {
    cancelled: '已停止。',
    refused: 'AI 拒绝了这个请求。换一种说法试试。',
    'preview-expired': '预览的截图已经过期了，请重新添加预览。',
    'budget-exhausted':
      '这一轮用完了允许的步数、用量或时间，已停止。已经接受的修改都保留着；可以继续发一条消息让它接着做。',
    'context-too-large': '发送的内容太多了。请减少附带的文件后再试。',
    'unknown-project': '项目已经关闭。',
    unauthorized: 'API 密钥无效或没有权限。请在 设置 → AI 里检查。',
    'rate-limited': 'AI 服务暂时繁忙或已达到额度上限，请稍后再试。',
    offline: '连不上 AI 服务。请检查网络。',
    'provider-error': 'AI 服务出错了，请稍后再试。',
    fallback: 'AI 服务出错了，请稍后再试。',
  },
  en: {
    cancelled: 'Stopped.',
    refused: 'The AI declined this request. Try asking in a different way.',
    'preview-expired': 'The preview screenshot is no longer kept. Add the preview again.',
    'budget-exhausted':
      'This turn used up its allowed steps, usage or time and was stopped. Changes you accepted are kept; send another message to let it continue.',
    'context-too-large': 'Too much was attached. Remove some files from the context and try again.',
    'unknown-project': 'The project was closed.',
    unauthorized: 'The API key is not valid or not allowed. Check it in Settings → AI.',
    'rate-limited': 'The AI service is busy or your usage limit was reached. Try again later.',
    offline: 'Cannot reach the AI service. Check the network connection.',
    'provider-error': 'The AI service had a problem. Try again later.',
    fallback: 'The AI service had a problem. Try again later.',
  },
};

export function errorMessage(locale: AgentLocale, code: AiErrorCode): string {
  return ERRORS[locale][code] ?? ERRORS[locale].fallback;
}

/** Appended when the model's answer hit the output limit. */
export function cutOffNote(locale: AgentLocale): string {
  return locale === 'en' ? '(The answer was cut off because it got too long.)' : '（回答太长，被截断了。）';
}
