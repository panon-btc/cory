import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { TxNodeData } from '../layout';

type TxNodeProps = NodeProps & { data: TxNodeData };

export default memo(function TxNode({ data, selected }: TxNodeProps) {
  const meta: string[] = [];
  if (data.feeSats != null) meta.push(`${data.feeSats} sat`);
  if (data.feerateSatVb != null) meta.push(`${data.feerateSatVb.toFixed(1)} sat/vB`);
  if (data.rbfSignaling) meta.push('RBF');
  if (data.isCoinbase) meta.push('coinbase');
  meta.push(`${data.outputCount} out`);

  const borderColor = data.isCoinbase
    ? '#f0a500'
    : selected
      ? 'var(--accent)'
      : 'var(--border)';

  return (
    <div
      style={{
        background: 'var(--surface)',
        border: `1.5px solid ${borderColor}`,
        borderRadius: 4,
        padding: '6px 10px',
        width: 220,
        fontFamily: 'var(--mono)',
        fontSize: 11,
        boxShadow: selected ? '0 0 8px var(--accent)' : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: 'var(--border)' }} />

      <div
        style={{
          color: data.isCoinbase ? '#f0a500' : 'var(--accent)',
          fontWeight: 600,
          fontSize: 12,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {data.shortTxid}
      </div>

      <div style={{ color: 'var(--text-muted)', fontSize: 10, marginTop: 2 }}>
        {meta.join(' | ')}
      </div>

      {data.label && (
        <div
          style={{
            color: 'var(--text)',
            fontSize: 10,
            marginTop: 2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {data.label}
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ background: 'var(--border)' }} />
    </div>
  );
});
