import { Tab, TabRow, Tag } from '@styx/ui';

export interface FileTab {
  path: string;
  /** Agent label for files authored by an agent (rendered as a Tag), or null. */
  agent: string | null;
}

export interface FileTabsProps {
  tabs: readonly FileTab[];
  activePath: string | null;
  onSelect: (path: string) => void;
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** Editor tab row (34px): mono file tabs, current inverted, agent Tag on agent-authored files. */
export function FileTabs({ tabs, activePath, onSelect }: FileTabsProps) {
  return (
    <TabRow variant="file" aria-label="Files" data-file-tabs="true">
      {tabs.map((t) => (
        <Tab
          key={t.path}
          variant="file"
          label={basename(t.path)}
          inv={t.path === activePath}
          meta={t.agent === null ? undefined : <Tag tone="agent">{t.agent}</Tag>}
          onClick={() => onSelect(t.path)}
          data-path={t.path}
        />
      ))}
    </TabRow>
  );
}
