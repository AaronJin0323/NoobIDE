import { describe, expect, it } from 'vitest';
import { ModelPortError, type AgentMessage } from '../agent/model-port';
import { toModelPortError, toProviderMessages } from './model-port-adapter';
import { ProviderError } from './provider';

/** S31 ↔ S34: agent messages to provider messages, opaque blocks and error codes. */
describe('ModelPort adapter', () => {
  it('maps tool results to one tool message in call order and keeps only this provider’s opaque blocks', () => {
    const native = [{ type: 'thinking', thinking: '', signature: 's' }];
    const messages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'add a page' }] },
      {
        role: 'assistant',
        content: [
          { type: 'provider', provider: 'anthropic', data: native },
          { type: 'provider', provider: 'openai', data: { id: 'rs_1' } },
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.html' } },
          { type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'b.html' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 't1', content: 'A', isError: false },
          { type: 'tool_result', toolUseId: 't2', content: 'missing', isError: true },
        ],
      },
    ];
    expect(toProviderMessages('anthropic', messages)).toEqual([
      { role: 'user', text: 'add a page' },
      {
        role: 'assistant',
        text: 'Reading.',
        toolCalls: [
          { id: 't1', name: 'read_file', input: { path: 'a.html' } },
          { id: 't2', name: 'read_file', input: { path: 'b.html' } },
        ],
        native: { provider: 'anthropic', content: native },
      },
      {
        role: 'tool',
        results: [
          { callId: 't1', content: 'A' },
          { callId: 't2', content: 'missing', isError: true },
        ],
      },
    ]);
    expect(toProviderMessages('openai', messages)[1]).toMatchObject({ native: { provider: 'openai' } });
  });

  it('maps provider errors to model port errors', () => {
    expect(toModelPortError(new ProviderError('rate-limited', 'x')).code).toBe('rate-limited');
    expect(toModelPortError(new ProviderError('cancelled', 'x')).code).toBe('cancelled');
    expect(toModelPortError(new ProviderError('model-not-found', 'x')).code).toBe('provider-error');
    expect(toModelPortError(new Error('boom')).code).toBe('provider-error');
    const own = new ModelPortError('offline', 'x');
    expect(toModelPortError(own)).toBe(own);
  });
});
