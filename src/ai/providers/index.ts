import type { ProviderFactory } from './provider';
import { createAnthropicProvider } from './anthropic';
import { createOpenAiProvider } from './openai';

/** The real providers (main process only). Tests and e2e use ../fake-provider.ts instead. */
export const realProviderFactory: ProviderFactory = (provider, apiKey) =>
  provider === 'anthropic' ? createAnthropicProvider(apiKey) : createOpenAiProvider(apiKey);
