import { useState } from 'react';
import { Button, Dropdown, Slider } from 'antd';
import { CalendarOutlined, DownOutlined } from '@ant-design/icons';

import { Range, WINDOW_OPTIONS } from './common';

/**
 * Analytics time-interval picker: relative presets (15m … 7d) plus a custom
 * absolute range chosen with a dual-handle slider over the last 72 hours
 * (−72h … Now). Emits a Range the pages turn into query params.
 */
export function TimeWindow({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const [visible, setVisible] = useState(false);
  // Slider value is "hours ago": [olderEdge, newerEdge]; reversed so Now is on
  // the right. Default mirrors the last-24h window.
  const [slider, setSlider] = useState<[number, number]>([24, 0]);

  const applySlider = (v: number[]) => {
    const older = Math.max(v[0], v[1]);
    const newer = Math.min(v[0], v[1]);
    const now = Date.now();
    onChange({
      from: new Date(now - older * 3600 * 1000).toISOString(),
      to: new Date(now - newer * 3600 * 1000).toISOString(),
      label: newer === 0 ? `Last ${older}h` : `${older}h → ${newer}h ago`,
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
      <div style={{ color: '#888', fontSize: 12, marginBottom: 4 }}>Custom range (drag the handles)</div>
      <Slider
        range
        reverse
        min={0}
        max={72}
        step={1}
        value={slider}
        marks={{ 0: 'Now', 24: '-24h', 48: '-48h', 72: '-72h' }}
        tipFormatter={(v?: number) => (v === 0 ? 'Now' : `-${v}h`)}
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
