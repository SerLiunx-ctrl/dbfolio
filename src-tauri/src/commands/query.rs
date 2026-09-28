use tauri::State;

use crate::adapters::{CellValue, QueryOutcome, RowChange};
use crate::error::{AppError, AppResult};
use crate::meta::value::DbValue;
use crate::services::grid::{self, GridRequest};
use crate::services::query::{self, ExecuteOptions, FilterCondition, SortSpec};
use crate::state::AppState;
use crate::store::HistoryEntry;

#[tauri::command]
pub async fn query_explain(
    state: State<'_, AppState>,
    task_id: Option<String>,
    session_id: String,
    database: String,
    sql: String,
) -> AppResult<QueryOutcome> {
    state.tasks.scope(task_id, async {
    let connected = state.connected(&session_id).await?;
    if state.local.get_session(&session_id).await?.read_only { crate::services::readonly::sql(connected.adapter.engine(), &sql)?; }
    let explain = crate::services::explain::explain_sql(connected.adapter.engine(), &sql)?;
    let ctx = crate::adapters::QueryContext::new();
    let outcome = crate::tasks::query(connected.adapter.as_ref(), &ctx, connected.adapter.query_page(&database, &explain, 0, 500, &ctx)).await?;
    Ok(outcome)
    }).await
}

#[tauri::command]
pub async fn cell_full_value(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    schema: Option<String>,
    table: String,
    column: String,
    keys: Vec<CellValue>,
    max_chars: Option<usize>,
) -> AppResult<Option<DbValue>> {
    let connected = state.connected(&session_id).await?;
    let adapter = connected.adapter.as_ref();
    let table_ref = match schema.as_deref().filter(|value| !value.is_empty()) {
        Some(schema) => format!(
            "{}.{}",
            adapter.quote_ident(schema),
            adapter.quote_ident(&table)
        ),
        None => {
            if adapter.engine() == crate::meta::Engine::Mysql && !database.is_empty() {
                format!(
                    "{}.{}",
                    adapter.quote_ident(&database),
                    adapter.quote_ident(&table)
                )
            } else {
                adapter.quote_ident(&table)
            }
        }
    };
    if keys.is_empty() {
        return Err(AppError::InvalidInput("缺少主键".into()));
    }
    let where_parts: Vec<String> = keys
        .iter()
        .map(|key| {
            format!(
                "{} = {}",
                adapter.quote_ident(&key.column),
                crate::adapters::render_literal(adapter.engine(), &key.value)
            )
        })
        .collect();
    let select = full_value_selection(adapter.engine(), &adapter.quote_ident(&column), max_chars);
    let sql = format!(
        "SELECT {} FROM {} WHERE {} LIMIT 1",
        select,
        table_ref,
        where_parts.join(" AND ")
    );
    adapter.fetch_full_value(&database, &sql).await
}

fn full_value_selection(engine: crate::meta::Engine, column_sql: &str, max_chars: Option<usize>) -> String {
    if let Some(limit) = max_chars {
        let limit = limit.clamp(1, 64 * 1024 * 1024);
        let length = if engine == crate::meta::Engine::Sqlite { "LENGTH" } else { "CHAR_LENGTH" };
        format!("CASE WHEN {length}({column_sql}) <= {limit} THEN {column_sql} ELSE NULL END")
    } else { column_sql.to_owned() }
}

#[cfg(test)]
mod image_read_tests {
    use super::full_value_selection;
    use crate::meta::Engine;
    #[tokio::test]
    async fn bounded_image_read_preserves_text_and_skips_large_values() {
        let pool=sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE t(v TEXT)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO t VALUES ('图片'), ('long base64 value'), (NULL)").execute(&pool).await.unwrap();
        let select=full_value_selection(Engine::Sqlite,"v",Some(2));
        let values:Vec<Option<String>>=sqlx::query_scalar(&format!("SELECT {select} FROM t ORDER BY rowid")).fetch_all(&pool).await.unwrap();
        assert_eq!(values,vec![Some("图片".into()),None,None]);
        assert_eq!(full_value_selection(Engine::Sqlite,"v",None),"v");
        for engine in [Engine::Mysql,Engine::Postgres] {
            assert!(full_value_selection(engine,"v",Some(usize::MAX)).contains("CHAR_LENGTH(v) <= 67108864"));
        }
    }
}

