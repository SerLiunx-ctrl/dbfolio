import { Option, OptionGroup } from "@fluentui/react-components";
import type { DataTypeCatalog, Engine } from "../../ipc/types";
import { availableTypeOptions, typeOptionText } from "./columnTypes";

export function renderTypeOptions(engine: Engine, current?: string, catalog?:DataTypeCatalog) {
  const options=availableTypeOptions(engine,catalog,current);
  return [...new Set(options.map(t=>t.category))].map(group => (
    <OptionGroup key={group} label={group}>
      {options.filter(t=>t.category===group).map(type => <Option key={type.name} value={type.name} text={typeOptionText(type)} disabled={type.unavailable}>{typeOptionText(type)}</Option>)}
    </OptionGroup>
  ));
}
