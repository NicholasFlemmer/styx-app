import { copy } from '@styx/core';
import type { AuditId } from '@styx/core';
import { Drawer } from '@styx/ui';
import { useUi } from '../../state/hooks';

export interface AuditDrawerProps {
  id: string;
  auditId: AuditId;
}

/** Placeholder until the Approvals phase implements the audit entry drawer (spec §4.8). */
export function AuditDrawer({ id }: AuditDrawerProps) {
  const popOverlay = useUi((u) => u.popOverlay);
  return (
    <Drawer heading={copy.audit.drawerTitle} onClose={() => popOverlay(id)} escapeEnabled={false}>
      <span className="t-label">{copy.audit.drawerTitle}</span>
    </Drawer>
  );
}
