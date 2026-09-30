<p align="center">
  <img src="public/app-icon.svg" alt="DBFolio icon" width="80" />
</p>

# DBFolio

[简体中文](README.md) · [English](README.en.md)

DBFolio is a Windows desktop database workbench for managing connections, writing SQL, editing data and table structures, comparing and synchronizing databases, and exploring or exporting results in one place.

Built with **Tauri 2, React, TypeScript, and Rust**, it supports **MySQL, PostgreSQL, SQLite, Redis, and MongoDB** and is released under the **MIT License**.

> DBFolio is under active development, with Windows as its primary development and validation platform. The five engines share interaction patterns, but their supported operations and maturity differ. Read the [capabilities and limitations](#support) before writing, synchronizing, or exporting important data.

> The Task Center tracks background work such as imports, exports, synchronization, data generation, and AI jobs. Ordinary queries show results and cancellation controls in their query tab. Index and foreign-key metadata use type-aware colors, and DDL uses the same SQL highlighting as the query editor.

**Contents**

[Why DBFolio](#why) · [Screenshots](#screenshots) · [Features](#features) · [Support](#support) · [Quick start](#quick-start) · [Development](#development) · [Local data](#local-data) · [Project layout](#project-structure) · [Contributing](#contributing) · [License](#license)

<a id="why"></a>
## Why DBFolio

- **One workspace for daily database work:** Sessions, the object browser, queries, table data, schemas, analysis, synchronization, and background progress share a tabbed workspace.
- **Inspect changes before writing:** Grid edits are staged. Before submission, you can inspect row-level differences and SQL, then choose which rows to submit. Schema changes and synchronization also show a plan first.
- **Safer environment switching:** Group and copy sessions, mark environments, and keep production sessions read-only by default. MySQL sessions can restrict which databases this client displays and operates on.
- **Local-first operation:** No account or companion server is required. AI is optional and uses a service that you configure.
- **Compact desktop UI:** Light, dark, and OLED themes, accent colors, layout and motion settings, plus keyboard shortcuts for common actions.

<a id="screenshots"></a>
## Screenshots

### Table structure

Double-click a cell to edit a field in place. Structure, indexes, foreign keys, and DDL live in the table tab; changes are staged until saved.

![DBFolio table structure and field editing](docs/screenshots/table-structure.png)

### Table data

The compact grid shows column types and supports pagination, filters, and row changes that can be reviewed before submission.

![DBFolio table data browser](docs/screenshots/table-data.png)

### SQL editor

The editor provides syntax highlighting, selected-SQL execution, formatting, and optional AI assistance. The screenshot shows actions for a SQL selection.

![DBFolio SQL editor](docs/screenshots/sql-editor.png)

### MongoDB documents

Filter, projection, and sort controls sit above the document list, with details on the right. Credential contents in this screenshot were replaced with sample data.

![DBFolio MongoDB document browser](docs/screenshots/mongodb-documents.png)

### Redis overview

Server, client, memory, and other Redis metrics are grouped for scanning. Switch logical databases and browse keys from the sidebar.

![DBFolio Redis server overview](docs/screenshots/redis-overview.png)

<a id="features"></a>
## Features

### Session management

- Organize connections in groups, mark environments, duplicate sessions, and save favorites.
- Drop a SQLite database file onto the window or the new-session form to prefill the engine, path, and session name. Save to create the session; the original file is neither copied nor modified. One file is accepted at a time, including SQLite files without an extension. Duplicate suggested names receive a numeric suffix, while manually entered names are preserved.
- Use single-hop SSH, host fingerprint confirmation, TLS certificate and server-name verification, separate connection and query timeouts, and phased connection diagnostics.
- Reorder tabs by dragging, show tabs on multiple rows, reopen recently closed tabs, customize the workspace, use Quick Open, or enter focus mode.
- Production-marked sessions start read-only; turning that off requires confirmation. MySQL sessions can limit visible databases, subject to server permissions and the configured scope.
- Preferences show local storage use and history counts, and allow history limits, cleanup, and local database compaction.

### SSH, TLS, and connection diagnostics

Open **Connection security and timeouts** while creating or editing a session:

1. Enter the database address as reachable from the SSH host, then provide SSH host, user, and password or private-key path. Compare the retrieved SHA-256 fingerprint with the one supplied by your administrator before trusting it. Changing the host or port clears trust; a mismatch blocks the connection.
2. For MySQL/PostgreSQL, choose an SSL mode: `prefer` may fall back to plaintext, `require` enforces encryption, `verify-ca` checks the certificate chain, and `verify-full` also checks the database server name. Database identity is still checked through an SSH tunnel.
3. Redis/MongoDB single-host TLS verifies the certificate chain and server name, with optional CA and client PEM files. MongoDB URI/SRV connections are direct; client authentication needs a combined certificate-and-key PEM with the separate key field empty. SSH uses single-host mode rather than discovering an entire replica set.
4. Connection timeout defaults to 15 seconds (range 1–120), and query wait timeout to 60 seconds (range 1–3600). A client timeout does **not** mean the server rolled back a statement or that it is safe to retry automatically. Bulk jobs have their own cancellation and timeout behavior.
5. Inspect timing and results by diagnostic phase. Access to a default database does not imply permission for every object or write operation.

SSH passwords and private-key passphrases are stored in Windows Credential Manager. Leaving them blank when editing retains the existing value; clearing them requires the corresponding option. The configuration database stores paths and fingerprints, so key and certificate files must remain readable at their original paths. Multi-hop SSH, proxy chains, and SSH agent are not supported yet. See the [R04 verification record](docs/verification/r04.md).

### Creating relational tables

Choose **New Table** from a database's context menu to open a dedicated **New Table*** tab. Enter the name, comment, and supported table options on the Info page. Add and edit columns in place on Structure; stage indexes and foreign keys in their own pages; inspect the generated SQL on DDL. Saving creates the table and turns the draft tab into its normal table view, including Data. Failed saves retain the draft. MySQL, PostgreSQL, and SQLite are supported. Unsaved drafts can be discarded, and closing one prompts for handling.

### Queries and data editing

- The SQL editor has highlighting, formatting, table/column completion, current-statement or selection execution, results, history, and execution plans.
- Open and save SQL files and keep local drafts. MySQL, PostgreSQL, and SQLite query tabs support manual transactions for supported single statements and DML.
- Database overviews list tables and views with estimated rows, sizes, engines, and comments. Table data supports pagination, sorting, and combined filters. The maximum page size is configurable from 1 to 5,000 rows (default 200); suggested filter values come only from **currently loaded rows**.
- Add, change, or delete grid rows, review the before/after values and SQL, then submit selected staged rows. Results that cannot be located reliably, such as those without a suitable primary key, remain read-only.
- Inspect table information, columns, indexes, foreign keys, and DDL. MySQL, PostgreSQL, and SQLite share double-click inline editing and Save/Discard behavior for column names, types, length/set, nullability, and defaults. Comments, auto-increment, unsigned values, and `ON UPDATE` follow engine capabilities. SQLite uses transactional table rebuilding when needed, preserving dependencies and rolling back on failure. MySQL table properties offer server-supported engine, charset, and collation choices.
- Recognizable Base64 bitmap strings may show a thumbnail; open the full image or source text, switch to native size, or export the original bytes. Truncated values are fetched again only within a bounded primary-key-based table-data flow. Unrecognized, unreadable, or oversized values remain text. See [image-preview limits](docs/verification/base64-images-alpha5.md).
- Save a snapshot of the current result for comparison with a later result. Configure business relationships between fields to jump to related records.

### Data and schema synchronization

- Choose source and target sessions, databases, and tables in a dedicated tab; compare schema and data separately, then review the plan before execution.
- MySQL schema synchronization can select column, index, foreign-key, and some table-property differences; it checks the target schema again before applying changes. PostgreSQL and SQLite schema coverage is narrower.
- Data synchronization compares primary keys and writes in batches. Source tables can be filtered. Deleting target-only rows is off by default and cannot be combined with a filtered source.
- Supported directions are **MySQL → MySQL**, **PostgreSQL → PostgreSQL**, and **SQLite → SQLite** only. Data writes generate reversal material; **schema synchronization has no automatic rollback**.

### Data analysis

- Create charts from a snapshot of the current query result or write a query in a separate analysis tab. MongoDB aggregation results can also be charted.
- Choose bar, horizontal bar, line, area, pie, donut, scatter, histogram, or metric-card views. Configure categories, values, aggregation, and ordering, then inspect category details.
- Apply business names or column comments, save and rerun plans, and export PNG, chart CSV, or data JSON.

### AI assistance and test data

- Describe a query in natural language and use `@` to reference tables or columns. Generated SQL is placed in the editor; it is **never executed automatically**.
- AI formatting and optimization can work on a SQL selection, with syntax checks before and after generation. Review every suggestion before use.
- Generate test data using local rules/templates or a configured AI service; preview before export or database insertion.
- AI is optional. Normal database work does not require an AI service.

### Files and engine-specific tools

- Import CSV/TSV text into relational tables. Export the current or all pages of table/query data as CSV, JSON, or Excel (`.xlsx`).
- MySQL SQL-file import has its own tab with encoding selection, streaming preflight, database-switch/create/drop warnings, statement-by-statement execution, and a local report. It supports `DELIMITER` and stored programs. It stops on errors by default; cancellation takes effect between statements, and disconnected outcomes are marked for verification.
- MySQL SQL export covers tables, views, procedures, functions, triggers, and events. Export structure, data, or both; configure database charset/collation, target mapping, `DEFINER` handling, a single file, split files, or ZIP. Import/export profiles are local and do not store passwords, file contents, or filter values.
- Manage MySQL views, procedures, functions, triggers, and events with search, definition editing, change previews, create/alter/delete operations, dependency hints, view previews, and procedure parameters/results. The event scheduler status and table-trigger entry are shown.
- Redis offers key scanning/search, common value/member editing, TTL, bulk deletion, and a command console.
- MongoDB offers collection/document browsing and editing, collection statistics, indexes, field sampling, read-only aggregation, and Extended JSON array/JSON Lines transfer. Import inserts new documents only.

<a id="support"></a>
## Capabilities and limitations

| Engine | Main capabilities | Current limits |
|---|---|---|
| MySQL | Queries, data/schema editing, analysis, same-engine sync, SQL import/export, five object types | Import/object/full-export flows were tested on MySQL 8.4.6. Stored programs are edited as SQL definitions, not in a visual flow designer. |
| PostgreSQL | Queries, data/schema editing, analysis, same-engine sync | Some primary-key, index, and foreign-key rebuilds require manual SQL. |
| SQLite | Local database files, queries, data and inline schema editing, analysis, same-engine sync | Column changes on Structure use transactional rebuilding; foreign-key editing, unusual column definitions, and schema-sync rebuilding still need manual handling. |
| Redis | Keys, TTL, command console, test-data generation | Not included in relational schema/data sync. |
| MongoDB | Collections/documents, aggregation, indexes, JSON/JSONL transfer, analysis | Not included in relational sync; import inserts only. |

The UI exposes operations according to engine, object type, and read-only state. Keep these boundaries in mind:

- **Client safeguards have a limited scope.** Read-only mode, dangerous-SQL checks, and MySQL database scoping reduce mistakes; they are not a complete SQL sandbox or a replacement for server permissions and backups. Use least-privilege database accounts for production.
- **Review synchronization first.** Data sync skips tables without primary keys. Applied schema DDL is not automatically undone; SQLite schema synchronization does not rebuild tables (the separate Structure editor does). Reversal SQL for data sync is saved under `%APPDATA%\data-workbench\sync-backups\<task-id>` and is not a database backup.
- **Displayed data may be partial.** Overview row counts are metadata estimates. Filter suggestions come from loaded rows, and charts/result comparisons use their current input range. Chart calculations use floating-point approximations, not financial-grade precision.
- **Validate against your server.** Coverage does not imply every server version or configuration has been tested. Try writes, schema changes, and sync in a test environment before using them on important data.

<a id="quick-start"></a>
## Quick start

### Requirements

- Windows desktop, primarily Windows 10/11.
- Microsoft Edge WebView2 Runtime.
- A reachable database server or a local SQLite file.

Download the Windows installer (`setup.exe`) or portable ZIP (`portable.zip`) from the repository's **Releases** page when published, or [build from source](#development). Extract the *entire* portable ZIP before launching `DBFolio.exe`; WebView2 is still required.

### First run

1. Use **File → New Connection**, select an engine, and enter connection details. For SQLite, choose a file or drop it onto the window to prefill a new session.
2. Set the environment and read-only mode. For MySQL, optionally restrict the session to named databases.
3. Test and save the connection. Select a database to inspect its tables/views, open a table, or create a query. Press `Ctrl+Enter` to execute the current statement or selected SQL.
4. After editing table data, review pending row changes and SQL before selecting rows to submit. Deleting a row also requires submission.
5. For charts, plot the current query result or create an analysis. For synchronization, use **Tools → Data Sync**, choose two sessions of the same engine, and verify the plan.

Configure an AI service in **File → Preferences** before using AI generation. Generated SQL needs human review and explicit execution.

### MySQL SQL files and database objects

1. On a MySQL session, open **File → Import SQL File** (also available on a database's context menu). Choose the target, file, and encoding; run preflight; review scope; confirm; and choose a report directory.
2. Use **File → MySQL Database Objects** or the database context menu to manage views, procedures, functions, triggers, and events. Edit one `CREATE` definition and review its diff. Do not include `DELIMITER` or extra statements in an object definition.
3. In **Export SQL File**, select a database or objects and their types. For another target database, set the restore mapping. Keeping `DEFINER` requires the target account and privileges. Extract ZIP exports and import split files in numeric order.
4. Profiles are saved locally; recheck the target and object selection when reusing one. Invalid tables or filter columns block export.

SQL-file import is limited to 64 MiB per statement and a 30-minute preflight snapshot. It does not support `SOURCE`, shell commands, client connection switching, or `NO_BACKSLASH_ESCAPES`/`ANSI_QUOTES` modes. Cancellation does not undo applied DDL or committed data; an interrupted connection may leave partial writes, which are not retried automatically. MySQL object replacement can use `DROP + CREATE`, so keep the original definition available. See the [R01–R03 verification record](docs/verification/r01-r03.md).

Useful shortcuts: `Ctrl+P` for Quick Open and commands, `Ctrl+Enter` to execute SQL, `Ctrl+S` to save a SQL file, `Ctrl+,` for preferences, and `Ctrl+B` to toggle the session sidebar. The complete list is in Preferences.

<a id="development"></a>
## Develop from source

### Prerequisites

- Node.js **22.12 or newer** and npm.
- Rust stable and Cargo (currently using MSVC toolchain 1.98.1).
- Visual Studio 2022 Build Tools with **Desktop development with C++** and Windows SDK.
- Microsoft Edge WebView2 Runtime.
- `%USERPROFILE%\.cargo\bin` on `PATH`.

Run commands in PowerShell from the project root. Keep both npm and Cargo lockfiles. The UI uses React, TypeScript, and Fluent UI v9; Tauri 2, Rust, and sqlx implement the desktop/database layers.

### Install and run

```powershell
npm ci
npm run tauri dev
```

The first launch downloads and compiles Rust dependencies and may take some time. `npm run dev` starts only the frontend server; use `npm run tauri dev` for database features.

`src-tauri/vendor/sqlx-mysql` contains a minimal local SQLx 0.8.6 patch that distinguishes `_bin` text from actual binary fields using the server charset ID. Keep it when building; see the [patch notes](src-tauri/vendor/sqlx-mysql/DBFOLIO-PATCH.md).

### Build and check

```powershell
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Tests requiring an external database need their own test environment. Skipped integration tests do not prove a service has passed validation.

### Build the Windows installer and portable edition

```powershell
npm run app:build        # Installer + portable folder/ZIP, with LTO
npm run app:portable     # Release portable edition only
npm run app:build:fast   # Development portable folder/ZIP, without LTO
```

Public versions start at `1.0.0-alpha`, followed by `1.0.0-alpha.1`, `1.0.0-alpha.2`, and so on. Release artifacts are stored under `release/<version>/`: an NSIS setup EXE, a complete portable directory, a portable ZIP, and separate setup/portable SHA-256 manifests. Development portable builds use a `portable-fast` suffix and their own manifest. The scripts currently target Windows x64 MSVC.

**DBFolio is not distributed as a single-file EXE.** Frontend resources live in `web/` beside `DBFolio.exe`; keep the whole portable directory together. Startup verifies resource integrity and version consistency. The installer uses NSIS for the current user; the portable ZIP does not bundle WebView2.

For a manual portable update, exit DBFolio and replace the application directory with a complete new version. User sessions and credentials live outside that directory. **Online updates are not implemented yet**; neither Windows code signing nor update signing is configured.

<a id="local-data"></a>
## Local data and privacy

| Data | Location |
|---|---|
| Sessions, query history, and other local settings | `%APPDATA%\data-workbench\app.db` |
| Application logs | `%APPDATA%\data-workbench\logs` |
| Reversal SQL material from data sync | `%APPDATA%\data-workbench\sync-backups\<task-id>` |
| Database/SSH passwords and private-key passphrases | Windows Credential Manager |

- No client account or cloud sync is required. Moving to another computer requires handling both the local database and system credentials.
- The `data-workbench` directory and credential service names remain for compatibility after the DBFolio rename.
- Client-side read-only mode and allowlists do not replace server-side least-privilege access.
- AI prompts may send selected SQL, relevant schemas, errors, or business text to the service you configure. Choose that service and the submitted content accordingly.
- Review generated SQL before execution, particularly writes, object deletion, and index changes.
- Schema DDL is not always reversible. Back up important data before synchronization, imports, and bulk changes. Completed MongoDB imports and batch writes are not undone by later cancellation.
- Charts only cover their input range and use floating-point approximations. Portable program files and local configuration are stored separately.

<a id="project-structure"></a>
## Project layout

```text
src/                  React / TypeScript frontend
  features/           Sessions, queries, sync, analysis, and other features
  stores/             Frontend state
src-tauri/            Rust and Tauri desktop backend
  src/                Database adapters, services, local storage, and IPC
scripts/              Build and regression-check scripts
public/               Static assets
docs/                 Design, roadmap, screenshots, and verification records
```

The [design document](docs/design.md) records architecture, decisions, and implementation status. Historical plans may appear there, so use its implementation-status section and current code to judge available behavior. The [roadmap](docs/roadmap.md) lists priorities, acceptance criteria, and completion markers; unchecked items are plans, not current features.

<a id="contributing"></a>
## Issues and contributions

Issues, feature suggestions, and pull requests are welcome. When reporting a bug, include the app and Windows versions, database engine/version, reproduction steps, and expected versus actual results. **Redact screenshots, logs, and SQL examples** before publishing; do not expose passwords, tokens, credentials, or real business data.

Run checks relevant to your changes before contributing. Feature or behavior changes must update the implementation status and change log in [docs/design.md](docs/design.md); see [AGENTS.md](AGENTS.md) for project rules. Report security vulnerabilities privately to the author below rather than in a public issue.

## Author

- **SerLiunx**
- Email: [root@serliunx.com](mailto:root@serliunx.com)
- Website: [https://www.serliunx.com](https://www.serliunx.com)

<a id="license"></a>
## License

DBFolio is licensed under the [MIT License](LICENSE). It permits use, copying, modification, distribution, and commercial use, including proprietary derivatives, provided the copyright and license notice is retained. Third-party dependencies retain their own licenses.

Copyright (c) 2026 SerLiunx
