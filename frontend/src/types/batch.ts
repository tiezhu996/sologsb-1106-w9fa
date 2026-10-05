export type PrintKind = '试印' | '正式印'

export interface PrintBatch {
  id: string
  draftId: string
  batchNo: string
  printedAt: string
  paperBatch: string
  inkNote: string
  qty: number
  pieceCount: number
  qcNote: string
  /** 首批性质：版片尚有“待刻/在刻”时为试印，全部刻成或修版后为正式印；以版片现状判定。 */
  printKind: PrintKind
  /** 同刀纸（同画稿、同纸张批号、同印制日期）补印并入原批的次数。 */
  reprintCount: number
}
