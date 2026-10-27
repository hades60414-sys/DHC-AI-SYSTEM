import { squash } from './distill'
import { NOTE_TAG, tag } from './notes'
import { transcriptOf } from './transcript'
import type { Row } from './transcript'

export type DistillSnapshot = { sid: string; turns: number; anchor: string | undefined; rows: readonly Row[] }
export type DistillCheckpoint = { turn: number; anchor?: string; rowCount?: number; last?: Pick<Row, 'role' | 'text'> }
export type DistillEndpoint = { fromTurn: number; turn: number; anchor?: string; rowCount: number; last?: Pick<Row, 'role' | 'text'> }

export const hasNewDistillTurns = (turns: number, previous: DistillCheckpoint | undefined) => turns > (previous?.turn ?? 0)

export function selectDistillBatch(input: {
  sid: string
  turns: number
  anchor: string | undefined
  rows: readonly Row[]
  previous: DistillCheckpoint | undefined
  retry: DistillEndpoint | undefined
}) {
  const { sid, previous, retry } = input
  const turns = retry?.turn ?? input.turns
  if (!hasNewDistillTurns(turns, previous)) return { kind: 'nothing-new' } as const
  const anchor = retry ? retry.anchor : input.anchor
  let rows = input.rows
  if (retry) {
    const last = rows[retry.rowCount - 1]
    if (rows.length < retry.rowCount || (retry.last && (last?.role !== retry.last.role || last.text !== retry.last.text))) {
      return { kind: 'blocked', reason: 'retry-lost' } as const
    }
    rows = rows.slice(0, retry.rowCount)
  }
  const previousLast = previous?.rowCount === undefined ? undefined : rows[previous.rowCount - 1]
  const located = previous?.rowCount !== undefined && rows.length >= previous.rowCount && (!previous.last || (previousLast?.role === previous.last.role && previousLast.text === previous.last.text))
  const transcript = located
    ? { ...transcriptOf(rows.slice(previous.rowCount), undefined), found: true }
    : transcriptOf(rows, previous?.anchor)
  const userTextOf = (items: readonly Row[]) => squash(items.filter(r => r.role === 'user' && !r.text.startsWith(NOTE_TAG) && !r.text.startsWith(tag)).map(r => r.text).join('\n'))
  const last = rows.at(-1)
  const endpoint: DistillEndpoint = {
    fromTurn: retry?.fromTurn ?? previous?.turn ?? 0,
    turn: turns,
    anchor,
    rowCount: rows.length,
    ...(last ? { last: { role: last.role, text: last.text } } : {}),
  }
  return {
    kind: 'ready', turns, anchor, rows, transcript,
    userText: userTextOf(rows),
    currentUserText: previous?.anchor && !transcript.found ? '' : userTextOf(transcript.rows),
    source: `${sid}:${endpoint.fromTurn}:${turns}`,
    endpoint,
  } as const
}
