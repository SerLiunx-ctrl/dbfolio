import { Option, OptionGroup } from "@fluentui/react-components";
import type { Engine } from "../../ipc/types";
import { groupedTypeOptions } from "./columnTypes";

export function renderTypeOptions(engine: Engine, current?: string) {
  return groupedTypeOptions(engine, current).map(group => (
    <OptionGroup key={group.label} label={group.label}>
      {group.types.map(type => <Option key={type} value={type} text={type}>{type}</Option>)}
    </OptionGroup>
  ));
}