#[tauri::command]
pub async fn update_cell(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    schema: Option<String>,
    table: String,
    column: String,
    keys: Vec<CellValue>,
    old_value: DbValue,
    new_value: DbValue,
) -> AppResult<u64> {
    let record = state.local.get_session(&session_id).await?;
    if record.read_only {
        return Err(AppError::ReadOnly(
            "当前会话为只读模式，已阻止修改".into(),
        ));
    }
    let connected = state.connected(&session_id).await?;
    let meta = connected
        .adapter
        .introspect_table(&database, schema.as_deref(), &table)
        .await?;
    let column_types: std::collections::HashMap<String, String> = meta
        .columns
        .iter()
        .map(|item| (item.name.clone(), item.raw_type.clone()))
        .collect();
    let statement = crate::adapters::build_cell_update(
        connected.adapter.as_ref(),
        &database,
        schema.as_deref(),
        &table,
        &column,
        &keys,
        &old_value,
        &new_value,
        &column_types,
    )?;
    let affected = connected
        .adapter
        .execute_transaction(&database, &[statement])
        .await?;
    Ok(affected)
}

#[tauri::command]
pub async fn build_filter_clause(
    state: State<'_, AppState>,
    session_id: String,
    filters: Vec<FilterCondition>,
    conjunction: String,
) -> AppResult<String> {
    let connected = state.connected(&session_id).await?;
    query::build_where_clause(connected.adapter.as_ref(), &filters, &conjunction)
}

#[tauri::command]
pub async fn query_execute(
    state: State<'_, AppState>,
    task_id: Option<String>,
    session_id: String,
    database: String,
    sql: String,
    force: Option<bool>,
    limit: Option<u32>,
    sort: Option<Vec<SortSpec>>,
) -> AppResult<QueryOutcome> {
    state.tasks.scope(task_id, async {
    query::execute(
        &state,
        ExecuteOptions {
            session_id,
            database,
            sql,
            force: force.unwrap_or(false),
            limit,
            sort: sort.unwrap_or_default(),
        },
    )
    .await
    }).await
}

#[tauri::command]
pub async fn query_fetch_page(
    state: State<'_, AppState>,
    task_id: Option<String>,
    session_id: String,
    database: String,
    sql: String,
    offset: u64,
    limit: u32,
    sort: Option<Vec<SortSpec>>,
) -> AppResult<QueryOutcome> {
    state.tasks.scope(task_id, async {
    query::fetch_page(
        &state,
        &session_id,
        &database,
        &sql,
        offset,
        limit,
        &sort.unwrap_or_default(),
    )
    .await
    }).await
}

#[tauri::command]
pub async fn query_cancel(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    query::cancel(&state, &session_id).await
}

#[tauri::command]
pub async fn query_history_list(
    state: State<'_, AppState>,
    session_id: Option<String>,
    limit: Option<u32>,
) -> AppResult<Vec<HistoryEntry>> {
    state
        .local
        .list_history(session_id.as_deref(), limit.unwrap_or(50))
        .await
}

#[tauri::command]
pub async fn grid_preview_changes(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    schema: Option<String>,
    table: String,
    changes: Vec<RowChange>,
) -> AppResult<Vec<String>> {
    grid::preview(
        &state,
        &GridRequest {
            session_id,
            database,
            schema,
            table,
            changes,
        },
    )
    .await
}

#[tauri::command]
pub async fn grid_commit(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    schema: Option<String>,
    table: String,
    changes: Vec<RowChange>,
) -> AppResult<u64> {
    grid::commit(
        &state,
        &GridRequest {
            session_id,
            database,
            schema,
            table,
            changes,
        },
    )
    .await
}

#[tauri::command]
pub async fn query_history_search(state: State<'_, AppState>, session_id: Option<String>, database: Option<String>, text: String, from: Option<String>, to: Option<String>, success: Option<bool>, offset: u32) -> AppResult<Vec<HistoryEntry>> {
    state.local.search_history(session_id,database,text,from,to,success,offset).await
}
#[tauri::command]
pub async fn query_parameter_literals(state: State<'_, AppState>, session_id: String, values: std::collections::HashMap<String, DbValue>) -> AppResult<std::collections::HashMap<String,String>> {
    let record=state.local.get_session(&session_id).await?;
    values.into_iter().map(|(key,value)| query::value_literal(record.engine,&value).map(|text|(key,text))).collect()
}
