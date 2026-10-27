# Database map and connection rules (template)

Replace every `<...>`. Never write passwords here; name the environment variable that holds them.

## Information boundary

- Allowed to leave the company network: schema, code, aggregated numbers the user approves.
- Must stay inside: `<e.g. customer IDs, account-level positions, row-level trades>`.

## Database map

| Purpose | Server (role name) | Engine | Database / schema | Access | Credential env var |
|---|---|---|---|---|---|
| Trading / positions | `<srv-db>` | `<SQL Server 2019>` | `<TRADE_DB>` | read-only | `<SRC_PWD>` |
| Market data feed | `<...>` | `<...>` | `<MarketDB>` | read-only | `<...>` |
| Risk / credit model | `<...>` | `<...>` | `<...>` | `<...>` | `<...>` |
| Local backtest store | `<localhost>` | `<PostgreSQL>` | `<...>` | read/write | `<...>` |

## Key tables

| Table | Grain (one row = ...) | Date column and format | Notes / gotchas |
|---|---|---|---|
| `<dbo.Positions>` | `<account x symbol x day>` | `<TxDate, int yyyyMMdd>` | `<e.g. holidays have no rows>` |

## How to connect

- Driver / client: `<ODBC Driver 18, sqlcmd, psql, node mssql>`.
- Connection pattern (no secrets): `<Server=srv-db;Database=TRADE_DB;User Id=%SRC_USER%;Password=%SRC_PWD%>`.
- Who can grant access: `<role, not a person's name>`.

## Conventions

- Dates: `<...>`. Units: `<e.g. amounts in NTD, prices unadjusted>`.
- Numbers that do not tie out are reported as breaks with evidence, never forced to match.
