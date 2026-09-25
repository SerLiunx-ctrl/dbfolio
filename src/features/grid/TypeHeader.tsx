import type { IHeaderParams } from "ag-grid-community";
import { ChevronDownRegular, ChevronUpRegular } from "@fluentui/react-icons";

interface TypeHeaderParams extends IHeaderParams {
  columnType?: string;
}

export function TypeHeader(props: IHeaderParams) {
  const params = props as TypeHeaderParams;
  const columnType = params.columnType;
  const sort = props.column.getSort();
  const sortable = Boolean(props.enableSorting);
  const typeGroup = /int|decimal|numeric|float|double|real|money/i.test(columnType ?? "") ? "number"
    : /date|time/i.test(columnType ?? "") ? "date"
    : /json|xml|blob|binary|bytea/i.test(columnType ?? "") ? "document" : "text";

  return (
    <div
      className="dw-type-header"
      data-type={typeGroup}
      onClick={(event) => {
        if (!sortable) return;
        event.stopPropagation();
        props.progressSort(event.shiftKey);
      }}
      style={{
        cursor: sortable ? "pointer" : "default",
        userSelect: "none",
        display: "flex",
        flexDirection: "column",
        lineHeight: 1.15,
        padding: "2px 0",
        overflow: "hidden",
        width: "100%",
      }}
    >
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: "2px",
          minWidth: 0,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
          {props.displayName}
        </span>
        {sort === "asc" ? (
          <ChevronUpRegular fontSize={10} />
        ) : sort === "desc" ? (
          <ChevronDownRegular fontSize={10} />
        ) : null}
      </span>
      {columnType ? (
        <span
          className="dw-type-label"
          style={{
            fontSize: "9px",
            fontWeight: 400,
            opacity: 0.6,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {columnType}
        </span>
      ) : null}
    </div>
  );
}
