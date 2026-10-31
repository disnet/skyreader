/** When a paused background copy picks up again: a time today, else the day and time. */
export function formatResumeAt(at: Date, now = new Date()): string {
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (at.toDateString() === now.toDateString()) return time;
  return `${at.toLocaleDateString([], { weekday: 'long' })} at ${time}`;
}
