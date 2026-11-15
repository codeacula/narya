import React from 'react';
import { Modal, ModalTitle } from './modal';
import { confirmTextMatches } from './modalLogic';

/**
 * The confirm dialog for destructive actions, and a promise-based hook to raise it.
 *
 * Usage, from any operator page (the provider is mounted once in `main.tsx`, inside
 * `AuthGate`, and never on an overlay route):
 *
 *   const confirm = useConfirm();
 *   const ok = await confirm({
 *     title: `Delete "${reward.title}"?`,
 *     body: 'Twitch removes the reward and its pending redemptions. This cannot be undone.',
 *     confirmLabel: 'Delete reward',
 *     tone: 'danger',
 *     requireText: reward.title,   // only for irreversible Twitch-side actions
 *   });
 *   if (!ok) return;
 *
 * It resolves `true` on confirm and `false` on Cancel, Escape or a backdrop click.
 * `requireText` keeps the confirm button disabled until the operator types that text
 * (case and surrounding spaces forgiven); use it where a slip cannot be taken back,
 * and leave it off for local deletes, where it would only train people to type
 * without reading. Requests made while one is open queue behind it.
 *
 * The one deliberate exception: the chat-row ban (`ChatRowActions` in
 * ui/panels/Chat.tsx) confirms in place instead. The first tap arms the button and
 * relabels it "sure?", the second bans, and it disarms on blur or after 4 seconds.
 * Row moderation happens mid-stream on a moving list, often from the tablet, where a
 * modal over the chat would cover the message being acted on and add a reach to a
 * dialog button. The ban/timeout modal, with a reason field, is still one click away
 * from the viewer's name. Do not copy the in-place pattern elsewhere: anything that
 * is not one-tap row moderation uses this dialog.
 */

export type ConfirmTone = 'default' | 'danger';

export type ConfirmOptions = {
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
  requireText?: string;
};

export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  requireText,
  onConfirm,
  onCancel,
}: ConfirmOptions & { onConfirm: () => void; onCancel: () => void }) {
  const [typed, setTyped] = React.useState('');
  const bodyId = React.useId();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const confirmRef = React.useRef<HTMLButtonElement>(null);
  const needsText = Boolean(requireText && requireText.trim());
  const unlocked = !needsText || confirmTextMatches(typed, requireText ?? '');
  // Land where a stray Enter does the least harm: the text box when one is required,
  // Cancel for anything destructive, the confirm button otherwise.
  const initialFocusRef = needsText ? inputRef : tone === 'danger' ? cancelRef : confirmRef;

  return (
    <Modal
      as="form"
      className="confirm-modal"
      onClose={onCancel}
      initialFocusRef={initialFocusRef}
      describedBy={body ? bodyId : undefined}
      onSubmit={event => {
        event.preventDefault();
        if (unlocked) onConfirm();
      }}
    >
      <div className="modal-head">
        <ModalTitle>{title}</ModalTitle>
      </div>
      {body ? <div className="confirm-body" id={bodyId}>{body}</div> : null}
      {needsText ? (
        <label className="field">
          <span>Type <b className="confirm-require-text">{requireText}</b> to confirm</span>
          <input
            ref={inputRef}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={event => setTyped(event.target.value)}
          />
        </label>
      ) : null}
      <div className="modal-actions">
        <button ref={cancelRef} className="modbtn" type="button" onClick={onCancel}>{cancelLabel}</button>
        <button
          ref={confirmRef}
          className={'modbtn ' + (tone === 'danger' ? 'danger' : 'gold')}
          type="submit"
          disabled={!unlocked}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

type PendingConfirm = ConfirmOptions & { id: number; resolve: (ok: boolean) => void };

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = React.createContext<ConfirmFn | null>(null);

let nextConfirmId = 1;

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = React.useState<PendingConfirm[]>([]);
  const queueRef = React.useRef(queue);
  queueRef.current = queue;

  const confirm = React.useCallback<ConfirmFn>(
    options => new Promise<boolean>(resolve => {
      const id = nextConfirmId++;
      setQueue(current => [...current, { ...options, id, resolve }]);
    }),
    [],
  );

  // A page that unmounts with a confirm still open answers it "no", so no caller is
  // left awaiting a promise that can never settle.
  React.useEffect(() => () => {
    for (const pending of queueRef.current) pending.resolve(false);
  }, []);

  const head = queue[0] ?? null;
  const settle = (pending: PendingConfirm, ok: boolean) => {
    pending.resolve(ok);
    setQueue(current => current.filter(item => item.id !== pending.id));
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {head ? (
        <ConfirmDialog
          key={head.id}
          title={head.title}
          body={head.body}
          confirmLabel={head.confirmLabel}
          cancelLabel={head.cancelLabel}
          tone={head.tone}
          requireText={head.requireText}
          onConfirm={() => settle(head, true)}
          onCancel={() => settle(head, false)}
        />
      ) : null}
    </ConfirmContext.Provider>
  );
}

/** Raise the shared confirm dialog. Must be rendered under `ConfirmProvider`. */
export function useConfirm(): ConfirmFn {
  const confirm = React.useContext(ConfirmContext);
  if (!confirm) {
    throw new Error('useConfirm() needs a <ConfirmProvider> above it (see main.tsx).');
  }
  return confirm;
}
