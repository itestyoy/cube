import { useState } from 'react';
import { Button, Dropdown, Slider } from 'antd';
import { CalendarOutlined, DownOutlined } from '@ant-design/icons';

import { Range, WINDOW_OPTIONS } from './common';

/**
 * Analytics time-interval picker: relative presets (15m … 7d) plus a custom
 * absolute range chosen with a dual-handle slider over the last 72 hours
 * (−72h … Now). Emits a Range the pages turn into query params.
 */
const SPANS = [
  { label: '3d', value: 72 },
  { label: '7d', value: 168 },
  { label: '30d', value: 720 },
];

const fmtAgo = (h: number) => (h === 0 ? 'Now' : h >= 48 ? `-${Math.round(h / 24)}d` : `-${h}h`);

export function TimeWindow({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const [visible, setVisible] = useState(false);
  // Slider value is "hours ago": [olderEdge, newerEdge]; reversed so Now is on
  // the right. `spanH` is the slider's max (widen the range with the buttons).
  const [spanH, setSpanH] = useState(72);
  const [slider, setSlider] = useState<[number, number]>([24, 0]);

  const applySlider = (v: number[]) => {
    const older = Math.max(v[0], v[1]);
    const newer = Math.min(v[0], v[1]);
    const now = Date.now();
    onChange({
      from: new Date(now - older * 3600 * 1000).toISOString(),
      to: new Date(now - newer * 3600 * 1000).toISOString(),
      label: newer === 0 ? `Last ${fmtAgo(older).replace('-', '')}` : `${fmtAgo(older)} → ${fmtAgo(newer)}`,
    });
    setVisible(false);
  };

  const panel = (
    <div
      style={{
        background: '#fff',
        padding: 16,
        boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
        borderRadius: 8,
        width: 360,
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        {WINDOW_OPTIONS.map((p) => (
          <Button
            key={p.value}
            size="small"
            type={!value.from && value.windowHours === p.value ? 'primary' : 'default'}
            onClick={() => {
              onChange({ windowHours: p.value, label: p.label });
              setVisible(false);
            }}
          >
            {p.label.replace('Last ', '')}
          </Button>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ color: '#888', fontSize: 12 }}>Custom range (drag the handles)</span>
        <span>
          {SPANS.map((s) => (
            <Button
              key={s.value}
              size="small"
              type={spanH === s.value ? 'primary' : 'default'}
              style={{ marginLeft: 4, padding: '0 8px' }}
              onClick={() => {
                setSpanH(s.value);
                setSlider(([o, n]) => [Math.min(Math.max(o, n), s.value), Math.min(o, n)]);
              }}
            >
              {s.label}
            </Button>
          ))}
        </span>
      </div>
      <Slider
        range
        reverse
        min={0}
        max={spanH}
        step={1}
        value={slider}
        marks={{ 0: fmtAgo(0), [Math.round(spanH / 2)]: fmtAgo(Math.round(spanH / 2)), [spanH]: fmtAgo(spanH) }}
        tipFormatter={(v?: number) => fmtAgo(v || 0)}
        onChange={(v: any) => setSlider(v as [number, number])}
        onAfterChange={(v: any) => applySlider(v as number[])}
      />
    </div>
  );

  return (
    <Dropdown overlay={panel} trigger={['click']} visible={visible} onVisibleChange={setVisible} placement="bottomRight">
      <Button icon={<CalendarOutlined />}>
        {value.label} <DownOutlined style={{ fontSize: 10 }} />
      </Button>
    </Dropdown>
  );
}
