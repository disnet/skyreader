type ToastState = 'pending' | 'success' | 'error';

/**
 * One next step: a link out, for a result the reader may want to go look at,
 * or (`run`) an in-place action such as granting a missing permission.
 */
export interface ToastAction {
  label: string;
  href?: string;
  run?: () => void;
}

interface Toast {
  id: number;
  message: string;
  state: ToastState;
  action?: ToastAction;
}

let nextId = 0;
let toasts = $state<Toast[]>([]);

function add(message: string): number {
  const id = nextId++;
  toasts.push({ id, message, state: 'pending' });
  return id;
}

function update(id: number, state: ToastState, message?: string, action?: ToastAction) {
  const t = toasts.find((t) => t.id === id);
  if (!t) return;
  t.state = state;
  if (message) t.message = message;
  if (action?.href || action?.run) t.action = { ...action };
  if (state === 'success' || state === 'error') {
    // A toast carrying somewhere to go has to outlive the glance that notices it.
    const linger = t.action ? 6000 : state === 'success' ? 2000 : 4000;
    setTimeout(() => remove(id), linger);
  }
}

function remove(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
}

export const toastStore = {
  get toasts() {
    return toasts;
  },
  add,
  update,
  remove,
};
