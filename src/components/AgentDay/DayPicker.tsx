import React from 'react';
import { dateTimeFormat } from '@grafana/data';
import { Button, Input, Stack } from '@grafana/ui';
import { dayOf, shiftDay, type Day } from '../../lib/agents';

interface Props {
  day: Day;
  onChange: (day: Day) => void;
}

/** Previous / next day, a date field and "Today"; never past today. */
export function DayPicker({ day, onChange }: Props) {
  const today = dayOf(undefined);
  const isToday = day.key === today.key;
  return (
    <Stack gap={1} alignItems="center" wrap="wrap">
      <Button
        size="md"
        variant="secondary"
        icon="angle-left"
        aria-label="Previous day"
        onClick={() => onChange(shiftDay(day, -1))}
      />
      <Input
        type="date"
        width={18}
        value={day.key}
        max={today.key}
        aria-label="Day"
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (value) {
            onChange(dayOf(value));
          }
        }}
      />
      <Button
        size="md"
        variant="secondary"
        icon="angle-right"
        aria-label="Next day"
        disabled={isToday}
        onClick={() => onChange(shiftDay(day, 1))}
      />
      {!isToday && (
        <Button size="md" variant="secondary" onClick={() => onChange(today)}>
          Today
        </Button>
      )}
      <span title={dateTimeFormat(day.startMs, { format: 'dddd' })}>
        {dateTimeFormat(day.startMs, { format: 'dddd' })}
      </span>
    </Stack>
  );
}
