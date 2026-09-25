import { RedisConsole } from "./RedisConsole";
import { Tab, TabList, makeStyles, tokens } from "@fluentui/react-components";
import { InfoRegular, KeyRegular, CodeRegular } from "@fluentui/react-icons";
import { useEffect, useState } from "react";
import { useObjectNavigation } from "../../stores/useObjectNavigation";
import type { RedisTab } from "../../stores/useTabStore";
import { RedisKeysView } from "./RedisKeysView";
import { RedisOverview } from "./RedisOverview";

const useStyles = makeStyles({
  wrap: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
  },
  tabBar: {
    padding: "6px 12px 0",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    flexShrink: 0,
  },
  pane: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
  },
});

interface Props {
  tab: RedisTab;
}

export function RedisWorkspace({ tab }: Props) {
  const styles = useStyles();
  const [view, setView] = useState<"keys" | "overview" | "console">("keys");
  const navigation = useObjectNavigation(state => state.request);
  useEffect(() => { if(navigation?.tabId === tab.id) setView("keys"); }, [navigation, tab.id]);

  return (
    <div className={styles.wrap}>
      <div className={styles.tabBar}>
        <TabList
          size="small"
          selectedValue={view}
          onTabSelect={(_, data) => setView(data.value as "keys" | "overview")}
        >
          <Tab value="keys" icon={<KeyRegular fontSize={14} />}>
            键浏览
          </Tab>
          <Tab value="overview" icon={<InfoRegular fontSize={14} />}>
            服务器概览
          </Tab>
          <Tab value="console" icon={<CodeRegular/>}>命令控制台</Tab>
        </TabList>
      </div>
      <div className={styles.pane} style={{ display: view === "keys" ? "flex" : "none" }}>
        <RedisKeysView tab={tab} />
      </div>
      <div className={styles.pane} style={{display:view==="console"?"flex":"none"}}><RedisConsole tab={tab}/></div>
      <div
        className={styles.pane}
        style={{ display: view === "overview" ? "flex" : "none" }}
      >
        <RedisOverview tab={tab} />
      </div>
    </div>
  );
}
