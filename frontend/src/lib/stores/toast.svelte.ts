type ToastState = 'pending' | 'success' | 'error';

interface Toast {
  id: number;
  message: string;
  state: ToastState;
}

let nextId = 0;
let toasts = $state<Toast[]>([]);

function add(message: string): number {
  const id = nextId++;
  toasts.push({ id, message, state: 'pending' });
  return id;
}

function update(id: number, state: ToastState, message?: string) {
  const t = toasts.find((t) => t.id === id);
  if (!t) return;
  t.state = state;
  if (message) t.message = message;
  if (state === 'success' || state === 'error') {
    setTimeout(() => remove(id), state === 'success' ? 2000 : 4000);
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
