import type { GraphResponse, LabelEntry } from "../../types";
import { useAppStore } from "../../store";
import TargetLabelEditor from "./TargetLabelEditor";

function labelsFor(
  graph: GraphResponse,
  labelType: "tx" | "input" | "output" | "addr",
  refId: string,
): LabelEntry[] {
  return graph.labels_by_type[labelType][refId] ?? [];
}

export default function SelectedTxEditor() {
  const graph = useAppStore((s) => s.graph);
  const selectedTxid = useAppStore((s) => s.selectedTxid);
  const labelFiles = useAppStore((s) => s.labelFiles);
  const saveLabel = useAppStore((s) => s.saveLabel);
  const deleteLabel = useAppStore((s) => s.deleteLabel);

  const editableFiles = labelFiles.filter((file) => file.editable);

  if (!graph || !selectedTxid || !graph.nodes[selectedTxid]) {
    return (
      <p style={{ color: "var(--text-muted)", fontSize: 11 }}>
        Select a transaction node to edit tx/input/output/address labels.
      </p>
    );
  }

  const tx = graph.nodes[selectedTxid];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        className="notice notice-warning"
        style={{
          padding: 8,
          fontSize: 10,
          fontStyle: "italic",
          fontWeight: 500,
        }}
      >
        Address labels apply to a single address and are shared wherever that same address appears
        in the graph. They are stored separately from input/output labels: avoid duplicating
        information between the two!
      </div>

      <TargetLabelEditor
        title="Transaction"
        subtitle={selectedTxid}
        labelType="tx"
        refId={selectedTxid}
        labels={labelsFor(graph, "tx", selectedTxid)}
        editableFiles={editableFiles}
        onSaveLabel={saveLabel}
        onDeleteLabel={deleteLabel}
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
          alignItems: "start",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ color: "var(--text-secondary)", fontSize: 11, marginTop: 2 }}>Inputs</div>
          {tx.inputs.map((_, inputIndex) => {
            const inputRef = `${selectedTxid}:${inputIndex}`;
            const inputAddress = graph.input_address_refs[inputRef] ?? null;
            const inputOccurrences = inputAddress
              ? (graph.address_occurrences[inputAddress] ?? [])
              : [];
            const inputAddressNote =
              inputAddress && inputOccurrences.length > 1
                ? `Reused address (${inputOccurrences.length} outputs in current graph). Address labels are shared for this address.`
                : undefined;
            return (
              <div
                key={`input-${inputIndex}`}
                style={{ display: "flex", flexDirection: "column", gap: 6 }}
              >
                <TargetLabelEditor
                  title={
                    <>
                      Input <strong>#{inputIndex}</strong>
                    </>
                  }
                  labelType="input"
                  refId={inputRef}
                  labels={labelsFor(graph, "input", inputRef)}
                  editableFiles={editableFiles}
                  onSaveLabel={saveLabel}
                  onDeleteLabel={deleteLabel}
                />
                {inputAddress && (
                  <TargetLabelEditor
                    title={
                      <>
                        Address for Input <strong>#{inputIndex}</strong>
                      </>
                    }
                    subtitle={inputAddress}
                    labelType="addr"
                    refId={inputAddress}
                    labels={labelsFor(graph, "addr", inputAddress)}
                    editableFiles={editableFiles}
                    onSaveLabel={saveLabel}
                    onDeleteLabel={deleteLabel}
                    note={inputAddressNote}
                  />
                )}
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ color: "var(--text-secondary)", fontSize: 11, marginTop: 2 }}>Outputs</div>
          {tx.outputs.map((_, outputIndex) => {
            const outputRef = `${selectedTxid}:${outputIndex}`;
            const addressRef = graph.output_address_refs[outputRef] ?? null;
            const occurrences = addressRef ? (graph.address_occurrences[addressRef] ?? []) : [];
            const addressNote =
              addressRef && occurrences.length > 1
                ? `Reused address (${occurrences.length} outputs in current graph). Address labels are shared for this address.`
                : undefined;

            return (
              <div
                key={`output-${outputIndex}`}
                style={{ display: "flex", flexDirection: "column", gap: 6 }}
              >
                <TargetLabelEditor
                  title={
                    <>
                      Output <strong>#{outputIndex}</strong>
                    </>
                  }
                  labelType="output"
                  refId={outputRef}
                  labels={labelsFor(graph, "output", outputRef)}
                  editableFiles={editableFiles}
                  onSaveLabel={saveLabel}
                  onDeleteLabel={deleteLabel}
                />

                <TargetLabelEditor
                  title={
                    <>
                      Address for Output <strong>#{outputIndex}</strong>
                    </>
                  }
                  subtitle={addressRef ?? undefined}
                  labelType="addr"
                  refId={addressRef ?? ""}
                  labels={addressRef ? labelsFor(graph, "addr", addressRef) : []}
                  editableFiles={editableFiles}
                  onSaveLabel={saveLabel}
                  onDeleteLabel={deleteLabel}
                  disabled={!addressRef}
                  disabledMessage="No canonical address can be derived for this script."
                  note={addressNote}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
