import React from 'react';

interface QrPreviewProps {
  value: string;
  size?: number;
  label?: string;
}

// Deterministic Stage 1 visual QR matrix for pharmacist preview (not a real cryptographic token)
export const QrPreview: React.FC<QrPreviewProps> = ({ value, size = 160, label }) => {
  const grid = 21;
  const cells: boolean[][] = Array.from({ length: grid }, () => Array(grid).fill(false));

  const drawFinder = (r0: number, c0: number) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const isBorder = r === 0 || r === 6 || c === 0 || c === 6;
        const isCenter = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        cells[r0 + r][c0 + c] = isBorder || isCenter;
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, grid - 7);
  drawFinder(grid - 7, 0);

  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  for (let r = 0; r < grid; r++) {
    for (let c = 0; c < grid; c++) {
      const inTopLeft = r < 8 && c < 8;
      const inTopRight = r < 8 && c >= grid - 8;
      const inBottomLeft = r >= grid - 8 && c < 8;
      if (inTopLeft || inTopRight || inBottomLeft) continue;
      const bit = ((hash >>> ((r * 3 + c * 5) % 24)) ^ (r * 7 + c * 11)) & 1;
      cells[r][c] = bit === 1;
    }
  }

  const cellSize = size / grid;

  return (
    <div className="inline-flex flex-col items-center gap-2 bg-white p-3 border border-slate-200 rounded-xl">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={label ?? `QR Preview ${value}`}
        className="block"
      >
        <rect width={size} height={size} fill="#FFFFFF" />
        {cells.map((row, r) =>
          row.map((filled, c) =>
            filled ? (
              <rect
                key={`${r}-${c}`}
                x={c * cellSize}
                y={r * cellSize}
                width={cellSize + 0.2}
                height={cellSize + 0.2}
                fill="#103354"
              />
            ) : null
          )
        )}
      </svg>
      <span className="font-mono text-[11px] text-slate-500 tabular-nums">{value}</span>
    </div>
  );
};
