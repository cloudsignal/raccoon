import type { Delivery } from '../state/messages.js';

export function Ticks(props: { delivery: Delivery }) {
  if (props.delivery === 'pending') {
    return (
      <svg data-testid="tick-pending" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    );
  }
  if (props.delivery === 'sent') {
    return (
      <svg data-testid="tick-sent" width="13" height="10" viewBox="0 0 14 12" fill="none" stroke="oklch(0.55 0.02 165)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="m1 6.5 3.5 3.5L11 3.5" />
      </svg>
    );
  }
  if (props.delivery === 'delivered' || props.delivery === 'read') {
    const stroke = props.delivery === 'read' ? 'oklch(0.65 0.12 235)' : 'oklch(0.55 0.02 165)';
    return (
      <svg data-testid={`tick-${props.delivery}`} width="16" height="10" viewBox="0 0 20 12" fill="none" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="m1 6.5 3.5 3.5L11 3.5" />
        <path d="m8.5 8.5 1.5 1.5L16.5 3.5" />
      </svg>
    );
  }
  return null;
}
