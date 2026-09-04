import { copy } from '@styx/core';
import type { AskId, SessionId } from '@styx/core';
import { Sheet, SheetAccentHeader } from '@styx/ui';
import { useUi } from '../../state/hooks';

export interface GrantSheetProps {
  id: string;
  sessionId: SessionId;
  askId: AskId;
}

/** Placeholder until the Workspace phase implements the grant sheet (spec §4.1). */
export function GrantSheet({ id }: GrantSheetProps) {
  const popOverlay = useUi((u) => u.popOverlay);
  return (
    <Sheet
      header={<SheetAccentHeader label={copy.grantSheet.title} />}
      title={copy.accessRequest.title}
      onClose={() => popOverlay(id)}
      escapeEnabled={false}
    >
      <span className="t-label">{copy.grantSheet.scopeLabel}</span>
    </Sheet>
  );
}
