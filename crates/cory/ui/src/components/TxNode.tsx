import { memo, useEffect, useMemo, useState, useCallback } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { TxNodeData } from "../layout";

type TxNodeProps = NodeProps & { data: TxNodeData };

type SaveState = "saved" | "dirty" | "saving" | "error";

export default memo(function TxNode({ data, selected }: TxNodeProps) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [states, setStates] = useState<Record<string, SaveState>>({});
  const [isAdding, setIsAdding] = useState(false);
  const [newFileId, setNewFileId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newLabelState, setNewLabelState] = useState<SaveState>("saved");
  const [nodeError, setNodeError] = useState<string | null>(null);

  const meta: string[] = [];
  if (data.feeSats != null) meta.push(`${data.feeSats} sat`);
  if (data.feerateSatVb != null)
    meta.push(`${data.feerateSatVb.toFixed(1)} sat/vB`);
  if (data.rbfSignaling) meta.push("RBF");
  if (data.isCoinbase) meta.push("coinbase");
  meta.push(`${data.outputCount} out`);

  const borderColor = data.isCoinbase
    ? "#f0a500"
    : selected
      ? "var(--accent)"
      : "var(--border)";

  const editableEntries = useMemo(
    () => data.labels.filter((entry) => entry.editable),
    [data.labels],
  );

  const readonlyEntries = useMemo(
    () => data.labels.filter((entry) => !entry.editable),
    [data.labels],
  );

  const editableFileIds = useMemo(
    () => new Set(editableEntries.map((entry) => entry.file_id)),
    [editableEntries],
  );

  const addableFiles = useMemo(
    () => data.localFiles.filter((file) => !editableFileIds.has(file.id)),
    [data.localFiles, editableFileIds],
  );

  useEffect(() => {
    const nextDrafts: Record<string, string> = {};
    const nextStates: Record<string, SaveState> = {};
    for (const entry of editableEntries) {
      nextDrafts[entry.file_id] = entry.label;
      nextStates[entry.file_id] = "saved";
    }
    setDrafts(nextDrafts);
    setStates(nextStates);
  }, [editableEntries]);

  useEffect(() => {
    const hasCurrentSelection = addableFiles.some(
      (file) => file.id === newFileId,
    );
    if (hasCurrentSelection) {
      return;
    }
    const firstLocalFile = addableFiles[0];
    setNewFileId(firstLocalFile?.id ?? "");
  }, [newFileId, addableFiles]);

  const handleDelete = useCallback(
    async (fileId: string) => {
      try {
        setNodeError(null);
        await data.onDeleteLabel(fileId, data.txid);
      } catch (err) {
        setNodeError((err as Error).message);
      }
    },
    [data],
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      const dirtyFileIds = Object.entries(states)
        .filter(([, state]) => state === "dirty")
        .map(([fileId]) => fileId);

      for (const fileId of dirtyFileIds) {
        const next = drafts[fileId]?.trim();
        if (!next) continue;

        setStates((prev) => ({ ...prev, [fileId]: "saving" }));
        void data
          .onSaveLabel(fileId, data.txid, next)
          .then(() => {
            setNodeError(null);
            setStates((prev) => ({ ...prev, [fileId]: "saved" }));
          })
          .catch((err) => {
            setNodeError((err as Error).message);
            setStates((prev) => ({ ...prev, [fileId]: "error" }));
          });
      }
    }, 2000);

    return () => window.clearInterval(timer);
  }, [states, drafts, data]);

  useEffect(() => {
    if (!isAdding || !newFileId || !newLabel.trim()) {
      return;
    }
    if (newLabelState !== "dirty" && newLabelState !== "error") {
      return;
    }

    const timer = window.setTimeout(() => {
      setNewLabelState("saving");
      void data
        .onSaveLabel(newFileId, data.txid, newLabel.trim())
        .then(() => {
          setNodeError(null);
          setNewLabel("");
          setNewLabelState("saved");
          setIsAdding(false);
        })
        .catch((err) => {
          setNodeError((err as Error).message);
          setNewLabelState("error");
        });
    }, 2000);

    return () => window.clearTimeout(timer);
  }, [isAdding, newFileId, newLabel, newLabelState, data]);

  function stateColor(state: SaveState): string {
    if (state === "saved") return "var(--ok)";
    if (state === "error") return "var(--accent)";
    return "var(--text-muted)";
  }

  return (
    <div
      style={{
        background: "var(--surface)",
        border: `1.5px solid ${borderColor}`,
        borderRadius: 4,
        padding: "6px 10px",
        width: 340,
        fontFamily: "var(--mono)",
        fontSize: 11,
        boxShadow: selected ? "0 0 8px var(--accent)" : undefined,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: "var(--border)" }}
      />

      <div
        style={{
          color: data.isCoinbase ? "#f0a500" : "var(--accent)",
          fontWeight: 600,
          fontSize: 12,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {data.shortTxid}
      </div>

      <div style={{ color: "var(--text-muted)", fontSize: 10, marginTop: 2 }}>
        {meta.join(" | ")}
      </div>

      <div className="nodrag nopan" style={{ marginTop: 6 }}>
        {editableEntries.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {editableEntries.map((entry) => (
              <div key={entry.file_id} style={{ display: "flex", gap: 4 }}>
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--accent)",
                    alignSelf: "center",
                    minWidth: 54,
                  }}
                  title={entry.file_id}
                >
                  {entry.file_name}
                </span>
                <input
                  type="text"
                  value={drafts[entry.file_id] ?? ""}
                  onChange={(e) => {
                    setDrafts((prev) => ({
                      ...prev,
                      [entry.file_id]: e.target.value,
                    }));
                    setStates((prev) => ({
                      ...prev,
                      [entry.file_id]: "dirty",
                    }));
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  style={{ flex: 1, fontSize: 10, padding: "2px 6px" }}
                />
                <span
                  style={{
                    fontSize: 12,
                    color: stateColor(states[entry.file_id] ?? "saved"),
                    alignSelf: "center",
                  }}
                  title={states[entry.file_id] ?? "saved"}
                >
                  ✓
                </span>
                <button
                  onClick={() => void handleDelete(entry.file_id)}
                  style={{ fontSize: 10, padding: "2px 6px" }}
                  title="Delete label"
                >
                  🗑
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: editableEntries.length > 0 ? 4 : 0 }}>
          {!isAdding ? (
            addableFiles.length > 0 ? (
              <button
                onClick={() => {
                  setIsAdding(true);
                  setNodeError(null);
                  setNewLabelState("saved");
                }}
                style={{ fontSize: 12, padding: "0 8px", lineHeight: "18px" }}
                title="Add label"
              >
                +
              </button>
            ) : data.localFiles.length === 0 ? (
              <p style={{ color: "var(--text-muted)", fontSize: 10 }}>
                Create or import a label file first.
              </p>
            ) : (
              <p style={{ color: "var(--text-muted)", fontSize: 10 }}>
                Labels already exist for all local files.
              </p>
            )
          ) : addableFiles.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: 10 }}>
              No additional local files available for this transaction.
            </p>
          ) : (
            <div style={{ display: "flex", gap: 4 }}>
              <select
                value={newFileId}
                onChange={(e) => setNewFileId(e.target.value)}
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  background: "var(--bg)",
                  color: "var(--text)",
                  border: "1px solid var(--border)",
                }}
              >
                {addableFiles.map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.name}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={newLabel}
                onChange={(e) => {
                  setNewLabel(e.target.value);
                  setNewLabelState("dirty");
                }}
                placeholder="Label"
                autoComplete="off"
                spellCheck={false}
                style={{ flex: 1, fontSize: 10, padding: "2px 6px" }}
              />
              <span
                style={{
                  fontSize: 12,
                  color: stateColor(newLabelState),
                  alignSelf: "center",
                }}
                title={newLabelState}
              >
                ✓
              </span>
            </div>
          )}
        </div>

        {readonlyEntries.length > 0 && (
          <div
            style={{
              marginTop: 5,
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            {readonlyEntries.map((entry) => (
              <div
                key={`${entry.file_id}:${entry.label}`}
                style={{ fontSize: 10 }}
              >
                <span style={{ color: "var(--text-muted)" }}>
                  [{entry.file_name}]
                </span>
                <span style={{ color: "var(--text)" }}>{entry.label}</span>
              </div>
            ))}
          </div>
        )}

        {nodeError && (
          <div style={{ color: "var(--accent)", fontSize: 10, marginTop: 4 }}>
            {nodeError}
          </div>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        style={{ background: "var(--border)" }}
      />
    </div>
  );
});
