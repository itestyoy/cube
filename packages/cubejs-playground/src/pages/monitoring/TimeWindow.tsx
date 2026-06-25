import { useState } from 'react';
import { Button, DatePicker, Dropdown } from 'antd';
import { CalendarOutlined, DownOutlined } from '@ant-design/icons';

import { Range, WINDOW_OPTIONS } from './common';

const { RangePicker } = DatePicker;

/**
 * Analytics time-interval picker: relative presets (15m … 7d) plus a custom
 * absolute [from, to) range. Emits a Range the pages turn into query params.
 */
export function TimeWindow({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const [visible, setVisible] = useState(false);

  const panel = (
    <div
      style={{
        background: '#fff',
        padding: 16,
        boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
        borderRadius: 8,
        width: 320,
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
      <div style={{ color: '#888', fontSize: 12, marginBottom: 6 }}>Custom range</div>
      <RangePicker
        showTime
        style={{ width: '100%' }}
        onChange={(vals: any) => {
          if (vals && vals[0] && vals[1]) {
            onChange({
              from: vals[0].toISOString(),
              to: vals[1].toISOString(),
              label: `${vals[0].format('MMM D, HH:mm')} – ${vals[1].format('MMM D, HH:mm')}`,
            });
            setVisible(false);
          }
        }}
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
