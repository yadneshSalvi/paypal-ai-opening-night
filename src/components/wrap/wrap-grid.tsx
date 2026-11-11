"use client";
import { useEffect, useRef, useState } from "react";
import { Grid } from "@bryntum/grid-enterprise";
import { Store } from "@bryntum/core-enterprise";
import type { LedgerLine } from "@/domain/wrap/contracts";
import { categoryLabels } from "@/domain/wrap/contracts";
import { wrapMoney } from "@/domain/wrap/presentation";

export default function WrapGrid({ lines, selected, licenseKey, onSelect, onVisible, onEvidence }: { lines: LedgerLine[]; selected: string[]; licenseKey: string; onSelect: (ids: string[]) => void; onVisible: (ids: string[]) => void; onEvidence: (id: string) => void }) {
  const host = useRef<HTMLDivElement>(null), grid = useRef<Grid | null>(null), store = useRef<Store | null>(null), callbacks = useRef({ onSelect, onVisible, onEvidence }), syncing = useRef(false), initial = useRef(lines), [error, setError] = useState(false);
  callbacks.current = { onSelect, onVisible, onEvidence };
  const records = (values: LedgerLine[]) => values.map(line => ({ id: line.id, label: line.label, category: categoryLabels[line.category], direction: line.direction, baseline: line.baselineMinor, approved: line.approvedMinor, observed: line.currentCashMinor, reported: line.reportedCashMinor, outstanding: line.outstandingMinor, status: line.status, provenance: line.source }));
  useEffect(() => {
    const root = globalThis as typeof globalThis & { bryntum?: { licenseKey?: string } }; root.bryntum ??= {}; root.bryntum.licenseKey = licenseKey;
    try {
      const source = new Store({ data: records(initial.current), onFilter: ({ records: values }) => callbacks.current.onVisible(values.map(record => String(record.id))) }); store.current = source;
      const instance = new Grid({ appendTo: host.current!, store: source, height: 420, rowHeight: 48, readOnly: true, ariaLabel: "Production account. Select rows to compare their costs; double click a row for its evidence.", selectionMode: { row: true, multiSelect: true, checkbox: true, showCheckAll: true, deselectFilteredOutRecords: true, selectOnKeyboardNavigation: false }, features: { cellEdit: false, filterBar: true, group: false, cellMenu: false, rowCopyPaste: false },
        columns: [{ text: "Account line", field: "label", flex: 2, minWidth: 220, htmlEncode: true }, { text: "Category", field: "category", width: 120, htmlEncode: true }, { text: "Class", field: "direction", width: 105 }, ...[{ field: "baseline", text: "Baseline" }, { field: "approved", text: "Approved" }, { field: "observed", text: "Observed cash" }, { field: "reported", text: "Reported cash" }, { field: "outstanding", text: "Outstanding" }].map(column => ({ ...column, width: 138, type: "number", align: "right", renderer: ({ value }: { value: number | null }) => wrapMoney(value), filterable: true })), { text: "State", field: "status", width: 125 }, { text: "Provenance", field: "provenance", width: 230, htmlEncode: true }],
        listeners: { selectionChange: ({ selection }) => { if (!syncing.current) callbacks.current.onSelect(selection.map(record => String(record.id))); }, cellDblClick: ({ record }) => callbacks.current.onEvidence(String(record.id)) } });
      grid.current = instance; callbacks.current.onVisible(initial.current.map(line => line.id));
      return () => { grid.current = null; store.current = null; instance.destroy(); source.destroy(); };
    } catch { setError(true); callbacks.current.onVisible(initial.current.map(line => line.id)); }
  }, [licenseKey]);
  useEffect(() => { const source = store.current; if (!source) return; syncing.current = true; source.data = records(lines); callbacks.current.onVisible(source.records.map(record => String(record.id))); syncing.current = false; }, [lines]);
  useEffect(() => { if (!grid.current || !store.current) return; syncing.current = true; grid.current.selectedRecords = selected.map(id => store.current!.getById(id)).filter(Boolean); syncing.current = false; }, [selected, lines]);
  return <div className="wrap-native-grid">{error ? <p role="status">The interactive grid is unavailable. The equivalent account table below retains every row, filter and evidence link.</p> : null}<div ref={host} /></div>;
}
