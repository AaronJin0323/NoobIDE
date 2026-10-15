import type { AiApi } from '../../shared/ipc/ai-contract';
import { useI18n } from '../i18n/I18nProvider';
import type { AgentApplyHost } from './agent-apply';
import { AgentPanel } from './AgentPanel';
import { useAgent } from './useAgent';

/**
 * The agent of the open project (S34.2). Mounted per project (keyed by its id), so another project starts with an
 * empty conversation and the running turn of the previous one is stopped.
 */
export function AgentRegion(props: {
  readonly api: AiApi | undefined;
  readonly host: AgentApplyHost | null;
  readonly open: boolean;
  onClose(): void;
}) {
  const { locale } = useI18n();
  const agent = useAgent({ api: props.api, host: props.host, locale });
  return (
    <AgentPanel
      agent={agent}
      available={props.api !== undefined && props.host !== null}
      open={props.open}
      onClose={props.onClose}
    />
  );
}
