import type { Bip329Type, GraphResponse, LabelEntry, LabelFileSummary } from "../types";
import TargetLabelEditor from "./TargetLabelEditor";

interface SelectedTxEditorProps {
  graph: GraphResponse | null;
  selectedTxid: string | null;
  localFiles: LabelFileSummary[];
  onSaveLabel: (
    fileId: string,
    labelType: Bip329Type,
    refId: string,
    label: string,
  ) => Promise<void>;
  onDeleteLabel: (fileId: string, labelType: Bip329Type, refId: string) => Promise<void>;
}

function labelsFor(
  graph: GraphResponse,
  labelType: "tx" | "input" | "output" | "addr",
  refId: string,
): LabelEntry[] {
  return graph.labels_by_type[labelType][refId] ?? [];
}

export default function SelectedTxEditor({
  graph,
  selectedTxid,
  localFiles,
  onSaveLabel,
  onDeleteLabel,
}: SelectedTxEditorProps) {
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
        style={{
          border: "1px solid var(--border)",
          borderRadius: 4,
          padding: 8,
          color: "#f0a500",
          fontSize: 10,
          fontStyle: "italic",
          fontWeight: 700,
        }}
      >
        Address labels apply to a single address and are shared wherever that same address appears
        in the graph. They are stored separately from input/output labels — avoid duplicating
        information between the two.
      </div>

      <TargetLabelEditor
        title="Transaction"
        subtitle={selectedTxid}
        labelType="tx"
        refId={selectedTxid}
        labels={labelsFor(graph, "tx", selectedTxid)}
        localFiles={localFiles}
        onSaveLabel={onSaveLabel}
        onDeleteLabel={onDeleteLabel}
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
          <div style={{ color: "var(--accent)", fontSize: 11, marginTop: 2 }}>Inputs</div>
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
                  subtitle={inputRef}
                  labelType="input"
                  refId={inputRef}
                  labels={labelsFor(graph, "input", inputRef)}
                  localFiles={localFiles}
                  onSaveLabel={onSaveLabel}
                  onDeleteLabel={onDeleteLabel}
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
                    localFiles={localFiles}
                    onSaveLabel={onSaveLabel}
                    onDeleteLabel={onDeleteLabel}
                    note={inputAddressNote}
                  />
                )}
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ color: "var(--accent)", fontSize: 11, marginTop: 2 }}>Outputs</div>
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
                  subtitle={outputRef}
                  labelType="output"
                  refId={outputRef}
                  labels={labelsFor(graph, "output", outputRef)}
                  localFiles={localFiles}
                  onSaveLabel={onSaveLabel}
                  onDeleteLabel={onDeleteLabel}
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
                  localFiles={localFiles}
                  onSaveLabel={onSaveLabel}
                  onDeleteLabel={onDeleteLabel}
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
