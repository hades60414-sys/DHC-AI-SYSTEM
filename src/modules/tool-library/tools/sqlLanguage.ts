import { StreamLanguage } from '@codemirror/language';
import type { StreamParser, StringStream } from '@codemirror/language';

/** DHC CLI 10/14 small T-SQL highlighter (@codemirror/lang-sql is not installed). */

const words = (list: string) => new Set(list.split(/\s+/).filter(Boolean));

const KEYWORDS = words(`
  SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER FULL CROSS APPLY ON AND OR NOT IN IS NULL AS CASE WHEN THEN ELSE END
  GROUP BY ORDER HAVING UNION ALL EXCEPT INTERSECT INSERT INTO VALUES UPDATE SET DELETE MERGE USING MATCHED TARGET SOURCE
  CREATE ALTER DROP TRUNCATE PROCEDURE PROC FUNCTION VIEW TABLE INDEX TRIGGER BEGIN IF WHILE RETURN RETURNS DECLARE
  EXEC EXECUTE WITH TOP DISTINCT OVER PARTITION ROWS RANGE BETWEEN LIKE EXISTS ANY SOME ASC DESC OFFSET FETCH NEXT ONLY
  PRIMARY KEY FOREIGN REFERENCES CONSTRAINT DEFAULT UNIQUE CLUSTERED NONCLUSTERED OUTPUT TRY CATCH TRANSACTION TRAN
  COMMIT ROLLBACK GO USE PRINT RAISERROR THROW BREAK CONTINUE GOTO CURSOR OPEN CLOSE DEALLOCATE FOR NOLOCK PIVOT UNPIVOT
  TABLESAMPLE READONLY NOCOUNT ON OFF IDENTITY
`);

const BUILTINS = words(`
  DATEADD DATEDIFF DATEPART DATENAME GETDATE GETUTCDATE SYSDATETIME EOMONTH YEAR MONTH DAY ISNULL COALESCE NULLIF IIF
  CAST CONVERT TRY_CAST TRY_CONVERT SUM COUNT AVG MIN MAX STDEV VAR ROW_NUMBER RANK DENSE_RANK NTILE LAG LEAD FIRST_VALUE
  LAST_VALUE LEN LTRIM RTRIM TRIM UPPER LOWER SUBSTRING CHARINDEX REPLACE STUFF FORMAT CONCAT STRING_AGG STRING_SPLIT
  ROUND FLOOR CEILING ABS POWER SQRT ISNUMERIC ISDATE OBJECT_ID SCOPE_IDENTITY NEWID CHECKSUM
`);

const TYPES = words(`
  INT BIGINT SMALLINT TINYINT BIT DECIMAL NUMERIC FLOAT REAL MONEY DATE DATETIME DATETIME2 SMALLDATETIME TIME
  CHAR VARCHAR NCHAR NVARCHAR TEXT NTEXT UNIQUEIDENTIFIER XML MAX
`);

type SqlState = { inComment: boolean };

const startState = (): SqlState => ({ inComment: false });

/** Reads one token; the returned name is a CodeMirror legacy token name (null = plain text). */
export function sqlToken(stream: StringStream, state: SqlState): string | null {
  if (state.inComment) {
    while (!stream.eol()) {
      if (stream.match('*/')) { state.inComment = false; break; }
      stream.next();
    }
    return 'comment';
  }
  if (stream.eatSpace()) return null;
  if (stream.match('--')) { stream.skipToEnd(); return 'comment'; }
  if (stream.match('/*')) {
    state.inComment = true;
    return sqlToken(stream, state);
  }
  if (stream.match(/^N?'/)) {
    // '' inside a string is an escaped quote; an unterminated string runs to the end of the line.
    while (!stream.eol()) {
      if (stream.next() === "'") {
        if (stream.peek() === "'") stream.next();
        else break;
      }
    }
    return 'string';
  }
  if (stream.match(/^\[[^\]]*\]?/)) return 'variableName.special';
  if (stream.match(/^@@?[A-Za-z_#][\w$#@]*/)) return 'variableName';
  if (stream.match(/^(?:0x[0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)/)) return 'number';
  if (stream.match(/^[A-Za-z_#][\w$#]*/)) {
    const word = stream.current().toUpperCase();
    if (KEYWORDS.has(word)) return 'keyword';
    if (BUILTINS.has(word)) return 'builtin';
    if (TYPES.has(word)) return 'type';
    return null;
  }
  if (stream.match(/^[=<>!+\-*/%&|^~]+/)) return 'operator';
  stream.next();
  return null;
}

const parser: StreamParser<SqlState> = {
  name: 'tsql',
  startState,
  token: sqlToken,
  copyState: (state) => ({ ...state }),
  languageData: { commentTokens: { line: '--', block: { open: '/*', close: '*/' } } },
};

export const sqlLanguage = StreamLanguage.define(parser);
